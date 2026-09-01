import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { GitRepo, execGit } from '../git';
import { mintJobToken } from '../jobtoken';
import { repoIsPrivate } from '../perms';
import { findRepo, listCollections, listRepoDirs } from '../scan';
import { globMatch } from '../vault';
import { ExprEnv, ExprValue, evalCondition, render } from './expr';
import {
  ManualGrant,
  findMintable,
  findSession,
  isManualJob,
  isManualRunnerName,
  loadGrants,
  mintGrant,
  redeemGrant,
  sessionRunnerName,
} from './manual';
import { JobSpec } from './protocol';
import {
  Conclusion,
  JobRecord,
  RunRecord,
  StepState,
  appendJobLog,
  createRun,
  jobLogPath,
  listRuns,
  pruneRuns,
  readJob,
  readRun,
  runsDir,
  writeJob,
  writeRun,
} from './runs';
import {
  DispatchInput,
  Triggers,
  Workflow,
  WorkflowError,
  WorkflowJob,
  parseWorkflow,
  pushMatches,
} from './workflow';

// The CI engine: the server side of workflow execution. It turns pushes and
// manual dispatches into planned runs, decides which jobs are runnable,
// leases them to runners, and folds their reports back into run state. It
// never executes anything itself: execution belongs to `mochi runner run`
// on a machine with Docker.
//
// The engine keeps an in-memory index of active (queued or running) runs,
// rebuilt from the vault at startup; the files under <repo>.runs/ remain the
// durable state, as everything else in a vault.

const ZERO_SHA = /^0+$/;
const MAX_WORKFLOW_SIZE = 512 * 1024;
const LEASE_MS = 90 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_LOG_BYTES = 32 * 1024 * 1024;

export interface PushEvent {
  ref: string; // refs/heads/x or refs/tags/x
  before: string;
  after: string;
  actor: string;
}

export interface DiscoveredWorkflow {
  path: string; // path inside the repository
  source: string;
  workflow?: Workflow;
  error?: string;
}

interface ActiveRun {
  collection: string;
  repo: string;
  run: RunRecord;
  jobs: Map<string, JobRecord>;
}

function runKey(collection: string, repo: string, n: number): string {
  return `${collection}/${repo}#${n}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// A job lease is a bearer token like any other, so it is compared the way
// runner tokens are in runners.ts rather than with `!==`.
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- workflow discovery ----

// Workflows live in .mochi/workflows and .github/workflows; both are
// collected, and a file in .mochi/workflows shadows one with the same
// basename in .github/workflows, so a repository can adapt a single workflow
// for mochi without forking the rest.
export async function discoverWorkflows(repo: GitRepo, sha: string): Promise<DiscoveredWorkflow[]> {
  const dirs = ['.github/workflows', '.mochi/workflows'];
  const byBase = new Map<string, { path: string }>();
  for (const dir of dirs) {
    let entries;
    try {
      entries = await repo.listTree(sha, dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.type !== 'blob') continue;
      if (!/\.(yml|yaml)$/i.test(e.name)) continue;
      byBase.set(e.name, { path: `${dir}/${e.name}` });
    }
  }
  const out: DiscoveredWorkflow[] = [];
  for (const [, { path: p }] of [...byBase.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let source: string;
    try {
      const buf = await repo.catBlob(sha, p);
      if (buf.length > MAX_WORKFLOW_SIZE) {
        out.push({ path: p, source: '', error: 'workflow file is too large' });
        continue;
      }
      source = buf.toString('utf8');
    } catch {
      continue;
    }
    try {
      out.push({ path: p, source, workflow: parseWorkflow(source) });
    } catch (e) {
      out.push({ path: p, source, error: e instanceof WorkflowError ? e.message : String(e) });
    }
  }
  return out;
}

// ---- matrix expansion ----

type Combo = Record<string, ExprValue>;

function comboMatchesFilter(combo: Combo, filter: Record<string, unknown>, keys: string[]): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (!keys.includes(k)) return true;
    return JSON.stringify(combo[k]) === JSON.stringify(v);
  });
}

export function expandMatrix(matrix: unknown): Combo[] | null {
  if (matrix === undefined || matrix === null) return null;
  if (typeof matrix !== 'object' || Array.isArray(matrix)) {
    throw new WorkflowError('strategy.matrix must be a map');
  }
  const m = matrix as Record<string, unknown>;
  const include = Array.isArray(m.include) ? (m.include as Record<string, unknown>[]) : [];
  const exclude = Array.isArray(m.exclude) ? (m.exclude as Record<string, unknown>[]) : [];
  const baseKeys = Object.keys(m).filter((k) => k !== 'include' && k !== 'exclude');
  let combos: Combo[] = [{}];
  for (const k of baseKeys) {
    const values = m[k];
    if (!Array.isArray(values)) throw new WorkflowError(`matrix key ${k} must be a list`);
    const next: Combo[] = [];
    for (const c of combos) for (const v of values) next.push({ ...c, [k]: v as ExprValue });
    combos = next;
  }
  if (baseKeys.length === 0) combos = [];
  for (const ex of exclude) {
    combos = combos.filter((c) => !comboMatchesFilter(c, ex, baseKeys));
  }
  for (const inc of include) {
    // An include entry extends every combination it does not conflict with on
    // an original matrix key; if it extends none, it becomes a new one.
    let extended = false;
    for (const c of combos) {
      const conflicts = baseKeys.some(
        (k) => k in inc && k in c && JSON.stringify(c[k]) !== JSON.stringify(inc[k])
      );
      if (!conflicts) {
        for (const [k, v] of Object.entries(inc)) {
          if (!(k in c) || !baseKeys.includes(k)) c[k] = v as ExprValue;
        }
        extended = true;
      }
    }
    if (!extended) combos.push({ ...(inc as Combo) });
  }
  if (combos.length === 0) throw new WorkflowError('matrix expanded to zero combinations');
  return combos;
}

// ---- the engine ----

export interface CiRetention {
  runs: number;
  days: number;
  /** Largest artifact a job may upload, in megabytes. */
  artifactMb: number;
}

export class CiEngine {
  private active = new Map<string, ActiveRun>();
  private emitter = new EventEmitter();
  private retention: () => CiRetention;

  // Retention arrives as a getter rather than a value so that an edit to
  // config.json takes effect without a restart, and required rather than
  // optional so that the vault's defaults in config.ts are the only answer to
  // what the limits are. A fallback here would be a second answer, free to
  // drift from the first, which is what it had done.
  constructor(private root: string, retention: () => CiRetention) {
    this.retention = retention;
    this.emitter.setMaxListeners(100);
    this.loadActiveRuns();
    const t = setInterval(() => this.sweepLeases(), 30 * 1000);
    t.unref();
  }

  private loadActiveRuns(): void {
    for (const { name: collection } of listCollections(this.root)) {
      for (const repoDir of listRepoDirs(this.root, collection)) {
        const repoName = repoDir.replace(/\.git$/, '');
        const base = runsDir(this.root, collection, repoName);
        if (!base || !fs.existsSync(base)) continue;
        for (const run of listRuns(this.root, collection, repoName)) {
          if (run.status === 'completed') continue;
          this.adopt(collection, repoName, run);
        }
      }
    }
    const n = this.active.size;
    if (n > 0) console.log(`CI: resumed ${n} active run${n === 1 ? '' : 's'}`);
  }

  private adopt(collection: string, repo: string, run: RunRecord): ActiveRun {
    const jobs = new Map<string, JobRecord>();
    for (const id of run.jobs) {
      const j = readJob(this.root, collection, repo, run.number, id);
      if (j) jobs.set(id, j);
    }
    const ar: ActiveRun = { collection, repo, run, jobs };
    this.active.set(runKey(collection, repo, run.number), ar);
    return ar;
  }

  private saveJob(ar: ActiveRun, job: JobRecord): void {
    writeJob(this.root, ar.collection, ar.repo, ar.run.number, job);
  }

  private saveRun(ar: ActiveRun): void {
    writeRun(this.root, ar.collection, ar.repo, ar.run);
  }

  private wake(): void {
    this.emitter.emit('wake');
  }

  /**
   * Call `fn` whenever the set of runnable jobs may have grown.
   *
   * This is the same signal a waiting runner is woken by, offered to a caller
   * that is not a runner: the dispatcher which starts runners that are not
   * connected needs to hear about a job the moment it is queued, and polling
   * for that would be a poor substitute for an event the engine already
   * emits. Returns the way to stop listening.
   */
  onQueueChanged(fn: () => void): () => void {
    this.emitter.on('wake', fn);
    return () => this.emitter.removeListener('wake', fn);
  }

  // ---- event intake ----

  async handlePush(repo: GitRepo, ev: PushEvent): Promise<void> {
    if (ZERO_SHA.test(ev.after)) return; // ref deletion
    const discovered = await discoverWorkflows(repo, ev.after);
    if (discovered.length === 0) return;

    // Changed paths for paths: filters; null for a brand-new ref, in which
    // case a paths filter counts as matched, as on GitHub.
    let changedPaths: string[] | null = null;
    const needsPaths = discovered.some(
      (d) => d.workflow?.on.push && (d.workflow.on.push.paths || d.workflow.on.push.pathsIgnore)
    );
    if (needsPaths && !ZERO_SHA.test(ev.before)) {
      try {
        const out = (
          await execGit(repo.dir, ['diff', '--name-only', `${ev.before}..${ev.after}`])
        ).toString('utf8');
        changedPaths = out.split('\n').filter((l) => l.length > 0);
      } catch {
        changedPaths = null;
      }
    }

    const payload = await this.pushPayload(repo, ev);
    for (const d of discovered) {
      if (d.error) {
        // Only surface a broken workflow file when it plausibly would have
        // run: on a push, that is any push (we cannot know its filters).
        this.createErrorRun(repo, d.path, 'push', ev, payload, d.error);
        continue;
      }
      const wf = d.workflow!;
      if (!wf.on.push) continue;
      if (!pushMatches(wf.on.push, ev.ref, changedPaths)) continue;
      this.planRun(repo, d.path, wf, {
        event: 'push',
        ref: ev.ref,
        sha: ev.after,
        actor: ev.actor,
        payload,
        inputs: undefined,
      });
    }
  }

  async handleDispatch(
    repo: GitRepo,
    workflowPath: string,
    ref: string,
    sha: string,
    actor: string,
    inputs: Record<string, unknown>
  ): Promise<RunRecord> {
    const discovered = await discoverWorkflows(repo, sha);
    const d = discovered.find((x) => x.path === workflowPath);
    if (!d) throw new WorkflowError(`no workflow at ${workflowPath} on this ref`);
    const payload = {
      ref,
      inputs,
      repository: await this.repositoryPayload(repo),
      sender: { login: actor },
    };
    if (d.error) {
      return this.createErrorRun(repo, d.path, 'workflow_dispatch', { ref, actor, sha }, payload, d.error);
    }
    const wf = d.workflow!;
    if (!wf.on.workflowDispatch) {
      throw new WorkflowError('this workflow has no workflow_dispatch trigger');
    }
    return this.planRun(repo, d.path, wf, {
      event: 'workflow_dispatch',
      ref,
      sha,
      actor,
      payload,
      inputs,
    });
  }

  private async repositoryPayload(repo: GitRepo): Promise<Record<string, unknown>> {
    const branches = await repo.listRefs('heads');
    const def = await repo.defaultBranch(branches);
    return {
      name: repo.name,
      full_name: `${repo.collection}/${repo.name}`,
      owner: { name: repo.collection, login: repo.collection },
      default_branch: def ?? 'main',
      private: repoIsPrivate(repo.dir),
    };
  }

  private async pushPayload(repo: GitRepo, ev: PushEvent): Promise<Record<string, unknown>> {
    const head = await repo.commit(ev.after);
    return {
      ref: ev.ref,
      before: ev.before,
      after: ev.after,
      repository: await this.repositoryPayload(repo),
      pusher: { name: ev.actor },
      head_commit: head
        ? {
            id: head.sha,
            message: head.message,
            timestamp: head.date,
            author: { name: head.author, email: head.email },
          }
        : null,
    };
  }

  // ---- planning ----

  private createErrorRun(
    repo: GitRepo,
    workflowPath: string,
    event: string,
    ev: { ref: string; actor: string; sha?: string; after?: string },
    payload: unknown,
    error: string
  ): RunRecord {
    const sha = ev.sha ?? ev.after ?? '';
    const run = createRun(this.root, repo.collection, repo.name, (n) => ({
      run: {
        number: n,
        workflowPath,
        workflowName: path.basename(workflowPath),
        event,
        ref: ev.ref,
        refName: ev.ref.replace(/^refs\/(heads|tags)\//, ''),
        sha,
        actor: ev.actor,
        message: '',
        payload,
        status: 'completed',
        conclusion: 'failure',
        error,
        createdAt: nowIso(),
        completedAt: nowIso(),
        jobs: [],
      },
      jobs: [],
    }));
    pruneRuns(this.root, repo.collection, repo.name, this.retention());
    return run;
  }

  private planRun(
    repo: GitRepo,
    workflowPath: string,
    wf: Workflow,
    ev: {
      event: string;
      ref: string;
      sha: string;
      actor: string;
      payload: unknown;
      inputs: Record<string, unknown> | undefined;
    }
  ): RunRecord {
    const refName = ev.ref.replace(/^refs\/(heads|tags)\//, '');
    const message =
      typeof ev.payload === 'object' && ev.payload !== null
        ? String(
            ((ev.payload as Record<string, unknown>).head_commit as Record<string, unknown> | null)?.message ?? ''
          ).split('\n')[0]
        : '';

    const run = createRun(this.root, repo.collection, repo.name, (n) => {
      const record: RunRecord = {
        number: n,
        workflowPath,
        workflowName: wf.name ?? path.basename(workflowPath),
        event: ev.event,
        ref: ev.ref,
        refName,
        sha: ev.sha,
        actor: ev.actor,
        message,
        payload: ev.payload,
        inputs: ev.inputs,
        status: 'queued',
        createdAt: nowIso(),
        jobs: [],
      };
      const github = this.githubContext(record, repo.collection, repo.name, null, '');
      // The concurrency group may be an expression; a failure to evaluate it
      // falls back to the literal text rather than failing the run.
      if (wf.concurrency) {
        const env: ExprEnv = { contexts: { github, inputs: (ev.inputs ?? {}) as ExprValue, vars: {} } };
        let group = wf.concurrency.group;
        let cancel = false;
        try {
          group = render(wf.concurrency.group, env);
          cancel = evalCondition(wf.concurrency.cancelInProgress, env);
        } catch {
          // keep the literal group
        }
        record.concurrencyGroup = group;
        record.cancelInProgress = cancel;
      }

      const jobs: JobRecord[] = [];
      for (const wj of wf.jobs) {
        for (const j of this.planJob(wj, wf, github, ev.inputs)) {
          jobs.push(j);
          record.jobs.push(j.id);
        }
      }
      return { run: record, jobs };
    });

    const ar = this.adopt(repo.collection, repo.name, run);
    this.applyConcurrency(ar);
    this.advance(ar);
    pruneRuns(this.root, repo.collection, repo.name, this.retention());
    this.wake();
    return ar.run;
  }

  private planJob(
    wj: WorkflowJob,
    wf: Workflow,
    github: Record<string, ExprValue>,
    inputs: Record<string, unknown> | undefined
  ): JobRecord[] {
    const baseEnv = { ...wf.env, ...wj.env };
    const mk = (id: string, name: string, matrix: Combo | null, idx: number, total: number): JobRecord => ({
      id,
      key: wj.key,
      name,
      needs: wj.needs,
      runsOn: wj.runsOn,
      if: wj.if,
      matrix,
      strategy: wj.strategy ? { failFast: wj.strategy.failFast, jobIndex: idx, jobTotal: total } : null,
      env: baseEnv,
      defaults: wj.defaults,
      steps: wj.steps,
      outputsTemplate: wj.outputs,
      timeoutMinutes: wj.timeoutMinutes,
      continueOnError: wj.continueOnError,
      status: 'queued',
      outputs: {},
      stepStates: [],
      attempts: 0,
    });

    const failPlanned = (id: string, name: string, message: string): JobRecord => {
      const j = mk(id, name, null, 0, 1);
      j.status = 'completed';
      j.conclusion = 'failure';
      j.error = message;
      j.completedAt = nowIso();
      return j;
    };

    if (wj.unsupported) return [failPlanned(wj.key, wj.key, wj.unsupported)];

    let combos: Combo[] | null = null;
    if (wj.strategy?.matrix !== undefined && wj.strategy?.matrix !== null) {
      // A dynamic matrix (an expression, typically fromJSON over needs
      // outputs) would have to be expanded when the job starts; not yet.
      if (typeof wj.strategy.matrix === 'string') {
        return [failPlanned(wj.key, wj.key, 'dynamic matrix expressions are not supported yet')];
      }
      try {
        combos = expandMatrix(wj.strategy.matrix);
      } catch (e) {
        return [failPlanned(wj.key, wj.key, e instanceof Error ? e.message : String(e))];
      }
    }

    const jobName = (matrix: Combo | null): string => {
      const env: ExprEnv = {
        contexts: {
          github,
          matrix: matrix as ExprValue,
          inputs: (inputs ?? {}) as ExprValue,
          vars: {},
          strategy: {},
          needs: {},
        },
      };
      if (wj.name) {
        try {
          return render(wj.name, env);
        } catch {
          return wj.name;
        }
      }
      if (matrix) return `${wj.key} (${Object.values(matrix).map(String).join(', ')})`;
      return wj.key;
    };

    const resolveRunsOn = (j: JobRecord, matrix: Combo | null): void => {
      const env: ExprEnv = {
        contexts: { github, matrix: matrix as ExprValue, inputs: (inputs ?? {}) as ExprValue, vars: {} },
      };
      try {
        j.runsOn = j.runsOn.map((r) => render(r, env)).filter((r) => r !== '');
        if (j.runsOn.length === 0) throw new Error('runs-on resolved to nothing');
      } catch (e) {
        j.status = 'completed';
        j.conclusion = 'failure';
        j.error = `could not resolve runs-on: ${e instanceof Error ? e.message : String(e)}`;
        j.completedAt = nowIso();
      }
    };

    if (!combos) {
      const j = mk(wj.key, jobName(null), null, 0, 1);
      resolveRunsOn(j, null);
      return [j];
    }
    return combos.map((c, i) => {
      const j = mk(`${wj.key}-${i + 1}`, jobName(c), c, i, combos!.length);
      resolveRunsOn(j, c);
      return j;
    });
  }

  // ---- the github context ----

  githubContext(
    run: RunRecord,
    collection: string,
    repo: string,
    jobKey: string | null,
    serverUrl: string
  ): Record<string, ExprValue> {
    const isTag = run.ref.startsWith('refs/tags/');
    return {
      event_name: run.event,
      event: run.payload as ExprValue,
      ref: run.ref,
      ref_name: run.refName,
      ref_type: isTag ? 'tag' : 'branch',
      ref_protected: false,
      sha: run.sha,
      repository: `${collection}/${repo}`,
      repository_owner: collection,
      workflow: run.workflowName,
      workflow_ref: `${collection}/${repo}/${run.workflowPath}@${run.ref}`,
      run_id: String(run.number),
      run_number: run.number,
      run_attempt: '1',
      actor: run.actor,
      triggering_actor: run.actor,
      job: jobKey,
      server_url: serverUrl,
      api_url: serverUrl ? `${serverUrl}/api` : '',
      workspace: '',
      action: '',
      token: '',
      head_ref: '',
      base_ref: '',
      retention_days: '90',
    };
  }

  // ---- concurrency ----

  private applyConcurrency(ar: ActiveRun): void {
    const group = ar.run.concurrencyGroup;
    if (!group) return;
    for (const other of this.active.values()) {
      if (other === ar) continue;
      if (other.collection !== ar.collection || other.repo !== ar.repo) continue;
      if (other.run.concurrencyGroup !== group) continue;
      if (other.run.number >= ar.run.number) continue;
      if (ar.run.cancelInProgress) {
        this.cancelActive(other);
      } else if (other.run.status === 'queued') {
        // Without cancel-in-progress, at most one run waits behind the
        // running one; an older still-queued run is superseded.
        this.cancelActive(other);
      }
    }
  }

  // Whether this run must hold its jobs while an older run in its group runs.
  private heldByConcurrency(ar: ActiveRun): boolean {
    const group = ar.run.concurrencyGroup;
    if (!group) return false;
    for (const other of this.active.values()) {
      if (other === ar) continue;
      if (other.collection !== ar.collection || other.repo !== ar.repo) continue;
      if (other.run.concurrencyGroup !== group) continue;
      if (other.run.number < ar.run.number && !other.run.cancelRequested) return true;
    }
    return false;
  }

  // ---- needs and status ----

  // needs refers to job keys; a matrix job contributes one record per
  // combination, and the key's result is the worst of them. A failed job
  // whose continue-on-error evaluated true counts as success here and for
  // the run's conclusion, while keeping its own conclusion of failure.
  private effectiveConclusion(ar: ActiveRun, j: JobRecord): Conclusion | undefined {
    if (j.status !== 'completed') return undefined;
    if (j.conclusion === 'failure' && j.continueOnError !== undefined) {
      try {
        const env: ExprEnv = {
          contexts: {
            github: this.githubContext(ar.run, ar.collection, ar.repo, j.key, ''),
            matrix: j.matrix as ExprValue,
            inputs: (ar.run.inputs ?? {}) as ExprValue,
            vars: {},
          },
        };
        if (evalCondition(j.continueOnError, env)) return 'success';
      } catch {
        // treat as not continued
      }
    }
    return j.conclusion;
  }

  private needsFor(ar: ActiveRun, needKeys: string[]): Record<string, { result: string; outputs: Record<string, string> }> {
    const out: Record<string, { result: string; outputs: Record<string, string> }> = {};
    for (const key of needKeys) {
      const members = [...ar.jobs.values()].filter((j) => j.key === key);
      let result = 'success';
      const outputs: Record<string, string> = {};
      for (const m of members) {
        const c = this.effectiveConclusion(ar, m);
        if (c === 'failure') result = 'failure';
        else if (c === 'cancelled' && result !== 'failure') result = 'cancelled';
        else if (c === 'skipped' && result === 'success') result = 'skipped';
        Object.assign(outputs, m.outputs);
      }
      out[key] = { result, outputs };
    }
    return out;
  }

  private needsDone(ar: ActiveRun, j: JobRecord): boolean {
    return j.needs.every((key) =>
      [...ar.jobs.values()].filter((x) => x.key === key).every((x) => x.status === 'completed')
    );
  }

  // ---- advancing a run ----

  // Called whenever anything about a run changes: evaluates job conditions
  // whose needs have completed, cascades skips and cancellations, and closes
  // the run when every job is done. Runners are woken separately.
  private advance(ar: ActiveRun): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const j of ar.jobs.values()) {
        if (j.status !== 'queued') continue;
        if (ar.run.cancelRequested) {
          this.completeJob(ar, j, 'cancelled');
          changed = true;
          continue;
        }
        if (!this.needsDone(ar, j)) continue;
        const needs = this.needsFor(ar, j.needs);
        const results = Object.values(needs).map((n) => n.result);
        const allSucceeded = results.every((r) => r === 'success');
        const anyFailed = results.some((r) => r === 'failure');
        let ok: boolean;
        try {
          ok = this.jobCondition(ar, j, needs, { allSucceeded, anyFailed });
        } catch (e) {
          j.error = `error evaluating if: ${e instanceof Error ? e.message : String(e)}`;
          this.completeJob(ar, j, 'failure');
          changed = true;
          continue;
        }
        if (!ok) {
          this.completeJob(ar, j, 'skipped');
          changed = true;
        }
      }
    }
    this.maybeCompleteRun(ar);
  }

  private jobCondition(
    ar: ActiveRun,
    j: JobRecord,
    needs: Record<string, { result: string; outputs: Record<string, string> }>,
    st: { allSucceeded: boolean; anyFailed: boolean }
  ): boolean {
    if (j.if === undefined) return st.allSucceeded;
    const env: ExprEnv = {
      contexts: {
        github: this.githubContext(ar.run, ar.collection, ar.repo, j.key, ''),
        needs: needs as unknown as ExprValue,
        inputs: (ar.run.inputs ?? {}) as ExprValue,
        vars: {},
      },
      functions: {
        success: () => st.allSucceeded,
        failure: () => st.anyFailed,
        cancelled: () => ar.run.cancelRequested === true,
        always: () => true,
      },
    };
    return evalCondition(j.if, env);
  }

  private completeJob(ar: ActiveRun, j: JobRecord, conclusion: Conclusion): void {
    j.status = 'completed';
    j.conclusion = conclusion;
    j.completedAt = nowIso();
    delete j.lease;
    this.saveJob(ar, j);
    if (conclusion === 'failure' && j.strategy?.failFast && j.matrix) {
      // fail-fast: cancel queued siblings; running ones learn on heartbeat.
      for (const sib of ar.jobs.values()) {
        if (sib.key === j.key && sib.id !== j.id && sib.status === 'queued') {
          this.completeJob(ar, sib, 'cancelled');
        }
      }
    }
  }

  private maybeCompleteRun(ar: ActiveRun): void {
    const jobs = [...ar.jobs.values()];
    if (!jobs.every((j) => j.status === 'completed')) {
      this.saveRun(ar);
      return;
    }
    ar.run.status = 'completed';
    const effective = jobs.map((j) => ({ j, c: this.effectiveConclusion(ar, j) }));
    if (ar.run.cancelRequested && !effective.some(({ c }) => c === 'failure')) {
      ar.run.conclusion = 'cancelled';
    } else if (effective.some(({ c }) => c === 'failure')) {
      ar.run.conclusion = 'failure';
    } else if (effective.some(({ c }) => c === 'cancelled')) {
      ar.run.conclusion = 'cancelled';
    } else if (effective.every(({ c }) => c === 'skipped')) {
      ar.run.conclusion = 'skipped';
    } else {
      ar.run.conclusion = 'success';
    }
    ar.run.completedAt = nowIso();
    this.saveRun(ar);
    this.active.delete(runKey(ar.collection, ar.repo, ar.run.number));
    // A held run in the same group can now proceed.
    this.wake();
  }

  // ---- dispatch to runners ----

  private runnableJob(labels: string[], allow: string[]): { ar: ActiveRun; job: JobRecord } | null {
    const labelSet = new Set(labels);
    const allowed = (ar: ActiveRun) => allow.some((g) => globMatch(g, `${ar.collection}/${ar.repo}`));
    const runs = [...this.active.values()].sort((a, b) => a.run.number - b.run.number);
    for (const ar of runs) {
      if (ar.run.cancelRequested) continue;
      if (!allowed(ar)) continue;
      if (this.heldByConcurrency(ar)) continue;
      for (const id of ar.run.jobs) {
        const j = ar.jobs.get(id);
        if (!j || j.status !== 'queued') continue;
        // A manual job is never handed to a registered runner, whatever its
        // other labels say: `runs-on: [manual, ubuntu-latest]` names the image,
        // not a second way to be taken.
        if (isManualJob(j.runsOn)) continue;
        if (!this.needsDone(ar, j)) continue;
        if (!j.runsOn.some((l) => labelSet.has(l))) continue;
        // Ready and condition-checked: advance() already skipped false ifs.
        return { ar, job: j };
      }
    }
    return null;
  }

  // Try to lease a job now; returns null when nothing matches. `limitMinutes`
  // is the runner's own ceiling on how long a job may run there; see leaseJob.
  acquire(
    runnerName: string,
    labels: string[],
    allow: string[],
    serverUrl: string,
    limitMinutes: number | null
  ): JobSpec | null {
    const found = this.runnableJob(labels, allow);
    if (!found) return null;
    return this.leaseJob(found.ar, found.job, runnerName, serverUrl, limitMinutes);
  }

  // Lease one chosen job to a runner (registered or manual session) and build
  // the spec it executes from. The caller has already decided the job may go
  // to this runner; everything from here on is the same for both kinds.
  //
  // `limitMinutes` is the longest the runner taking the job allows one to run,
  // or null for a manual session, which has no registration to carry one and a
  // person watching it instead.
  private leaseJob(
    ar: ActiveRun,
    job: JobRecord,
    runnerName: string,
    serverUrl: string,
    limitMinutes: number | null
  ): JobSpec {
    job.status = 'running';
    job.attempts += 1;
    job.startedAt = job.startedAt ?? nowIso();
    const lease = {
      runner: runnerName,
      token: crypto.randomBytes(16).toString('hex'),
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    };
    job.lease = lease;
    this.saveJob(ar, job);
    if (ar.run.status === 'queued') {
      ar.run.status = 'running';
      ar.run.startedAt = nowIso();
    }
    this.saveRun(ar);

    const needs = this.needsFor(ar, job.needs);
    const github = this.githubContext(ar.run, ar.collection, ar.repo, job.key, serverUrl);
    github.workspace = '';
    let timeout = 360;
    if (job.timeoutMinutes !== undefined) {
      try {
        const env: ExprEnv = {
          contexts: { github, matrix: job.matrix as ExprValue, inputs: (ar.run.inputs ?? {}) as ExprValue, vars: {} },
        };
        const v = Number(render(job.timeoutMinutes, env));
        if (Number.isFinite(v) && v > 0) timeout = v;
      } catch {
        // default stands
      }
    }
    // The runner's limit is a ceiling on what the workflow asked for, not a
    // default it could override: the job runs on somebody else's machine, and
    // six hours of a hung step is the operator's cost. A job asking for less
    // than the ceiling keeps what it asked for, which is what makes
    // `timeout-minutes` still worth writing.
    if (typeof limitMinutes === 'number') timeout = Math.min(timeout, limitMinutes);
    // A private repository cannot be cloned anonymously, so a job for one
    // carries an ephemeral read token for exactly that repository (see
    // src/jobtoken.ts), living a little longer than the job may run. A public
    // repository's job carries none, since none is needed.
    let cloneToken: string | undefined;
    const onDisk = findRepo(this.root, ar.collection, ar.repo);
    if (onDisk && repoIsPrivate(onDisk.dir)) {
      cloneToken = mintJobToken(
        this.root,
        { collection: ar.collection, repo: ar.repo, run: String(ar.run.number) },
        (timeout + 30) * 60_000
      );
    }
    return {
      address: { collection: ar.collection, repo: ar.repo, run: ar.run.number, job: job.id },
      lease: lease.token,
      cloneToken,
      name: job.name,
      runsOn: job.runsOn,
      sha: ar.run.sha,
      ref: ar.run.ref,
      refName: ar.run.refName,
      workflowName: ar.run.workflowName,
      workflowPath: ar.run.workflowPath,
      runNumber: ar.run.number,
      env: job.env,
      defaults: job.defaults,
      steps: job.steps as JobSpec['steps'],
      matrix: job.matrix,
      strategy: job.strategy,
      needs,
      outputsTemplate: job.outputsTemplate,
      github: github as Record<string, unknown>,
      inputs: (ar.run.inputs as Record<string, unknown> | undefined) ?? null,
      timeoutMinutes: timeout,
    };
  }

  // Long-poll: resolve with a job when one becomes available, or null at the
  // deadline. Leasing happens synchronously per waiter, so two runners
  // cannot receive the same job.
  //
  // `gone` is the caller's way of saying the runner behind this wait has hung
  // up. It has to be honoured, not merely recorded: a waiter left in line
  // after its runner went away is handed the next job dispatched, which is
  // then released again with nobody to run it. A runner stopped and started
  // within one poll would otherwise see its first job cancelled before it
  // could ask for one.
  waitForJob(
    runnerName: string,
    labels: string[],
    allow: string[],
    serverUrl: string,
    limitMinutes: number | null,
    timeoutMs: number,
    gone?: AbortSignal
  ): Promise<JobSpec | null> {
    const first = this.acquire(runnerName, labels, allow, serverUrl, limitMinutes);
    if (first) return Promise.resolve(first);
    if (gone?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const deadline = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const onWake = () => {
        const spec = this.acquire(runnerName, labels, allow, serverUrl, limitMinutes);
        if (spec) {
          cleanup();
          resolve(spec);
        }
      };
      const onGone = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        clearTimeout(deadline);
        this.emitter.removeListener('wake', onWake);
        gone?.removeEventListener('abort', onGone);
      };
      this.emitter.on('wake', onWake);
      gone?.addEventListener('abort', onGone);
    });
  }

  // ---- manual jobs ----
  //
  // A job with `manual` among its runs-on labels is taken by nobody until a
  // person mints a command from the run page and pastes it somewhere. The
  // pasted process redeems the command for a session, then acquires the run's
  // manual jobs through the methods below; everything after the lease (logs,
  // heartbeats, artifacts, the report) travels the registered runner's paths,
  // under the runner name `manual:<grant id>`.

  private manualJobsOf(ar: ActiveRun): JobRecord[] {
    return [...ar.jobs.values()].filter((j) => isManualJob(j.runsOn));
  }

  private static matchesJobFilter(j: JobRecord, filter: string | null): boolean {
    if (!filter) return true;
    return globMatch(filter, j.key) || globMatch(filter, j.id) || filter === j.name;
  }

  /**
   * Mint the token the pasted command carries. Refused for a run that is not
   * active (nothing left to run) or has no manual jobs (nothing to run this
   * way); the distinction matters to the caller's message.
   */
  mintManual(
    collection: string,
    repo: string,
    n: number,
    mintedBy: string
  ): { token: string; grant: ManualGrant } | { error: 'finished' | 'no-manual' } {
    const ar = this.active.get(runKey(collection, repo, n));
    if (!ar) return { error: 'finished' };
    if (this.manualJobsOf(ar).length === 0) return { error: 'no-manual' };
    return mintGrant(this.root, collection, repo, n, mintedBy);
  }

  /**
   * Trade a pasted mint token for a session. The mint token is spent by this;
   * the returned session token is what the process authenticates with from
   * here on, and it exists nowhere but in that process and on the wire.
   */
  redeemManual(
    token: string,
    host: string
  ): { sessionToken: string; collection: string; repo: string; run: RunRecord; jobs: JobRecord[]; grant: ManualGrant } | null {
    for (const ar of this.active.values()) {
      const grants = loadGrants(this.root, ar.collection, ar.repo, ar.run.number);
      const grant = findMintable(grants, token);
      if (!grant) continue;
      const sessionToken = redeemGrant(this.root, ar.collection, ar.repo, ar.run.number, grant.id, host);
      if (!sessionToken) continue;
      grant.host = host;
      this.noteSessionRun(grant.id, ar.collection, ar.repo, ar.run.number);
      return {
        sessionToken,
        collection: ar.collection,
        repo: ar.repo,
        run: ar.run,
        jobs: this.manualJobsOf(ar),
        grant,
      };
    }
    return null;
  }

  // Where each session's run lives, so a session that outlasts its run (the
  // usual way a session ends) can still be told the run finished rather than
  // being answered with a bare 401. In memory only: after a restart such a
  // session is simply unrecognized, which its client reports as the run being
  // over, and it nearly always is. Bounded, since entries have no natural
  // expiry: the cap is far above any plausible number of concurrent sessions,
  // and evicting the oldest costs that session only a blunter goodbye.
  private manualSessionRuns = new Map<string, { collection: string; repo: string; n: number }>();

  private noteSessionRun(id: string, collection: string, repo: string, n: number): void {
    this.manualSessionRuns.delete(id);
    this.manualSessionRuns.set(id, { collection, repo, n });
    if (this.manualSessionRuns.size > 200) {
      const oldest = this.manualSessionRuns.keys().next().value;
      if (oldest !== undefined) this.manualSessionRuns.delete(oldest);
    }
  }

  /**
   * The session a presented token belongs to. `active` is false when the
   * run has left the live index, in which case `run` is what the disk says
   * became of it.
   */
  authenticateManualSession(
    token: string
  ): { collection: string; repo: string; n: number; grant: ManualGrant; active: boolean; run: RunRecord | null } | null {
    for (const ar of this.active.values()) {
      const grants = loadGrants(this.root, ar.collection, ar.repo, ar.run.number);
      const grant = findSession(grants, token);
      if (grant) {
        this.noteSessionRun(grant.id, ar.collection, ar.repo, ar.run.number);
        return { collection: ar.collection, repo: ar.repo, n: ar.run.number, grant, active: true, run: ar.run };
      }
    }
    for (const at of this.manualSessionRuns.values()) {
      const grants = loadGrants(this.root, at.collection, at.repo, at.n);
      const grant = findSession(grants, token);
      if (grant) {
        return {
          collection: at.collection,
          repo: at.repo,
          n: at.n,
          grant,
          active: this.active.has(runKey(at.collection, at.repo, at.n)),
          run: readRun(this.root, at.collection, at.repo, at.n),
        };
      }
    }
    return null;
  }

  /**
   * Try to hand this session its run's next manual job. 'wait' means one may
   * yet become eligible (blocked on needs, or held by concurrency); 'done'
   * means this session will never be handed another, with the reason.
   */
  acquireManual(
    collection: string,
    repo: string,
    n: number,
    grant: ManualGrant,
    filter: string | null,
    serverUrl: string
  ): ManualAcquire {
    const ar = this.active.get(runKey(collection, repo, n));
    if (!ar) {
      const run = readRun(this.root, collection, repo, n);
      return {
        kind: 'done',
        run,
        reason: run?.status === 'completed' ? `the run finished: ${run.conclusion}` : 'the run no longer exists',
      };
    }
    if (ar.run.cancelRequested) return { kind: 'done', run: ar.run, reason: 'the run was cancelled' };
    const name = sessionRunnerName(grant);
    const matching = this.manualJobsOf(ar).filter((j) => CiEngine.matchesJobFilter(j, filter));
    if (matching.length === 0) {
      return {
        kind: 'done',
        run: ar.run,
        reason: filter ? `no manual job matches --job ${filter}` : 'this run has no manual jobs',
      };
    }
    if (!this.heldByConcurrency(ar)) {
      for (const id of ar.run.jobs) {
        const j = ar.jobs.get(id);
        if (!j || !matching.includes(j)) continue;
        if (j.status !== 'queued') continue;
        if (!this.needsDone(ar, j)) continue;
        // Attribution rides on the record, not the lease: the lease is gone
        // the moment the job completes, and who ran a job is a fact about the
        // job. Set before leaseJob so its save persists it.
        j.manual = { user: grant.mintedBy, host: grant.host ?? '' };
        return { kind: 'job', spec: this.leaseJob(ar, j, name, serverUrl, null) };
      }
    }
    const queued = matching.some((j) => j.status === 'queued');
    const mine = matching.some((j) => j.status === 'running' && j.lease?.runner === name);
    if (queued || mine) return { kind: 'wait' };
    if (matching.some((j) => j.status === 'running')) {
      return { kind: 'done', run: ar.run, reason: 'the remaining manual jobs are held by another session' };
    }
    return { kind: 'done', run: ar.run, reason: 'every manual job of this run has finished' };
  }

  /** The long-poll form of acquireManual: 'wait' at the deadline, sooner news sooner. */
  waitForManualJob(
    collection: string,
    repo: string,
    n: number,
    grant: ManualGrant,
    filter: string | null,
    serverUrl: string,
    timeoutMs: number,
    gone?: AbortSignal
  ): Promise<ManualAcquire> {
    const first = this.acquireManual(collection, repo, n, grant, filter, serverUrl);
    if (first.kind !== 'wait') return Promise.resolve(first);
    if (gone?.aborted) return Promise.resolve({ kind: 'wait' });
    return new Promise((resolve) => {
      const deadline = setTimeout(() => {
        cleanup();
        resolve({ kind: 'wait' });
      }, timeoutMs);
      const onWake = () => {
        const next = this.acquireManual(collection, repo, n, grant, filter, serverUrl);
        if (next.kind !== 'wait') {
          cleanup();
          resolve(next);
        }
      };
      const onGone = () => {
        cleanup();
        resolve({ kind: 'wait' });
      };
      const cleanup = () => {
        clearTimeout(deadline);
        this.emitter.removeListener('wake', onWake);
        gone?.removeEventListener('abort', onGone);
      };
      this.emitter.on('wake', onWake);
      gone?.addEventListener('abort', onGone);
    });
  }

  /**
   * Hand a leased manual job back untouched: the person at the terminal read
   * the steps and said no, or hung up before the offer arrived. The job
   * returns to waiting for a command, unlike a lease that expires mid-run,
   * which fails the job (see sweepLeases): nothing had executed yet, so there
   * is nothing to have failed.
   */
  releaseManualJob(collection: string, repo: string, n: number, jobId: string, lease: string, runner: string): boolean {
    if (!isManualRunnerName(runner)) return false;
    const found = this.findLeased(collection, repo, n, jobId, lease, runner);
    if (!found) return false;
    const { ar, job } = found;
    delete job.lease;
    delete job.manual;
    delete job.startedAt;
    job.status = 'queued';
    this.saveJob(ar, job);
    this.wake();
    return true;
  }

  /**
   * The job a runner is entitled to act on, or null. Both halves matter: the
   * lease token proves the caller holds this job's grant, and the runner name
   * proves it is the runner the grant was issued to. Checking only the token
   * would mean that a token leaking to another registered runner - through a
   * log, a shared image, or an operator's paste - handed that runner the job's
   * output, and a runner is exactly the party in a position to see one.
   */
  private findLeased(
    collection: string,
    repo: string,
    n: number,
    jobId: string,
    lease: string,
    runner: string
  ): { ar: ActiveRun; job: JobRecord } | null {
    const ar = this.active.get(runKey(collection, repo, n));
    if (!ar) return null;
    const job = ar.jobs.get(jobId);
    if (!job || job.status !== 'running' || !job.lease) return null;
    if (job.lease.runner !== runner) return null;
    if (!sameToken(job.lease.token, lease)) return null;
    return { ar, job };
  }

  heartbeat(
    collection: string,
    repo: string,
    n: number,
    jobId: string,
    lease: string,
    runner: string
  ): { cancel: boolean } | null {
    const found = this.findLeased(collection, repo, n, jobId, lease, runner);
    if (!found) return null;
    found.job.lease!.expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    this.saveJob(found.ar, found.job);
    return { cancel: found.ar.run.cancelRequested === true };
  }

  appendLogs(
    collection: string,
    repo: string,
    n: number,
    jobId: string,
    lease: string,
    runner: string,
    ndjson: string
  ): boolean {
    const found = this.findLeased(collection, repo, n, jobId, lease, runner);
    if (!found) return false;
    try {
      const logPath = jobLogPath(this.root, collection, repo, n, jobId);
      const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      if (size + ndjson.length > MAX_LOG_BYTES) {
        // Stop accepting output, but say so in the log itself rather than
        // going quiet, which would read as the job having stalled.
        if (!found.job.logCapped) {
          found.job.logCapped = true;
          this.saveJob(found.ar, found.job);
          appendJobLog(
            this.root,
            collection,
            repo,
            n,
            jobId,
            JSON.stringify({
              s: -1,
              t: nowIso(),
              l: `[log truncated: this job produced more than ${Math.round(MAX_LOG_BYTES / (1024 * 1024))} MB of output]`,
            }) + '\n'
          );
        }
        return true;
      }
    } catch {
      // append anyway
    }
    appendJobLog(this.root, collection, repo, n, jobId, ndjson);
    found.job.lease!.expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    return true;
  }

  reportStatus(
    collection: string,
    repo: string,
    n: number,
    jobId: string,
    report: {
      lease: string;
      runner: string;
      status: 'running' | 'completed';
      conclusion?: Conclusion;
      stepStates?: StepState[];
      outputs?: Record<string, string>;
      summaries?: string[];
    }
  ): boolean {
    const found = this.findLeased(collection, repo, n, jobId, report.lease, report.runner);
    if (!found) return false;
    const { ar, job } = found;
    if (report.stepStates) job.stepStates = report.stepStates;
    if (report.summaries) job.summaries = report.summaries.map((s) => s.slice(0, 64 * 1024));
    if (report.status === 'completed') {
      if (report.outputs) job.outputs = report.outputs;
      this.completeJob(ar, job, report.conclusion ?? 'failure');
      this.advance(ar);
      this.wake();
    } else {
      job.lease!.expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
      this.saveJob(ar, job);
    }
    return true;
  }

  // ---- cancellation, re-run, lease expiry ----

  cancelRun(collection: string, repo: string, n: number): boolean {
    const ar = this.active.get(runKey(collection, repo, n));
    if (!ar) return false;
    ar.run.cancelRequested = true;
    this.advance(ar); // queued jobs become cancelled; running ones report in
    this.saveRun(ar);
    return true;
  }

  async rerun(collection: string, repo: string, n: number): Promise<RunRecord | null> {
    const old = readRun(this.root, collection, repo, n);
    if (!old) return null;
    const gitRepo = findRepo(this.root, collection, repo);
    if (!gitRepo) return null;
    const discovered = await discoverWorkflows(gitRepo, old.sha);
    const d = discovered.find((x) => x.path === old.workflowPath);
    if (!d) throw new WorkflowError(`no workflow at ${old.workflowPath} at ${old.sha.slice(0, 7)}`);
    if (d.error) {
      return this.createErrorRun(
        gitRepo,
        d.path,
        old.event,
        { ref: old.ref, actor: old.actor, sha: old.sha },
        old.payload,
        d.error
      );
    }
    return this.planRun(gitRepo, d.path, d.workflow!, {
      event: old.event,
      ref: old.ref,
      sha: old.sha,
      actor: old.actor,
      payload: old.payload,
      inputs: old.inputs,
    });
  }

  private cancelActive(ar: ActiveRun): void {
    ar.run.cancelRequested = true;
    this.advance(ar);
    this.saveRun(ar);
  }

  private sweepLeases(): void {
    const now = Date.now();
    for (const ar of this.active.values()) {
      for (const j of ar.jobs.values()) {
        if (j.status !== 'running' || !j.lease) continue;
        if (new Date(j.lease.expiresAt).getTime() > now) continue;
        if (isManualRunnerName(j.lease.runner)) {
          // A manual job's lost session fails the job at once rather than
          // requeueing it: nothing else can pick a manual job up, and a job
          // silently waiting for a person who has gone would read as a run
          // that hangs. Running it again is a fresh command from the run page.
          const who = j.manual ? `run by ${j.manual.user} on ${j.manual.host || 'an unnamed host'}` : '';
          j.error = `the manual session ${who ? `(${who}) ` : ''}stopped responding; mint a new command from the run page to run it again`;
          this.completeJob(ar, j, 'failure');
          this.advance(ar);
          this.wake();
          continue;
        }
        if (j.attempts >= MAX_ATTEMPTS) {
          j.error = `the runner (${j.lease.runner}) stopped responding after ${j.attempts} attempts`;
          this.completeJob(ar, j, 'failure');
          this.advance(ar);
        } else {
          delete j.lease;
          j.status = 'queued';
          this.saveJob(ar, j);
          this.wake();
        }
      }
    }
  }

  artifactLimitBytes(): number {
    const mb = this.retention().artifactMb;
    return Math.max(1, mb) * 1024 * 1024;
  }

  // Called when a repository is deleted: drop its runs from the live index so
  // nothing is dispatched for a repository that no longer exists. Runners
  // holding one of its jobs fail their next heartbeat and stop.
  forgetRepo(collection: string, repo: string): void {
    for (const [key, ar] of this.active) {
      if (ar.collection === collection && ar.repo === repo) this.active.delete(key);
    }
  }

  // ---- read access for the UI ----

  /**
   * What each runner is holding, and what is waiting for one.
   *
   * This is what `mochi runner list` reports beside the registry, because
   * "the run is stuck" nearly always has one of two answers that the registry
   * alone cannot give: no runner is connected, or one is connected but nothing
   * it serves matches the labels the queued jobs asked for.
   */
  runnerLoad(): RunnerLoad {
    const running: RunnerLoad['running'] = {};
    const queued: RunnerLoad['queued'] = [];
    for (const ar of this.active.values()) {
      for (const job of ar.jobs.values()) {
        const at = { collection: ar.collection, repo: ar.repo, run: ar.run.number, job: job.id };
        if (job.status === 'running' && job.lease) {
          running[job.lease.runner] = { ...at, since: job.startedAt ?? null };
        } else if (job.status === 'queued' && this.needsDone(ar, job)) {
          queued.push({ ...at, runsOn: job.runsOn, manual: isManualJob(job.runsOn) });
        }
      }
    }
    return { running, queued };
  }

  activeRun(collection: string, repo: string, n: number): RunRecord | null {
    return this.active.get(runKey(collection, repo, n))?.run ?? null;
  }

  jobOf(collection: string, repo: string, n: number, jobId: string): JobRecord | null {
    const ar = this.active.get(runKey(collection, repo, n));
    if (ar) return ar.jobs.get(jobId) ?? null;
    return readJob(this.root, collection, repo, n, jobId);
  }

  runOf(collection: string, repo: string, n: number): RunRecord | null {
    return this.activeRun(collection, repo, n) ?? readRun(this.root, collection, repo, n);
  }
}

/** What the runners are doing, and what is waiting for one. */
export interface RunnerLoad {
  /** The job each runner holds, by runner name. */
  running: Record<string, { collection: string; repo: string; run: number; job: string; since: string | null }>;
  /**
   * Jobs ready to run that nothing has taken, with the labels each asks for.
   * A manual one is waiting for a pasted command, not for a runner, and every
   * reader of this list has to know the difference to report honestly.
   */
  queued: { collection: string; repo: string; run: number; job: string; runsOn: string[]; manual: boolean }[];
}

/** What acquireManual answers: a job, wait for one, or never another. */
export type ManualAcquire =
  | { kind: 'job'; spec: JobSpec }
  | { kind: 'wait' }
  | { kind: 'done'; run: RunRecord | null; reason: string };

export interface DispatchableWorkflow {
  path: string;
  name: string;
  dispatch: Record<string, DispatchInput> | null;
  triggers: Triggers | null;
  error?: string;
}

export async function listWorkflowsAt(repo: GitRepo, sha: string): Promise<DispatchableWorkflow[]> {
  const discovered = await discoverWorkflows(repo, sha);
  return discovered.map((d) => ({
    path: d.path,
    name: d.workflow?.name ?? path.basename(d.path),
    dispatch: d.workflow?.on.workflowDispatch?.inputs ?? null,
    triggers: d.workflow?.on ?? null,
    error: d.error,
  }));
}
