import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobSpec } from '../ci/protocol';
import { StepState } from '../ci/runs';
import { ActionStore, defaultActionCacheDir } from './actions';
import { containerEngine, dockerAvailable, ContainerLimits, DEFAULT_PIDS_LIMIT, removeStaleJobContainers } from './docker';
import { Externals, defaultExternalsDir } from './externals';
import { JobResult, defaultWorkDir, runJob } from './job';
import { startWakeListener } from './wake';

// `mochi runner run`: acquire a job, execute it, report back, repeat. The
// transport is plain HTTP with a long poll, so it works through any proxy
// that passes ordinary requests, and a runner behind NAT needs no inbound
// connectivity at all.

export interface RunnerConfig {
  host: string;
  token: string;
  labels?: string[];
  images?: Record<string, string>;
  workDir?: string;
  network?: string;
  /** What one job's container may take of the machine; see ContainerLimits. */
  limits?: ContainerLimits;
  /** Where `uses:` actions are downloaded from. */
  actionsUrl?: string;
  /** Where downloaded actions and node builds are cached. */
  cacheDir?: string;
  /** Reuse downloaded actions between jobs. Defaults to true. */
  actionCache?: boolean;
  /**
   * Stop after this many seconds with no job, rather than polling forever.
   *
   * This is what makes a runner that costs money while it is up affordable:
   * the process exits 0, the machine it is on stops, and something else starts
   * it again when there is work. A runner that is meant to sit and wait leaves
   * this unset, which is the default.
   */
  idleSeconds?: number;
  /**
   * Answer wake requests on this port, so that whatever stopped this runner
   * can start it again. Only useful together with idleSeconds.
   */
  wakePort?: number;
  /** The secret a wake request must present. Required when wakePort is set. */
  wakeSecret?: string;
}

export const DEFAULT_IMAGES: Record<string, string> = {
  'ubuntu-latest': 'catthehacker/ubuntu:act-latest',
  'ubuntu-24.04': 'catthehacker/ubuntu:act-24.04',
  'ubuntu-22.04': 'catthehacker/ubuntu:act-22.04',
  'self-hosted': 'catthehacker/ubuntu:act-latest',
};

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'mochi', 'runner.json');
}

export function loadRunnerConfig(file = configPath()): RunnerConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RunnerConfig>;
    if (typeof parsed.host !== 'string' || typeof parsed.token !== 'string') return null;
    return parsed as RunnerConfig;
  } catch {
    return null;
  }
}

export function saveRunnerConfig(config: RunnerConfig, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The per-job wire client: logs, heartbeats, progress, and the final report.
// It needs a host and a bearer token and nothing else about its caller, which
// is what lets a manual session (`mochi job run`) drive it with a session
// token exactly as the long-lived runner drives it with a runner token.
export class JobClient {
  private buffer: { s: number; t: string; l: string }[] = [];
  private flushing = false;
  private cancelSeen = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private runner: { host: string; token: string }, private spec: JobSpec) {}

  private base(): string {
    const a = this.spec.address;
    return `${this.runner.host}/api/runner/jobs/${encodeURIComponent(a.collection)}/${encodeURIComponent(
      a.repo
    )}/${a.run}/${encodeURIComponent(a.job)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.runner.token}`,
      'x-mochi-lease': this.spec.lease,
      ...extra,
    };
  }

  log(stepIndex: number, line: string): void {
    this.buffer.push({ s: stepIndex, t: new Date().toISOString(), l: line });
    if (this.buffer.length >= 200) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await fetch(`${this.base()}/logs`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/x-ndjson' }),
        body: batch.map((l) => JSON.stringify(l)).join('\n') + '\n',
      });
    } catch {
      // Losing a log batch must never fail the job; the work matters more
      // than its transcript.
    } finally {
      this.flushing = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
      void this.heartbeat();
    }, 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  cancelled(): boolean {
    return this.cancelSeen;
  }

  private async heartbeat(): Promise<void> {
    try {
      const res = await fetch(`${this.base()}/heartbeat`, { method: 'POST', headers: this.headers() });
      if (res.status === 409) {
        // The server took the job back (lease expired, run cancelled). Stop.
        this.cancelSeen = true;
        return;
      }
      const body = (await res.json()) as { cancel?: boolean };
      if (body.cancel) this.cancelSeen = true;
    } catch {
      // A transient failure is not a cancellation; keep working.
    }
  }

  async progress(steps: StepState[]): Promise<void> {
    await this.flush();
    try {
      await fetch(`${this.base()}/status`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ lease: this.spec.lease, status: 'running', stepStates: steps }),
      });
    } catch {
      // reported again on the next step
    }
  }

  async complete(result: JobResult): Promise<void> {
    await this.flush();
    try {
      await fetch(`${this.base()}/status`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          lease: this.spec.lease,
          status: 'completed',
          conclusion: result.conclusion,
          stepStates: result.steps,
          outputs: result.outputs,
          summaries: result.summaries,
        }),
      });
    } catch (e) {
      // The lease will expire and the server will requeue the job.
      console.error(`  could not report the result: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export class Runner {
  readonly host: string;
  readonly token: string;
  private labels: string[];
  private images: Record<string, string>;
  readonly workDir: string;
  readonly network?: string;
  readonly limits?: ContainerLimits;
  private idleSeconds: number | null;
  private wake: { port: number; secret: string } | null;
  // When this runner last had something to do. A wake request counts, so that
  // a runner started for a job that is a moment behind the request does not
  // time out before the job arrives.
  private idleSince = Date.now();
  private stopping = false;
  // The acquire poll the loop is sitting in, so that stopping can abort it. A
  // runner between jobs is inside a request the server holds open for twenty-five
  // seconds, and a stop that only set the flag above was not acted on until that
  // request answered: Ctrl-C printed "stopping" and then appeared to hang.
  private polling: AbortController | null = null;
  // The registered name, learned from whoami at startup. Only used in
  // messages, but a message from a runner that does not say which runner
  // sent it is of little use on a vault serving more than one.
  private name = '';
  private actions: ActionStore;
  private externals: Externals;

  constructor(config: RunnerConfig) {
    this.host = config.host.replace(/\/+$/, '');
    this.token = config.token;
    this.labels = config.labels ?? [];
    this.images = { ...DEFAULT_IMAGES, ...(config.images ?? {}) };
    this.workDir = config.workDir ?? defaultWorkDir();
    this.network = config.network;
    this.limits = config.limits;
    this.idleSeconds = config.idleSeconds && config.idleSeconds > 0 ? config.idleSeconds : null;
    this.wake = config.wakePort && config.wakeSecret ? { port: config.wakePort, secret: config.wakeSecret } : null;
    const actionCache = config.cacheDir ? path.join(config.cacheDir, 'actions') : defaultActionCacheDir();
    const externalsCache = config.cacheDir ? path.join(config.cacheDir, 'externals') : defaultExternalsDir();
    this.actions = new ActionStore(actionCache, config.actionsUrl, config.actionCache);
    this.externals = new Externals(externalsCache);
  }

  imageFor(labels: string[]): string {
    return imageForLabels(this.images, labels);
  }

  cloneUrl(collection: string, repo: string): string {
    return `${this.host}/${encodeURIComponent(collection)}/${encodeURIComponent(repo)}`;
  }

  async whoami(): Promise<{ name: string; labels: string[]; allow: string[] }> {
    const res = await fetch(`${this.host}/api/runner/whoami`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `the server answered ${res.status}`);
    }
    return (await res.json()) as { name: string; labels: string[]; allow: string[] };
  }

  private async acquire(labels: string[]): Promise<JobSpec | null> {
    const poll = new AbortController();
    this.polling = poll;
    try {
      const res = await fetch(`${this.host}/api/runner/acquire`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ labels }),
        signal: poll.signal,
      });
      if (res.status === 204) return null;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `acquire failed with ${res.status}`);
      }
      return (await res.json()) as JobSpec;
    } catch (e) {
      // An aborted poll is a stop, not a failure: answer it the way an empty
      // poll is answered and let the loop see the flag and end.
      if (this.stopping) return null;
      throw e;
    } finally {
      this.polling = null;
    }
  }

  stop(): void {
    this.stopping = true;
    // Aborting the poll hangs up on the server, which releases any job it was
    // in the middle of leasing to this runner rather than leaving it leased to
    // nobody. Nothing is executing at this point: a runner inside a poll is a
    // runner between jobs.
    this.polling?.abort();
  }

  async loop(): Promise<void> {
    const docker = await dockerAvailable();
    if (!docker) {
      throw new Error(
        `${containerEngine()} is not available. The runner executes every job in a container, so it needs a working \`${containerEngine()}\` command.`
      );
    }
    const identity = await this.whoami();
    const labels = this.labels.length ? this.labels.filter((l) => identity.labels.includes(l)) : identity.labels;
    if (labels.length === 0) {
      throw new Error(
        `none of the requested labels (${this.labels.join(', ')}) are registered for this runner (${identity.labels.join(
          ', '
        )})`
      );
    }
    this.name = identity.name;
    // Whatever a previous life of this runner left running. A container is
    // removed when its job ends, so any found here belong to a job that was
    // under way when the runner last died, and nothing else will ever remove them.
    try {
      const stale = await removeStaleJobContainers();
      if (stale > 0) console.log(`Removed ${stale} job container(s) left behind by an earlier run.`);
    } catch (e) {
      console.log(`Could not look for leftover job containers: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Listening before the banner, because a runner that cannot be woken
    // should say so at the top rather than after claiming to be ready. A
    // failure to bind throws out of here: a runner meant to stop when idle
    // and unable to be started again is worse than one that never started.
    const listener = this.wake
      ? await startWakeListener({
          port: this.wake.port,
          secret: this.wake.secret,
          onWake: () => {
            this.idleSince = Date.now();
          },
        })
      : null;
    console.log(`mochi runner ${identity.name} ready`);
    console.log(`  server:  ${this.host}`);
    console.log(`  engine:  ${containerEngine()} ${docker}`);
    console.log(`  workdir: ${this.workDir}`);
    console.log(`  labels:  ${labels.join(', ')}`);
    console.log(`  serving: ${identity.allow.join(', ')}`);
    const limits = [
      `pids ${this.limits?.pids ?? DEFAULT_PIDS_LIMIT}`,
      this.limits?.memory ? `memory ${this.limits.memory}` : null,
      this.limits?.cpus ? `cpus ${this.limits.cpus}` : null,
    ].filter((l) => l !== null);
    console.log(`  limits:  ${limits.join(', ')} per job`);
    if (this.idleSeconds !== null) console.log(`  idle:    stopping after ${this.idleSeconds}s with no job`);
    if (listener) console.log(`  wake:    listening on port ${listener.port}`);
    console.log('Waiting for jobs.');

    let backoff = 1000;
    // Idle is measured from the end of the last job, not from the last poll:
    // a runner between jobs polls every twenty-five seconds forever, so a
    // timer reset by polling would never fire.
    this.idleSince = Date.now();
    try {
      while (!this.stopping) {
        let spec: JobSpec | null = null;
        try {
          spec = await this.acquire(labels);
          backoff = 1000;
        } catch (e) {
          console.error(`  ${e instanceof Error ? e.message : e}; retrying in ${Math.round(backoff / 1000)}s`);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 60000);
          continue;
        }
        if (!spec) {
          if (this.idleSeconds !== null && Date.now() - this.idleSince >= this.idleSeconds * 1000) {
            console.log(`No job for ${this.idleSeconds}s; stopping.`);
            return;
          }
          continue;
        }
        await this.execute(spec);
        this.idleSince = Date.now();
      }
    } finally {
      // Closed before this returns, and so before the process exits, which
      // settles the race between stopping and being woken: a wake request
      // that arrives after the decision to stop finds nothing listening and
      // fails, and a failed wake is retried against a runner that by then has
      // stopped and can be started again. Answering it and exiting anyway
      // would leave the sender believing the runner was up.
      await listener?.close();
    }
  }

  private async execute(spec: JobSpec): Promise<void> {
    await executeSpec(spec, {
      host: this.host,
      token: this.token,
      runnerName: this.name || 'this runner',
      imageFor: (labels) => this.imageFor(labels),
      workDir: this.workDir,
      network: this.network,
      actions: this.actions,
      externals: this.externals,
    });
  }
}

export interface ExecuteDeps {
  host: string;
  token: string;
  /** What the log calls this executor when the failure is its own. */
  runnerName: string;
  imageFor: (labels: string[]) => string;
  workDir: string;
  network?: string;
  actions: ActionStore;
  externals: Externals;
}

/**
 * Take one leased job through execution and reporting. Shared between the
 * long-lived runner and a manual session, which differ in how they came by
 * the lease and in nothing that happens after.
 */
export async function executeSpec(spec: JobSpec, deps: ExecuteDeps): Promise<JobResult> {
  const label = `${spec.address.collection}/${spec.address.repo} #${spec.runNumber} ${spec.name}`;
  console.log(`> ${label}`);
  const client = new JobClient({ host: deps.host, token: deps.token }, spec);
  client.start();
  deps.actions.beginJob();
  const started = Date.now();
  let result: JobResult;
  try {
    result = await runJob(
      spec,
      {
        imageFor: deps.imageFor,
        cloneUrl: (c, r) => `${deps.host}/${encodeURIComponent(c)}/${encodeURIComponent(r)}`,
        workDir: deps.workDir,
        network: deps.network,
        actions: deps.actions,
        externals: deps.externals,
        serverUrl: deps.host,
        runnerToken: deps.token,
      },
      {
        log: (i, line) => client.log(i, line),
        progress: (steps) => void client.progress(steps),
        cancelled: () => client.cancelled(),
      }
    );
  } catch (e) {
    // A failure here is the runner's own, not the workflow's, and the log
    // is read on the vault by someone who cannot see this machine: say
    // which runner it was and where it was working, so that the reader
    // knows whose filesystem the message is about.
    const where = `${deps.runnerName} on ${os.hostname()}, work dir ${deps.workDir}`;
    client.log(-1, `runner error (${where}): ${e instanceof Error ? e.message : String(e)}`);
    result = { conclusion: 'failure', steps: [], outputs: {}, summaries: [] };
  }
  await client.complete(result);
  client.stop();
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`< ${label}: ${result.conclusion} in ${secs}s`);
  return result;
}

/** The image a set of runs-on labels selects, given the label→image map. */
export function imageForLabels(images: Record<string, string>, labels: string[]): string {
  for (const l of labels) {
    if (images[l]) return images[l];
  }
  // An unmapped label is taken as an image name when it looks like one,
  // which makes `runs-on: node:24` work without configuration.
  const looksLikeImage = labels.find((l) => l.includes('/') || l.includes(':'));
  return looksLikeImage ?? images['ubuntu-latest'];
}
