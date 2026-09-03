import { api, remoteTarget } from './cli-api';
import { JSON_OPTION, jsonMode, pickFields, printJson, printTable } from './cli/output';
import { Command } from './cli/parse';
import { TARGET_OPTIONS, targetFrom } from './cli/target';
import { loadLogin } from './credentials';
import { chooseEngine } from './job-cli';
import { DEFAULT_IMAGES, Runner, RunnerConfig, configPath, loadRunnerConfig, saveRunnerConfig } from './runner/client';
import { setContainerEngine } from './runner/docker';
import { newWakeSecret } from './ci/wake';
import { globMatch } from './vault';

// The `mochi runner ...` subcommands. Registration talks to the server with
// an admin token, exactly like `mochi user add`; running needs only the
// runner's own token and a working Docker.

interface RunnerArgs {
  name: string | null;
  host: string | null;
  token: string | null;
  runnerToken: string | null;
  labels: string[];
  allow: string[];
  images: Record<string, string>;
  workDir: string | null;
  network: string | null;
  jobMemory: string | null;
  jobCpus: string | null;
  jobPids: number | null;
  cacheDir: string | null;
  actionsUrl: string | null;
  actionCache: boolean;
  save: boolean;
  idleSeconds: number | null;
  wakePort: number | null;
  wakeSecret: string | null;
  wakeUrl: string | null;
  clear: boolean;
  jobTimeout: number | null | 'default';
  engine: 'docker' | 'podman' | null;
}

/**
 * "5m", "30s", "300" -> seconds.
 *
 * Written out because the one place this is used is a timeout an operator
 * chooses in minutes and a program wants in seconds, and "--idle 300" for
 * five minutes is a needless piece of arithmetic to ask of a reader.
 */
function parseDuration(text: string): number {
  const m = /^(\d+)\s*(s|m|h)?$/i.exec(text.trim());
  if (!m) {
    console.error(`--idle takes a duration like 5m, 90s, or 1h, got: ${text}`);
    process.exit(1);
  }
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 's').toLowerCase();
  return unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
}

/**
 * "20", "45m", "2h" -> minutes, for the job timeout.
 *
 * Separate from parseDuration above, and in a different unit, because a bare
 * number means different things in the two places: seconds is the natural
 * reading of --idle and the wrong reading of a job timeout, which an operator
 * states in minutes.
 */
function parseTimeoutMinutes(text: string): number {
  const m = /^(\d+)\s*(m|h)?$/i.exec(text.trim());
  if (!m) {
    console.error(`--job-timeout takes minutes, or a duration like 45m or 2h, got: ${text}`);
    process.exit(1);
  }
  const n = parseInt(m[1], 10);
  return (m[2] ?? 'm').toLowerCase() === 'h' ? n * 60 : n;
}

function parseArgs(args: string[], usage: () => never): RunnerArgs {
  const out: RunnerArgs = {
    name: null,
    host: null,
    token: null,
    runnerToken: null,
    labels: [],
    allow: [],
    images: {},
    workDir: null,
    network: null,
    jobMemory: null,
    jobCpus: null,
    jobPids: null,
    cacheDir: null,
    actionsUrl: null,
    actionCache: true,
    save: false,
    idleSeconds: null,
    wakePort: null,
    wakeSecret: null,
    wakeUrl: null,
    clear: false,
    jobTimeout: null,
    engine: null,
  };
  const list = (v: string): string[] => v.split(/[\s,]+/).filter((s) => s.length > 0);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--host') out.host = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '--runner-token') out.runnerToken = args[++i];
    else if (a === '--labels' || a === '--label') out.labels.push(...list(args[++i] ?? ''));
    else if (a === '--allow') out.allow.push(...list(args[++i] ?? ''));
    else if (a === '--work-dir') out.workDir = args[++i];
    else if (a === '--cache-dir') out.cacheDir = args[++i];
    else if (a === '--actions-url') out.actionsUrl = args[++i];
    else if (a === '--no-action-cache') out.actionCache = false;
    else if (a === '--network') out.network = args[++i];
    else if (a === '--job-memory' || a === '--job-cpus') {
      // Passed through to the engine as written, which is the authority on
      // what "2g" or "1.5" means; only an empty value is refused here.
      const v = (args[++i] ?? '').trim();
      if (!/^[0-9][0-9.]*[bkmgBKMG]?$/.test(v)) {
        console.error(`${a} takes a number, as docker run does (${a === '--job-memory' ? '2g, 512m' : '2, 0.5'}), got: ${v}`);
        process.exit(1);
      }
      if (a === '--job-memory') out.jobMemory = v;
      else out.jobCpus = v;
    } else if (a === '--job-pids') {
      const n = parseInt(args[++i] ?? '', 10);
      if (!Number.isInteger(n) || n < 0) {
        console.error('--job-pids takes a number of processes, or 0 for no limit');
        process.exit(1);
      }
      out.jobPids = n;
    }
    else if (a === '--idle') out.idleSeconds = parseDuration(args[++i] ?? '');
    else if (a === '--wake-port') {
      const port = parseInt(args[++i] ?? '', 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error('--wake-port takes a port number, e.g. --wake-port 3000');
        process.exit(1);
      }
      out.wakePort = port;
    } else if (a === '--wake-secret') out.wakeSecret = args[++i];
    else if (a === '--wake-url') out.wakeUrl = args[++i];
    else if (a === '--clear') out.clear = true;
    else if (a === '--job-timeout') {
      // Empty (or the word 'default') puts the runner back on the vault's
      // default, which is a real answer and not a missing one; anything else
      // is minutes, or a duration for an operator who thinks in hours.
      const raw = (args[++i] ?? '').trim();
      out.jobTimeout = raw === '' || raw === 'default' ? 'default' : parseTimeoutMinutes(raw);
    }
    else if (a === '--save') out.save = true;
    else if (a === '--engine') {
      const e = args[++i] ?? '';
      if (e !== 'docker' && e !== 'podman') {
        console.error(`--engine takes docker or podman, got: ${e}`);
        process.exit(1);
      }
      out.engine = e;
    }
    else if (a === '--image') {
      // --image ubuntu-latest=my/image:tag
      const spec = args[++i] ?? '';
      const eq = spec.indexOf('=');
      if (eq === -1) {
        console.error(`--image needs <label>=<image>, got: ${spec}`);
        process.exit(1);
      }
      out.images[spec.slice(0, eq)] = spec.slice(eq + 1);
    } else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else if (!out.name) out.name = a;
    else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

// Registration is an ordinary admin operation, so it uses the same login as
// `mochi user add` rather than any arrangement of its own.

export async function runnerAddCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.name) {
    console.error('A runner name is required: mochi runner add <name> --allow <glob>');
    process.exit(1);
  }
  if (a.allow.length === 0) {
    console.error(
      'Say which repositories this runner may take jobs for: --allow "mycollection/*".\n' +
        'A runner executes whatever those repositories\' workflows contain, on the machine you start it on.'
    );
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const labels = a.labels.length ? a.labels : ['ubuntu-latest'];
  // A wake address is optional, and its secret is generated here when one is
  // not supplied: it is a credential nobody has to remember, since the vault
  // sends it and the runner is given it as an environment variable.
  const wake = a.wakeUrl ? { url: a.wakeUrl, secret: a.wakeSecret ?? newWakeSecret() } : null;
  const data = await api(target, 'POST', '/api/runners', {
    name: a.name,
    labels,
    allow: a.allow,
    ...(typeof a.jobTimeout === 'number' ? { jobTimeoutMinutes: a.jobTimeout } : {}),
    ...(wake ? { wakeUrl: wake.url, wakeSecret: wake.secret } : {}),
  });
  console.log(`Registered runner ${data.name}`);
  console.log(`  labels:  ${(data.labels as string[]).join(', ')}`);
  console.log(`  serving: ${(data.allow as string[]).join(', ')}`);
  // A vault older than the setting reports no timeout, and saying nothing is
  // better than reporting a default this CLI only assumes it has.
  if (data.jobTimeout !== undefined) console.log(`  timeout: ${String(data.jobTimeout)} minutes per job`);
  if (wake) console.log(`  wake:    ${wake.url}`);
  console.log('');
  console.log('Runner token (shown once; only its hash is stored):');
  console.log('');
  console.log(`  ${data.token}`);
  console.log('');
  if (a.save) {
    const config: RunnerConfig = { host: target.host, token: data.token as string, labels };
    if (a.workDir) config.workDir = a.workDir;
    if (a.network) config.network = a.network;
    if (Object.keys(a.images).length) config.images = a.images;
    saveRunnerConfig(config);
    console.log(`Saved to ${configPath()}. Start it with:`);
    console.log('');
    console.log('  mochi runner run');
  } else {
    console.log('On the machine that will run jobs (with Docker installed):');
    console.log('');
    console.log(`  mochi runner run --host ${target.host} --runner-token ${data.token}`);
  }
  if (wake) {
    console.log('');
    console.log('This runner has a wake address, so the vault will start it when a job is');
    console.log('waiting and nothing is polling. Start it with the matching secret, and with an');
    console.log('idle timeout, or there will be nothing to wake:');
    console.log('');
    console.log(`  MOCHI_WAKE_SECRET=${wake.secret} \\`);
    console.log(`    mochi runner run --idle 5m --wake-port 3000`);
  }
  console.log('');
}

/**
 * `mochi runner edit <name> --job-timeout <d>`: change what a registered runner
 * is allowed to do, which for now is how long a job may run on it.
 *
 * Its labels and allow list are deliberately not here: both decide which jobs
 * a machine may take, and changing them under a runner that is already trusted
 * with a set of repositories is a re-registration rather than an edit.
 */
export async function runnerEditCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.name) {
    console.error('Which runner? Usage: mochi runner edit <name> --job-timeout <minutes>');
    process.exit(1);
  }
  if (a.jobTimeout === null) {
    console.error("Nothing to change. Pass --job-timeout <minutes>, or --job-timeout '' for the default.");
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const data = await api(target, 'PATCH', `/api/runners/${encodeURIComponent(a.name)}`, {
    jobTimeoutMinutes: a.jobTimeout === 'default' ? null : a.jobTimeout,
  });
  const minutes = Number(data.jobTimeout);
  console.log(
    data.jobTimeoutMinutes === null
      ? `Runner ${a.name} is back on the vault's default job timeout of ${minutes} minutes.`
      : `Jobs on ${a.name} now stop after ${minutes} minute${minutes === 1 ? '' : 's'}.`
  );
  console.log('Applies to the next job it takes; one already running keeps the timeout it started with.');
}

/**
 * `mochi runner wake <name>`: send the wake request, or change where it goes.
 *
 * Sending it is the useful default, because the question an operator has is
 * almost always "does this actually start" rather than "what is stored". The
 * vault does the sending, since the vault is the only party holding the
 * secret; what comes back is how long it took to answer, which on a machine
 * that has to boot is the number worth knowing.
 */
export async function runnerWakeCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.name) {
    console.error('Which runner? Usage: mochi runner wake <name> [--url <url>] [--clear]');
    process.exit(1);
  }
  if (a.clear && a.wakeUrl) {
    console.error('--clear removes the wake address and --url sets one. Pass one or the other.');
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const path = `/api/runners/${encodeURIComponent(a.name)}/wake`;
  if (a.clear) {
    await api(target, 'PUT', path, {});
    console.log(`Runner ${a.name} has no wake address now, so nothing will start it.`);
    return;
  }
  if (a.wakeUrl) {
    const secret = a.wakeSecret ?? newWakeSecret();
    await api(target, 'PUT', path, { wakeUrl: a.wakeUrl, wakeSecret: secret });
    console.log(`Runner ${a.name} will be woken at ${a.wakeUrl}`);
    if (!a.wakeSecret) {
      console.log('');
      console.log('The secret it must present, generated now and shown once here because the');
      console.log('runner has to be started with the same one:');
      console.log('');
      console.log(`  ${secret}`);
      console.log('');
      console.log('  MOCHI_WAKE_SECRET=<that> mochi runner run --idle 5m --wake-port 3000');
    }
    return;
  }
  const data = await api(target, 'POST', path, {});
  console.log(`Woke ${a.name} at ${String(data.wakeUrl)} in ${String(data.seconds)}s.`);
}

interface RunnerRow extends Record<string, unknown> {
  name: string;
  labels: string[];
  allow: string[];
  createdBy: string;
  createdAt: string;
  // The timeout in force, absent from a vault older than the setting.
  jobTimeout?: number;
  lastSeen?: string | null;
  running: { collection: string; repo: string; run: number; job: string } | null;
  wakeUrl?: string | null;
}

interface QueuedJob {
  collection: string;
  repo: string;
  run: number;
  job: string;
  runsOn: string[];
  // Waiting for a pasted command, not for a runner; absent from older vaults.
  manual?: boolean;
}

/** "3s ago", for the one column where a bare ISO timestamp would be unreadable. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function jobLabel(j: { collection: string; repo: string; run: number; job: string }): string {
  return `${j.collection}/${j.repo} #${j.run} ${j.job}`;
}

/**
 * A queued job that no registered runner can take: its labels match nobody, or
 * nobody's allow list covers its repository. This is the answer to "the run
 * never started" that neither the run nor the registry gives on its own, so it
 * is worth computing here rather than leaving to the reader.
 */
function unservedJobs(queued: QueuedJob[], runners: RunnerRow[]): QueuedJob[] {
  return queued.filter(
    (j) =>
      // A manual job is waiting for a pasted command by design, so no runner
      // failing to match it is not the problem this list exists to surface.
      !j.manual &&
      !runners.some(
        (r) =>
          r.allow.some((g) => globMatch(g, `${j.collection}/${j.repo}`)) &&
          j.runsOn.some((l) => r.labels.includes(l))
      )
  );
}

export const runnerListCommand: Command = {
  path: ['runner', 'list'],
  summary: 'Show registered runners, whether each is connected, and what is queued',
  description: `Needs an admin token, as the other runner registration commands do.

Beside the registry it reports liveness: when each runner last spoke to the vault
(since the vault started; a restart forgets it and every live runner re-announces
within one poll), the job it is holding now, and the jobs waiting for a runner. A
queued job that no runner's labels and allow globs match is called out, since that
is the usual reason a run sits at queued forever.`,
  options: [JSON_OPTION, ...TARGET_OPTIONS],
  async run(inv) {
    const target = await targetFrom(inv);
    const data = await api(target, 'GET', '/api/runners');
    const runners = (data.runners ?? []) as RunnerRow[];
    const queued = (data.queued ?? []) as QueuedJob[];
    const json = jsonMode(inv);
    if (json.enabled) {
      printJson({ runners: pickFields(runners, json.fields), queued });
      return;
    }
    if (runners.length === 0) {
      console.log('No runners registered. Runs will queue and wait: mochi runner add <name> --allow <glob>');
    } else {
      printTable(
        runners.map((r) => [
          r.name,
          `labels: ${r.labels.join(', ') || '(none)'}`,
          `serving: ${r.allow.join(', ') || '(none)'}`,
          r.jobTimeout === undefined ? '' : `timeout: ${r.jobTimeout}m`,
          // A vault older than liveness reporting leaves both out, and saying
          // "seen never" of a runner that may be perfectly healthy would be
          // worse than saying nothing.
          r.lastSeen === undefined && !r.running
            ? r.createdBy
              ? `by ${r.createdBy}`
              : ''
            : r.running
              ? `running ${jobLabel(r.running)}`
              : // A runner with a wake address is meant to be absent between
                // jobs, so reporting it as idle since an hour ago without that
                // context reads as a fault rather than as the arrangement
                // working.
                `idle, seen ${ago(r.lastSeen ?? null)}${r.wakeUrl ? ', woken on demand' : ''}`,
        ])
      );
    }
    if (queued.length > 0) {
      const automatic = queued.filter((j) => !j.manual);
      const manual = queued.filter((j) => j.manual);
      console.log('');
      if (automatic.length > 0) {
        console.log(`${automatic.length} job${automatic.length === 1 ? '' : 's'} waiting for a runner:`);
        for (const j of automatic) console.log(`  ${jobLabel(j)}  (runs-on: ${j.runsOn.join(', ')})`);
      }
      if (manual.length > 0) {
        console.log(
          `${manual.length} manual job${manual.length === 1 ? '' : 's'} waiting for a pasted command (mochi run exec-command <run>):`
        );
        for (const j of manual) console.log(`  ${jobLabel(j)}  (runs-on: ${j.runsOn.join(', ')})`);
      }
      const unserved = unservedJobs(queued, runners);
      if (unserved.length > 0) {
        console.log('');
        console.log(
          `No registered runner can take ${
            unserved.length === automatic.length ? 'them' : `${unserved.length} of them`
          }: check the runs-on labels against each runner's labels, and the repository against its serving globs.`
        );
      }
    }
  },
};

export async function runnerRemoveCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.name) {
    console.error('A runner name is required: mochi runner remove <name>');
    process.exit(1);
  }
  const target = await remoteTarget(a);
  await api(target, 'DELETE', `/api/runners/${encodeURIComponent(a.name)}`);
  console.log(`Removed runner ${a.name}`);
}

export async function runnerRunCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  const saved = loadRunnerConfig();
  // A runner's token is its own, not a user's, so it is not something login
  // stored; only the vault URL can be borrowed from a login on this machine.
  const host = (a.host ?? saved?.host ?? loadLogin()?.host ?? '').replace(/\/+$/, '');
  const token = a.runnerToken ?? process.env.MOCHI_RUNNER_TOKEN ?? saved?.token ?? '';
  if (!host || !token) {
    console.error(
      `No runner credentials. Register one with:\n\n` +
        `  mochi runner add <name> --allow 'mycollection/*' --save\n\n` +
        `or pass --host and --runner-token, or write ${configPath()}.`
    );
    process.exit(1);
  }
  const config: RunnerConfig = {
    host,
    token,
    labels: a.labels.length ? a.labels : saved?.labels,
    images: { ...DEFAULT_IMAGES, ...(saved?.images ?? {}), ...a.images },
    workDir: a.workDir ?? saved?.workDir,
    network: a.network ?? saved?.network,
    limits: {
      memory: a.jobMemory ?? saved?.limits?.memory,
      cpus: a.jobCpus ?? saved?.limits?.cpus,
      pids: a.jobPids ?? saved?.limits?.pids,
    },
    cacheDir: a.cacheDir ?? saved?.cacheDir,
    actionsUrl: a.actionsUrl ?? saved?.actionsUrl,
    actionCache: a.actionCache && (saved?.actionCache ?? true),
    idleSeconds: a.idleSeconds ?? saved?.idleSeconds,
    wakePort: a.wakePort ?? saved?.wakePort,
    // From the environment by preference, like the runner token above: this is
    // the credential a wake request must present, and a secret in argv is
    // readable by every other user on the machine.
    wakeSecret: a.wakeSecret ?? process.env.MOCHI_WAKE_SECRET ?? saved?.wakeSecret,
  };
  if (config.wakePort && !config.wakeSecret) {
    console.error(
      'A wake port needs a secret to check against: pass --wake-secret, or set MOCHI_WAKE_SECRET.\n' +
        'Without one, anything that can reach this port could start this runner.'
    );
    process.exit(1);
  }
  if (config.idleSeconds && !config.wakePort) {
    // Not an error: a runner started by cron, or by hand for one run, is meant
    // to stop and stay stopped. But the usual reason to pass --idle is the
    // other arrangement, and a runner that stops with nothing able to start it
    // looks exactly like a runner that has failed.
    console.log('Note: this runner will stop when idle, and has no wake port, so nothing can start it.');
    console.log('      Add --wake-port to let the vault do it: mochi runner wake --help');
  }
  if (a.save) {
    saveRunnerConfig(config);
    console.log(`Saved to ${configPath()}`);
  }
  // Which container engine carries the jobs: the flag if given, whichever of
  // docker and podman works if only one does, a question when both do and
  // there is a terminal to ask on, docker otherwise. Chosen before the runner
  // starts, because a runner must use one engine for everything or nothing.
  const engine = await chooseEngine(a.engine, process.stdin.isTTY === true && process.stdout.isTTY === true);
  setContainerEngine(engine);
  const runner = new Runner(config);
  const stop = () => {
    console.log('\nStopping after the current job. Press Ctrl-C again to quit now.');
    runner.stop();
    process.once('SIGINT', () => process.exit(130));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runner.loop();
}
