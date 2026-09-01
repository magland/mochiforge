import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from '../atomic';
import { fileCache } from '../filecache';
import { globMatch } from '../vault';

// The runner registry, in <vault>/runners.json. A runner is not a user: it
// reads repositories (which are world-readable anyway) and writes run state
// for jobs it holds a lease on, and it can never push, edit, or administer.
// Keeping it out of vault.json keeps the two credential kinds from being
// confused for each other, and keeps a machine credential out of the file
// that governs human access.
//
// Only a hash of each runner token is stored, as with user tokens.

export const RUNNERS_FILE = 'runners.json';

export interface RunnerRecord {
  hash: string;
  labels: string[];
  // Globs over collection/repo saying which repositories' jobs this runner
  // may take. A runner executes repository-controlled code, so this is the
  // boundary an operator sets when handing one out.
  allow: string[];
  createdBy: string;
  createdAt: string;
  // When the token was last replaced, absent for a runner whose token is still
  // the one it was registered with. Kept because the useful question about a
  // runner that stopped working is often "was its token rotated under it".
  tokenUpdatedAt?: string;
  // The longest a job may run on this runner, in minutes, absent for one left
  // at DEFAULT_JOB_TIMEOUT_MINUTES. It is a ceiling rather than a default: a
  // job asking for less gets less, and a job asking for more, or asking for
  // nothing and so inheriting GitHub's six hours, gets this. The machine
  // belongs to whoever registered the runner, and the workflow that runs on it
  // does not, so the bound is the operator's to set.
  jobTimeoutMinutes?: number;
  // Where to send a request when this runner has work waiting and is not
  // there to take it. A runner that stops when idle cannot be reached at all,
  // so something has to start it; on Fly that something is a request to the
  // app, which the proxy answers by starting the machine.
  //
  // The secret is stored as the vault sends it, not as a hash: this is a
  // credential the vault presents to somebody else, which is the opposite of
  // the token above. It buys nothing but the right to start a machine, and
  // runners.json is already mode 0600.
  wakeUrl?: string;
  wakeSecret?: string;
}

export interface RunnerRegistry {
  runners: Record<string, RunnerRecord>;
}

/**
 * How long a job may run on a runner that has not been given a limit.
 *
 * Twenty minutes rather than GitHub's six hours because the failure this bounds
 * is a job that hangs: a step waiting on input that never comes, a network call
 * with no timeout of its own. On a hosted runner that costs someone else's
 * money; on a machine an operator registered here it costs theirs, and holds
 * the runner against every other job in the meantime. A build that genuinely
 * takes longer is a runner whose limit is raised, deliberately and once.
 */
export const DEFAULT_JOB_TIMEOUT_MINUTES = 20;

/** The longest a job may run on this runner, whether it was set or defaulted. */
export function runnerJobTimeout(runner: RunnerRecord): number {
  return runner.jobTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES;
}

/** Four weeks: past this a millisecond delay overflows a signed 32-bit field. */
export const MAX_JOB_TIMEOUT_MINUTES = 40320;

/**
 * Whether a number may be stored as a runner's job timeout: whole minutes, at
 * least one, and no more than MAX_JOB_TIMEOUT_MINUTES, past which the runner's
 * own setTimeout would fire immediately. Refusing an absurd value is kinder
 * than a limit that does the opposite of what it says.
 */
export function isUsableJobTimeout(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_JOB_TIMEOUT_MINUTES;
}

export function runnersFilePath(root: string): string {
  return path.join(root, RUNNERS_FILE);
}

function normalize(parsed: unknown): RunnerRegistry {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('runners.json must be a JSON object');
  const raw = (parsed as Record<string, unknown>).runners;
  if (raw === undefined) return { runners: {} };
  if (typeof raw !== 'object' || raw === null) throw new Error('runners.json must have a "runners" object');
  const runners: Record<string, RunnerRecord> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) throw new Error(`runner ${name} must be an object`);
    const r = v as Record<string, unknown>;
    if (typeof r.hash !== 'string') throw new Error(`runner ${name} needs a "hash"`);
    const strings = (x: unknown, field: string): string[] => {
      if (x === undefined) return [];
      if (Array.isArray(x) && x.every((s) => typeof s === 'string')) return x as string[];
      throw new Error(`runner ${name}: "${field}" must be a list of strings`);
    };
    runners[name] = {
      hash: r.hash,
      labels: strings(r.labels, 'labels'),
      allow: strings(r.allow, 'allow'),
      createdBy: typeof r.createdBy === 'string' ? r.createdBy : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      // An unusable value is dropped rather than refused, unlike the fields
      // above whose absence would leave no runner at all: a hand-edited
      // timeout of "soon" leaves the runner working under the default, which
      // is the safe direction for a bound.
      ...(typeof r.jobTimeoutMinutes === 'number' && isUsableJobTimeout(r.jobTimeoutMinutes)
        ? { jobTimeoutMinutes: r.jobTimeoutMinutes }
        : {}),
      ...(typeof r.tokenUpdatedAt === 'string' ? { tokenUpdatedAt: r.tokenUpdatedAt } : {}),
      ...(typeof r.wakeUrl === 'string' ? { wakeUrl: r.wakeUrl } : {}),
      ...(typeof r.wakeSecret === 'string' ? { wakeSecret: r.wakeSecret } : {}),
    };
  }
  return { runners };
}

const cache = fileCache<RunnerRegistry>({
  read: (file) => {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      console.error(`runners.json could not be read: ${e instanceof Error ? e.message : e}`);
      return { runners: {} };
    }
  },
  missing: () => ({ runners: {} }),
});

export function loadRunners(root: string): RunnerRegistry {
  return cache.get(runnersFilePath(root));
}

function write(root: string, registry: RunnerRegistry): void {
  writeFileAtomic(runnersFilePath(root), JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  cache.invalidate(runnersFilePath(root));
}

/**
 * Hold the registry's lock across a read, an edit, and the write back.
 *
 * `mochi runner add` from a shell and the same call through the API edit
 * this file the same way, and either one overlapping the other loses a runner
 * outright. The cache is dropped on the way in because the decision it makes,
 * that a file with an unchanged mtime and size has unchanged contents, is one
 * this function cannot afford: another process may have written in the interval
 * since the last read, and the copy about to be edited must be the one on disk.
 */
function editRunners<T>(root: string, fn: () => T): T {
  return withFileLock(`${runnersFilePath(root)}.lock`, () => {
    cache.invalidate(runnersFilePath(root));
    return fn();
  });
}

export function hashRunnerToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newRunnerToken(): string {
  return 'mochi_runner_' + crypto.randomBytes(32).toString('hex');
}

export function registerRunner(
  root: string,
  name: string,
  opts: {
    labels: string[];
    allow: string[];
    createdBy: string;
    jobTimeoutMinutes?: number | null;
    wake?: RunnerWake | null;
  }
): { token: string; runner: RunnerRecord } {
  return editRunners(root, () => {
    const registry = loadRunners(root);
    const token = newRunnerToken();
    const runner: RunnerRecord = {
      hash: hashRunnerToken(token),
      labels: opts.labels,
      allow: opts.allow,
      createdBy: opts.createdBy,
      createdAt: new Date().toISOString(),
      ...(opts.jobTimeoutMinutes ? { jobTimeoutMinutes: opts.jobTimeoutMinutes } : {}),
      ...(opts.wake ? { wakeUrl: opts.wake.url, wakeSecret: opts.wake.secret } : {}),
    };
    registry.runners[name] = runner;
    write(root, registry);
    return { token, runner };
  });
}

/**
 * Issue a new token for an existing runner, keeping its labels and allow list.
 *
 * The old token stops working the moment this returns, so a runner still
 * polling with it gets a 401 and must be restarted with the new one. Returns
 * null if no runner by that name is registered.
 */
export function regenerateRunnerToken(root: string, name: string): { token: string; runner: RunnerRecord } | null {
  return editRunners(root, () => {
    const registry = loadRunners(root);
    const existing = registry.runners[name];
    if (!existing) return null;
    const token = newRunnerToken();
    const runner: RunnerRecord = {
      ...existing,
      hash: hashRunnerToken(token),
      tokenUpdatedAt: new Date().toISOString(),
    };
    registry.runners[name] = runner;
    write(root, registry);
    return { token, runner };
  });
}

/**
 * Set the longest a job may run on this runner, or put it back on the default
 * with null. Separate from registration, as the wake address is, because it is
 * the setting most likely to be changed after the fact: the first job that
 * runs long is when an operator learns the limit is wrong. Returns null if no
 * runner by that name is registered.
 */
export function setRunnerJobTimeout(root: string, name: string, minutes: number | null): RunnerRecord | null {
  return editRunners(root, () => {
    const registry = loadRunners(root);
    const existing = registry.runners[name];
    if (!existing) return null;
    const runner: RunnerRecord = { ...existing };
    delete runner.jobTimeoutMinutes;
    if (minutes !== null) runner.jobTimeoutMinutes = minutes;
    registry.runners[name] = runner;
    write(root, registry);
    return runner;
  });
}

export interface RunnerWake {
  url: string;
  secret: string;
}

/**
 * Point a runner's wake address somewhere, or clear it with null.
 *
 * Separate from registration because the two are learned at different times:
 * `mochi deploy fly runner` registers the runner before the app it will
 * run on exists, and only afterwards knows the URL that starts it. Returns
 * null if no runner by that name is registered.
 */
export function setRunnerWake(root: string, name: string, wake: RunnerWake | null): RunnerRecord | null {
  return editRunners(root, () => {
    const registry = loadRunners(root);
    const existing = registry.runners[name];
    if (!existing) return null;
    const runner: RunnerRecord = { ...existing };
    delete runner.wakeUrl;
    delete runner.wakeSecret;
    if (wake) {
      runner.wakeUrl = wake.url;
      runner.wakeSecret = wake.secret;
    }
    registry.runners[name] = runner;
    write(root, registry);
    return runner;
  });
}

export function removeRunner(root: string, name: string): boolean {
  return editRunners(root, () => {
    const registry = loadRunners(root);
    if (!registry.runners[name]) return false;
    delete registry.runners[name];
    write(root, registry);
    return true;
  });
}

// When each runner last authenticated, kept in memory rather than in
// runners.json. A runner long-polls continuously, so recording this on disk
// would mean a write every few seconds per runner, for a fact that is only
// interesting while the server is up: after a restart every live runner
// re-announces itself within one poll, and one that does not is exactly the
// one worth reporting as absent.
const lastSeen = new Map<string, number>();

export function noteRunnerSeen(name: string): void {
  lastSeen.set(name, Date.now());
}

/** When this runner last spoke to the vault, or null if it has not since the server started. */
export function runnerLastSeen(name: string): string | null {
  const at = lastSeen.get(name);
  return at === undefined ? null : new Date(at).toISOString();
}

export interface RunnerAuth {
  name: string;
  runner: RunnerRecord;
}

export function authenticateRunner(root: string, token: string): RunnerAuth | null {
  const registry = loadRunners(root);
  const presented = Buffer.from(hashRunnerToken(token), 'hex');
  for (const [name, runner] of Object.entries(registry.runners)) {
    let stored: Buffer;
    try {
      stored = Buffer.from(runner.hash, 'hex');
    } catch {
      continue;
    }
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) {
      return { name, runner };
    }
  }
  return null;
}

// Whether a runner is allowed to take jobs for a repository. An empty allow
// list means nothing, not everything: a runner handed out without a scope
// should sit idle rather than pick up every repository in the vault.
export function runnerAllows(runner: RunnerRecord, collection: string, repo: string): boolean {
  return runner.allow.some((g) => globMatch(g, `${collection}/${repo}`));
}
