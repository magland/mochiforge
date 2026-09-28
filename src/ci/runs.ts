import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../atomic';
import { repoPath } from '../layout';
import { displayName, isValidName } from '../scan';

// Run state on disk. A repository's workflow runs live in a sibling
// directory next to the bare repository, following the same convention as
// sites and local LFS objects:
//
//   <vault>/collections/<collection>/repos/<repo>.runs/
//     12/
//       run.json          the run: event, ref, sha, status, job order
//       jobs/build.json    each job: spec, status, steps, lease
//       jobs/build.log     append-only ndjson log lines {s, t, l}
//
// Everything here is plain file I/O with no in-memory state; the engine
// (engine.ts) keeps the live index and calls down into this module.

export type RunStatus = 'queued' | 'running' | 'completed';
export type Conclusion = 'success' | 'failure' | 'cancelled' | 'skipped';
export type JobStatus = 'queued' | 'running' | 'completed';

export interface StepState {
  name: string;
  status: 'pending' | 'running' | 'completed';
  conclusion?: Conclusion;
  startedAt?: string;
  completedAt?: string;
}

export interface JobLease {
  runner: string;
  token: string;
  expiresAt: string;
}

export interface JobRecord {
  id: string; // job key, or key-N for matrix expansions
  key: string; // the workflow job key
  name: string;
  needs: string[];
  runsOn: string[];
  if?: string;
  matrix: Record<string, unknown> | null;
  strategy: { failFast: boolean; jobIndex: number; jobTotal: number } | null;
  env: Record<string, string>; // workflow env merged under job env, unevaluated
  defaults?: { shell?: string; workingDirectory?: string };
  steps: unknown[]; // WorkflowStep[], stored raw for the runner
  outputsTemplate: Record<string, string>;
  timeoutMinutes?: string;
  continueOnError?: string;
  status: JobStatus;
  conclusion?: Conclusion;
  // For jobs failed by the planner (unsupported features, bad expressions):
  // shown in place of a log.
  error?: string;
  outputs: Record<string, string>;
  stepStates: StepState[];
  summaries?: string[];
  lease?: JobLease;
  // For a job executed through a pasted command (runs-on: manual): who minted
  // the command and the hostname the session reported. The audit trail for
  // "repository code ran on a machine of mine", so it is kept on the record
  // and shown wherever the job is. The host is self-reported.
  manual?: { user: string; host: string };
  // Set once the job's log hits its size cap, so the notice is written once.
  logCapped?: boolean;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
}

export interface RunRecord {
  number: number;
  workflowPath: string;
  workflowName: string;
  event: string;
  ref: string;
  refName: string;
  sha: string;
  actor: string;
  message: string; // head commit subject, for listings
  payload: unknown; // the github.event payload
  inputs?: Record<string, unknown>; // workflow_dispatch inputs
  status: RunStatus;
  conclusion?: Conclusion;
  error?: string; // workflow-file parse errors
  concurrencyGroup?: string;
  cancelInProgress?: boolean;
  cancelRequested?: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  jobs: string[]; // ordered job ids
}

export function runsDir(root: string, collection: string, repoName: string): string | null {
  if (!isValidName(collection) || !isValidName(repoName)) return null;
  return repoPath(root, collection, `${displayName(repoName)}.runs`);
}

function runDir(root: string, collection: string, repoName: string, n: number): string {
  return path.join(runsDir(root, collection, repoName)!, String(n));
}

function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 1) + '\n');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// Allocate the next run number and create its directory. mkdir is the
// atomicity: if two creations race, the loser's mkdir fails and it retries.
export function createRun(
  root: string,
  collection: string,
  repoName: string,
  make: (n: number) => { run: RunRecord; jobs: JobRecord[] }
): RunRecord {
  const base = runsDir(root, collection, repoName);
  if (!base) throw new Error('invalid repository');
  fs.mkdirSync(base, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    const n = nextRunNumber(base);
    const dir = path.join(base, String(n));
    try {
      fs.mkdirSync(dir);
    } catch {
      continue;
    }
    fs.mkdirSync(path.join(dir, 'jobs'));
    const { run, jobs } = make(n);
    for (const j of jobs) {
      if (!isValidJobId(j.id)) throw new Error(`refusing to write a job record under the id ${j.id}`);
      writeJson(path.join(dir, 'jobs', `${j.id}.json`), j);
    }
    writeJson(path.join(dir, 'run.json'), run);
    return run;
  }
  throw new Error('could not allocate a run number');
}

function nextRunNumber(base: string): number {
  let max = 0;
  for (const e of fs.readdirSync(base)) {
    const n = parseInt(e, 10);
    if (Number.isInteger(n) && String(n) === e && n > max) max = n;
  }
  return max + 1;
}

export function readRun(root: string, collection: string, repoName: string, n: number): RunRecord | null {
  return readJson<RunRecord>(path.join(runDir(root, collection, repoName, n), 'run.json'));
}

export function writeRun(root: string, collection: string, repoName: string, run: RunRecord): void {
  writeJson(path.join(runDir(root, collection, repoName, run.number), 'run.json'), run);
}

// Job ids reach the filesystem as a path segment, so every function that
// builds a path from one checks it, whatever the caller believes about where
// it came from. Workflow parsing enforces the same shape (workflow.ts), and
// this is the second lock on the same door.
export function isValidJobId(jobId: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,110}$/.test(jobId);
}

export function readJob(
  root: string,
  collection: string,
  repoName: string,
  n: number,
  jobId: string
): JobRecord | null {
  if (!isValidJobId(jobId)) return null;
  return readJson<JobRecord>(path.join(runDir(root, collection, repoName, n), 'jobs', `${jobId}.json`));
}

export function writeJob(root: string, collection: string, repoName: string, n: number, job: JobRecord): void {
  if (!isValidJobId(job.id)) throw new Error(`refusing to write a job record under the id ${job.id}`);
  writeJson(path.join(runDir(root, collection, repoName, n), 'jobs', `${job.id}.json`), job);
}

export function jobLogPath(root: string, collection: string, repoName: string, n: number, jobId: string): string {
  if (!isValidJobId(jobId)) throw new Error(`invalid job id: ${jobId}`);
  return path.join(runDir(root, collection, repoName, n), 'jobs', `${jobId}.log`);
}

export function appendJobLog(
  root: string,
  collection: string,
  repoName: string,
  n: number,
  jobId: string,
  ndjson: string
): void {
  fs.appendFileSync(jobLogPath(root, collection, repoName, n, jobId), ndjson);
}

/**
 * The newest run, read without reading the rest. A listing of a whole vault
 * asks this of every repository, so it finds the highest-numbered directory
 * and reads that one file rather than parsing the hundred a repository may
 * have kept.
 */
export function latestRun(root: string, collection: string, repoName: string): RunRecord | null {
  const base = runsDir(root, collection, repoName);
  if (!base) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return null;
  }
  let max = 0;
  for (const e of entries) {
    const n = parseInt(e, 10);
    if (Number.isInteger(n) && String(n) === e && n > max) max = n;
  }
  return max === 0 ? null : readJson<RunRecord>(path.join(base, String(max), 'run.json'));
}

export function listRuns(root: string, collection: string, repoName: string): RunRecord[] {
  const base = runsDir(root, collection, repoName);
  if (!base) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const e of entries) {
    const n = parseInt(e, 10);
    if (!Number.isInteger(n) || String(n) !== e) continue;
    const run = readJson<RunRecord>(path.join(base, e, 'run.json'));
    if (run) runs.push(run);
  }
  runs.sort((a, b) => b.number - a.number);
  return runs;
}

/**
 * A completed run is kept for at least this long, whatever the retention
 * settings say. A low run count is otherwise at the mercy of a busy hour: a
 * repository whose workflows fire on every push could lose the run somebody is
 * still reading, or the one that failed, to the twenty that followed it. Timed
 * from completion, since a run is history from then on. A constant rather than
 * a setting, for the reason the sweep's are (see src/maintenance.ts).
 */
export const MIN_RUN_AGE_MS = 24 * 60 * 60 * 1000;

// Delete completed runs beyond the retention settings. Active runs are never
// pruned regardless of age, and neither is a run completed in the last
// MIN_RUN_AGE_MS, so `runs` is a floor that a busy day may exceed.
export function pruneRuns(
  root: string,
  collection: string,
  repoName: string,
  retain: { runs: number; days: number },
  now: number = Date.now()
): void {
  const base = runsDir(root, collection, repoName);
  if (!base) return;
  const all = listRuns(root, collection, repoName);
  const completed = all.filter((r) => r.status === 'completed');
  const doomed = new Set<number>();
  completed.slice(Math.max(0, retain.runs)).forEach((r) => doomed.add(r.number));
  if (retain.days > 0) {
    const cutoff = now - retain.days * 24 * 60 * 60 * 1000;
    for (const r of completed) {
      if (new Date(r.createdAt).getTime() < cutoff) doomed.add(r.number);
    }
  }
  for (const r of completed) {
    const finished = new Date(r.completedAt ?? r.createdAt).getTime();
    // An unparseable time is treated as old, so a damaged record cannot pin
    // its run forever.
    if (Number.isFinite(finished) && now - finished < MIN_RUN_AGE_MS) doomed.delete(r.number);
  }
  for (const n of doomed) {
    fs.rmSync(path.join(base, String(n)), { recursive: true, force: true });
  }
}
