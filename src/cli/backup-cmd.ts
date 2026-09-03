import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemoteTarget } from '../cli-api';
import { writeFileAtomic } from '../atomic';
import { isBareRepo } from '../scan';
import { CliError, EXIT_CONFLICT, EXIT_FAIL, EXIT_USAGE, exitCodeForStatus } from './exit';
import { JSON_OPTION, jsonMode, pickObject, printJson, printTable } from './output';
import { Command, Invocation, OptionSpec } from './parse';
import { TARGET_OPTIONS, targetFrom } from './target';

// `mochi backup <dir>`: an incremental copy of a whole vault onto a disk of
// your own, over HTTP.
//
// The documentation is entitled to say that backing up a vault is `cp -a`, and
// that is true of a vault on a machine you have a shell on. It is not true of
// the deployment the CLI recommends, where the vault is on a Fly volume with no
// shell in the ordinary sense and no rsync at the far end. This command is the
// answer for that case, and works identically against a VPS, a Docker
// deployment, and 127.0.0.1:3000.
//
// Two things shape everything here.
//
// The backup directory is itself a vault, so restoring is `mochi serve
// <dir>/current` rather than a program that only gets exercised during a
// disaster. Each mirror is a bare repository like any other, so the recovery
// procedure is one line and can be rehearsed at any time.
//
// Nothing in the backup is ever modified in place. Git rewrites refs and
// packfiles by rename, mochi writes its state files by rename, this file
// writes by rename, and reflogs - the one thing git appends to - are turned off
// on the mirrors. That is what makes a snapshot a directory of hardlinks
// costing inodes rather than bytes. Any future code here that opens a file
// under current/ for appending breaks every existing snapshot.
//
// See docs/backup.md, and src/api/backup.ts for the two routes this speaks to.

const STATE_FILE = 'backup.json';
const LOCK_FILE = '.lock';
const CURRENT = 'current';
const SNAPSHOTS = 'snapshots';

/** How many runs of history backup.json keeps. Enough to see a pattern, not a log file. */
const KEEP_RUNS = 20;

/** The server's own caps, which the client chunks to fit. */
const MAX_FETCH_PATHS = 2000;
const MAX_FETCH_BYTES = 64 * 1024 * 1024;

interface Retention {
  daily: number;
  weekly: number;
  monthly: number;
}

const DEFAULT_RETENTION: Retention = { daily: 7, weekly: 4, monthly: 6 };

/**
 * What the last run knows about one file. Two timestamps rather than one, and
 * both are needed:
 *
 *  - `mtime` is the vault's, to the millisecond, and is what the next manifest
 *    is compared against. Comparing the vault's timestamp with the vault's own
 *    earlier timestamp involves no filesystem in the middle to lose precision.
 *  - `local` is what this filesystem gave back after the copy was written and
 *    its timestamp set. It is compared against the copy's timestamp now, so a
 *    file edited, truncated, or corrupted in the backup is noticed and fetched
 *    again, which is what makes a backup self-healing rather than merely
 *    incremental. It is recorded rather than assumed equal to `mtime` because a
 *    filesystem with coarse timestamps rounds it, and assuming would then
 *    re-fetch every file on every run.
 */
interface FileRecord {
  size: number;
  mtime: number;
  local: number;
  mode: number;
  sha256?: string;
}

interface RunRecord {
  started: string;
  finished: string;
  files: number;
  bytes: number;
  repos: number;
  deleted: number;
  error?: string;
}

interface BackupState {
  version: number;
  host: string;
  lfs: string;
  excluded: string[];
  retention: Retention;
  repos: Record<string, { refs: string }>;
  files: Record<string, FileRecord>;
  runs: RunRecord[];
}

function emptyState(): BackupState {
  return {
    version: 1,
    host: '',
    lfs: 'volume',
    excluded: [],
    retention: { ...DEFAULT_RETENTION },
    repos: {},
    files: {},
    runs: [],
  };
}

function statePath(dir: string): string {
  return path.join(dir, STATE_FILE);
}

function loadState(dir: string): BackupState {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Record<string, unknown>;
  } catch {
    return emptyState();
  }
  const state = emptyState();
  if (typeof parsed.host === 'string') state.host = parsed.host;
  if (typeof parsed.lfs === 'string') state.lfs = parsed.lfs;
  if (Array.isArray(parsed.excluded)) state.excluded = parsed.excluded.filter((x) => typeof x === 'string') as string[];
  if (typeof parsed.retention === 'object' && parsed.retention !== null) {
    const r = parsed.retention as Record<string, unknown>;
    for (const k of ['daily', 'weekly', 'monthly'] as const) {
      if (typeof r[k] === 'number' && (r[k] as number) >= 0) state.retention[k] = Math.floor(r[k] as number);
    }
  }
  if (typeof parsed.repos === 'object' && parsed.repos !== null) state.repos = parsed.repos as BackupState['repos'];
  if (typeof parsed.files === 'object' && parsed.files !== null) state.files = parsed.files as BackupState['files'];
  if (Array.isArray(parsed.runs)) state.runs = parsed.runs as RunRecord[];
  return state;
}

function saveState(dir: string, state: BackupState): void {
  writeFileAtomic(statePath(dir), JSON.stringify(state, null, 2) + '\n');
}

// ---- the lock ----

interface Lock {
  release(): void;
}

/**
 * One run at a time per backup directory. Two runs interleaving would fetch
 * against each other's half-written files and produce a backup of no particular
 * moment at all, so the second exits 5, the code a caller already reads as "run
 * this again later" rather than "this is broken".
 *
 * A lock whose holder is gone is broken rather than honoured: the common way to
 * leave one behind is a machine that lost power mid-run, and a backup that
 * stops running until someone notices a stale file is a backup that stops
 * running. Only a lock taken on this same machine can be checked that way, so a
 * lock from elsewhere - a backup directory on a network share - is honoured
 * whatever its age.
 *
 * Not `withFileLock` from src/atomic.ts, which guards a read-modify-write of one
 * state file: it waits for the lock and breaks one older than ten seconds, both
 * of which are right for a critical section measured in milliseconds and wrong
 * here. A backup of a large vault holds this for many minutes, so age says
 * nothing about whether the holder is alive, and a second run should be told to
 * come back rather than made to wait for a transfer it cannot know the length of.
 */
function takeLock(dir: string, quiet: boolean): Lock {
  const file = path.join(dir, LOCK_FILE);
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }) + '\n';
  const attempt = (): number | null => {
    try {
      return fs.openSync(file, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw e;
    }
  };
  let fd = attempt();
  if (fd === null) {
    let held: { pid?: unknown; host?: unknown; started?: unknown } = {};
    try {
      held = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof held;
    } catch {
      held = {};
    }
    const sameMachine = held.host === os.hostname();
    const pid = typeof held.pid === 'number' ? held.pid : null;
    let alive = true;
    if (sameMachine && pid !== null) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    if (alive) {
      throw new CliError(
        `Another backup is running in ${dir} (${LOCK_FILE} held by pid ${pid ?? '?'} on ${String(held.host ?? '?')}` +
          `${held.started ? `, since ${String(held.started)}` : ''}). Nothing was changed.`,
        EXIT_CONFLICT
      );
    }
    if (!quiet) {
      console.error(
        `Warning: breaking a stale lock in ${dir}: pid ${pid} on this machine is gone. ` +
          'A previous run did not finish, so this one may have more to do than usual.'
      );
    }
    fs.rmSync(file, { force: true });
    fd = attempt();
    if (fd === null) throw new CliError(`Could not take the lock in ${dir}.`, EXIT_CONFLICT);
  }
  fs.writeFileSync(fd, mine);
  fs.closeSync(fd);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // A lock that cannot be removed is a warning at worst; the next run
      // breaks it.
    }
  };
  // A run interrupted at the terminal should not leave a lock behind either.
  // Note that having a listener at all takes away the signal's default, so this
  // has to end the process itself: 130 is what a shell reports for a command
  // stopped by Ctrl-C, and the next run then finds no lock to break.
  const onSignal = () => {
    release();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { release };
}

// ---- git ----

/**
 * Run git, with its output captured. Captured rather than inherited so that
 * `--json` really does put one JSON value on stdout and nothing else; the
 * output is printed only when git failed, which is when it is worth reading.
 */
function git(args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) =>
      reject(new CliError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'git is not on PATH' : String(e.message)))
    );
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

async function gitOrFail(args: string[], what: string, cwd?: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new CliError(`${what}:\n${r.out.trim()}`);
  return r.out;
}

// ---- the manifest ----

/**
 * Whether a path the vault named is one this command may write under the
 * backup directory.
 *
 * Every path in a manifest becomes a path on the operator's machine, by way of
 * path.join with the backup directory, so the manifest is input from somewhere
 * else and is checked as such. The vault applies the same rule to the paths a
 * fetch asks for (see vaultPath in src/api/backup.ts); without the mirror of it
 * here, a vault that answered a manifest with `../../.bashrc` would be writing
 * a file outside the backup, and one that answered with a repository at such a
 * path would have this command delete a directory outside it.
 *
 * Refused rather than normalized, and the run stops rather than skipping the
 * line: a vault sending one of these is not a vault whose other answers are
 * worth acting on.
 */
function isVaultRelative(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.length > 1024) return false;
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/')) return false;
  return !p.split('/').some((s) => s === '' || s === '.' || s === '..');
}

/** How a refused path is reported, in one place since two kinds of line carry one. */
function refusedPath(p: unknown): string {
  return (
    `The vault named a path this backup will not write: ${JSON.stringify(p)}. ` +
    'A manifest path must be relative to the vault and must not climb out of it, so nothing was copied.'
  );
}

interface ManifestFile {
  kind: 'file';
  path: string;
  size: number;
  mtime: number;
  mode: number;
  sha256?: string;
}

interface ManifestRepo {
  kind: 'repo';
  path: string;
  collection: string;
  repo: string;
  refs: string;
  packed: number;
}

interface Manifest {
  lfs: string;
  excluded: string[];
  files: Map<string, ManifestFile>;
  repos: ManifestRepo[];
  counts: { files: number; bytes: number; repos: number };
}

async function fetchManifest(target: RemoteTarget, exclude: string[], hash: boolean): Promise<Manifest> {
  const query: string[] = [];
  if (exclude.length) query.push(`exclude=${encodeURIComponent(exclude.join(','))}`);
  if (hash) query.push('hash=1');
  const url = `${target.host}/api/backup/manifest${query.length ? `?${query.join('&')}` : ''}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { authorization: `Bearer ${target.token}` } });
  } catch (e) {
    throw new CliError(`Could not reach ${target.host}: ${e instanceof Error ? e.message : e}`);
  }
  if (!resp.ok) {
    let message = `HTTP ${resp.status} from ${url}`;
    try {
      const data = JSON.parse(await resp.text()) as { error?: unknown };
      if (data.error) message = String(data.error);
    } catch {
      // not JSON; the status is all there is to say
    }
    // A vault that answers other routes and not this one does not have these
    // routes, which means it is older than this client. Worth saying, because a
    // bare 404 here reads as "no such vault" and sends the reader looking at the
    // URL and the token, neither of which is the problem.
    if (resp.status === 404) {
      message =
        `${target.host} has no /api/backup/manifest route, so it is running a mochi older than this ` +
        'command. Deploy the vault again from a version that has it, then run this.';
    }
    // The same status-to-code mapping every other command uses, so that a
    // caller branching on the exit code does not have to learn a second table.
    throw new CliError(message, exitCodeForStatus(resp.status));
  }
  const manifest: Manifest = {
    lfs: 'volume',
    excluded: [],
    files: new Map(),
    repos: [],
    counts: { files: 0, bytes: 0, repos: 0 },
  };
  let ended = false;
  for await (const line of ndjson(resp)) {
    const kind = (line as { kind?: unknown }).kind;
    if (kind === 'vault') {
      const v = line as { lfs?: unknown; excluded?: unknown };
      if (typeof v.lfs === 'string') manifest.lfs = v.lfs;
      if (Array.isArray(v.excluded)) manifest.excluded = v.excluded as string[];
    } else if (kind === 'file') {
      const f = line as unknown as ManifestFile;
      if (!isVaultRelative(f.path)) throw new CliError(refusedPath(f.path));
      manifest.files.set(f.path, f);
    } else if (kind === 'repo') {
      const r = line as unknown as ManifestRepo;
      if (!isVaultRelative(r.path)) throw new CliError(refusedPath(r.path));
      manifest.repos.push(r);
    } else if (kind === 'end') {
      const e = line as unknown as { files: number; bytes: number; repos: number };
      manifest.counts = { files: e.files, bytes: e.bytes, repos: e.repos };
      ended = true;
    } else if (kind === 'error') {
      throw new CliError(`The vault could not finish the manifest: ${String((line as { error?: unknown }).error)}`);
    }
  }
  // The end line is what says the walk completed. Acting on a truncated
  // manifest would delete every path the vault did not get around to listing.
  if (!ended) {
    throw new CliError(
      'The manifest ended early, so what the vault holds is not fully known. Nothing was deleted; try again.'
    );
  }
  return manifest;
}

/** Each line of an NDJSON response, parsed. */
async function* ndjson(resp: Response): AsyncGenerator<unknown> {
  const body = resp.body;
  if (!body) return;
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += Buffer.from(chunk).toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      yield JSON.parse(line);
    }
  }
  if (buf.trim() !== '') yield JSON.parse(buf);
}

// ---- the length-prefixed fetch stream ----

/**
 * Reads the framed response of POST /api/backup/fetch: a JSON line, then
 * exactly the bytes it declared, repeated, then a line saying what was missing.
 * A byte reader rather than a line reader, because the payloads are arbitrary
 * bytes and a newline inside one means nothing.
 */
class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  private readonly it: AsyncIterator<Uint8Array>;

  constructor(body: AsyncIterable<Uint8Array>) {
    this.it = body[Symbol.asyncIterator]();
  }

  private async more(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.it.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    this.buf = Buffer.concat([this.buf, Buffer.from(next.value)]);
    return true;
  }

  /** The next line, without its newline, or null at the end of the stream. */
  async line(): Promise<string | null> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl !== -1) {
        const line = this.buf.subarray(0, nl).toString('utf8');
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      if (!(await this.more())) {
        if (this.buf.length === 0) return null;
        const line = this.buf.toString('utf8');
        this.buf = Buffer.alloc(0);
        return line;
      }
    }
  }

  /** Exactly n bytes, handed to the sink as they arrive. */
  async bytes(n: number, sink: (b: Buffer) => void): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.more())) {
        throw new CliError('The vault closed the connection part way through a file. Nothing was left half-written.');
      }
      const take = Math.min(left, this.buf.length);
      sink(this.buf.subarray(0, take));
      this.buf = this.buf.subarray(take);
      left -= take;
    }
  }
}

// ---- writing into current/ ----

/**
 * Write one file into the backup, by a temporary file in the same directory and
 * a rename. Required by the snapshots: a hardlinked snapshot shares the inode,
 * so writing in place would edit every snapshot that ever linked this file.
 */
function writeVia(dest: string, mode: number, fill: (write: (b: Buffer) => void) => Promise<void>): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', mode & 0o777 ? mode & 0o777 : 0o644);
  return fill((b) => {
    fs.writeSync(fd, b);
  })
    .then(() => {
      fs.closeSync(fd);
      fs.renameSync(tmp, dest);
    })
    .catch((e) => {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      fs.rmSync(tmp, { force: true });
      throw e;
    });
}

/** The same chunked hash the vault computes, so a --checksum run of a large vault
 * costs a fixed amount of memory on this end too. */
function sha256Of(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// ---- snapshots ----

/** The UTC stamp a snapshot directory is named by: 2026-08-19T140311Z. */
function stampNow(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

function stampDate(name: string): Date | null {
  const m = name.match(STAMP_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

function listSnapshots(dir: string): { name: string; at: Date }[] {
  const base = path.join(dir, SNAPSHOTS);
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, at: stampDate(name) }))
    .filter((s): s is { name: string; at: Date } => s.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Every file under dir, as paths relative to it. Directories are not listed. */
function walkFiles(dir: string, rel = '', out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(dir, child, out);
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/**
 * A snapshot of current/ as a directory of hardlinks: one inode per file and no
 * data, and still a servable vault.
 *
 * The link count is checked as it goes. A file in current/ can legitimately be
 * linked once per existing snapshot plus once for current/ itself; more links
 * than that means something outside this backup shares the inode, and hardlinking
 * it would tie the snapshot to a file this program does not control. That is
 * refused rather than recorded, because the failure it guards against - somebody
 * appending to a file under current/ - silently corrupts every snapshot at once.
 */
function takeSnapshot(dir: string, quiet: boolean): { name: string; files: number } {
  const from = path.join(dir, CURRENT);
  const before = listSnapshots(dir).length;
  const name = stampNow();
  const to = path.join(dir, SNAPSHOTS, name);
  if (fs.existsSync(to)) {
    throw new CliError(`A snapshot named ${name} is already there, so this second is left alone.`, EXIT_CONFLICT);
  }
  const files = walkFiles(from);
  const maxLinks = before + 1;
  fs.mkdirSync(to, { recursive: true });
  let linked = 0;
  try {
    for (const rel of files) {
      const src = path.join(from, rel);
      const st = fs.lstatSync(src);
      if (st.nlink > maxLinks) {
        throw new CliError(
          `${rel} in the backup has ${st.nlink} hard links, more than the ${maxLinks} this backup can account for. ` +
            'Something outside the backup shares the file, so snapshotting it is refused. ' +
            'See the note on hardlinks in docs/backup.md.'
        );
      }
      const dest = path.join(to, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.linkSync(src, dest);
      linked++;
    }
  } catch (e) {
    // A half-built snapshot is worse than none: it would be pruned as if it
    // were a copy of the vault at some moment, and it is not.
    fs.rmSync(to, { recursive: true, force: true });
    throw e;
  }
  if (!quiet) console.error(`Snapshot ${name}: ${linked} files hardlinked`);
  return { name, files: linked };
}

function isoWeekKey(d: Date): string {
  // ISO weeks, in UTC: Thursday decides the year, so shift to that week's
  // Thursday and count weeks from the first one.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Grandfather-father-son: the newest snapshot of each of the last N days, weeks,
 * and months is kept, everything else is dropped. Evaluated in UTC, so the
 * decision does not move with the machine's timezone or with daylight saving.
 */
function snapshotsToKeep(snapshots: { name: string; at: Date }[], retention: Retention): Set<string> {
  const keep = new Set<string>();
  const byPeriod = (key: (d: Date) => string, n: number) => {
    if (n <= 0) return;
    const seen = new Set<string>();
    // Newest first, so the first snapshot of a period is the newest in it.
    for (const s of snapshots) {
      const k = key(s.at);
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > n) break;
      keep.add(s.name);
    }
  };
  byPeriod((d) => d.toISOString().slice(0, 10), retention.daily);
  byPeriod(isoWeekKey, retention.weekly);
  byPeriod((d) => d.toISOString().slice(0, 7), retention.monthly);
  // The newest is always kept, whatever the policy says: a retention of zeroes
  // is a policy for how long to keep history, not permission to leave none.
  if (snapshots.length) keep.add(snapshots[0].name);
  return keep;
}

function pruneSnapshots(dir: string, retention: Retention, quiet: boolean): string[] {
  const snapshots = listSnapshots(dir);
  const keep = snapshotsToKeep(snapshots, retention);
  const dropped: string[] = [];
  for (const s of snapshots) {
    if (keep.has(s.name)) continue;
    fs.rmSync(path.join(dir, SNAPSHOTS, s.name), { recursive: true, force: true });
    dropped.push(s.name);
  }
  if (dropped.length && !quiet) {
    console.error(`Pruned ${dropped.length} snapshot${dropped.length === 1 ? '' : 's'}: ${dropped.join(', ')}`);
  }
  return dropped;
}

/** Apparent size: what the files say, before hardlinks are taken into account. */
function apparentSize(dir: string): number {
  let total = 0;
  for (const rel of walkFiles(dir)) {
    try {
      total += fs.statSync(path.join(dir, rel)).size;
    } catch {
      // vanished under us; nothing to add
    }
  }
  return total;
}

function human(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- options ----

const RETENTION_OPTIONS: OptionSpec[] = [
  { name: 'keep-daily', type: 'int', value: '<n>', summary: `Daily snapshots to keep (default ${DEFAULT_RETENTION.daily})` },
  { name: 'keep-weekly', type: 'int', value: '<n>', summary: `Weekly snapshots to keep (default ${DEFAULT_RETENTION.weekly})` },
  {
    name: 'keep-monthly',
    type: 'int',
    value: '<n>',
    summary: `Monthly snapshots to keep (default ${DEFAULT_RETENTION.monthly})`,
  },
];

const EXCLUDE_OPTIONS: OptionSpec[] = [
  { name: 'no-runs', type: 'boolean', summary: 'Leave out workflow run history (<repo>.runs)' },
  { name: 'no-sites', type: 'boolean', summary: 'Leave out published sites (<repo>.site)' },
  { name: 'no-lfs', type: 'boolean', summary: 'Leave out LFS objects on the volume (<repo>.lfs)' },
  { name: 'no-secrets', type: 'boolean', summary: 'Leave out vault.json, runners.json, .secret, and .github-secret' },
];

const QUIET_OPTION: OptionSpec = { name: 'quiet', type: 'boolean', summary: 'Say nothing on success' };

/** The backup directory a command was given, made if it is not there yet. */
function backupDirectory(inv: Invocation, create: boolean): string {
  const given = inv.args[0];
  if (!given) throw new CliError('Which directory? Usage: mochi backup <dir>', EXIT_USAGE);
  const dir = path.resolve(given);
  if (!fs.existsSync(dir)) {
    if (!create) throw new CliError(`No backup directory at ${dir}.`, EXIT_USAGE);
    fs.mkdirSync(dir, { recursive: true });
  } else if (!fs.statSync(dir).isDirectory()) {
    throw new CliError(`${dir} is not a directory.`, EXIT_USAGE);
  }
  return dir;
}

/** An existing backup directory, refusing one that has never been synced. */
function existingBackup(inv: Invocation): { dir: string; state: BackupState } {
  const dir = backupDirectory(inv, false);
  if (!fs.existsSync(statePath(dir))) {
    throw new CliError(
      `${dir} holds no backup (no ${STATE_FILE}). Make one first: mochi backup ${inv.args[0]}`,
      EXIT_USAGE
    );
  }
  return { dir, state: loadState(dir) };
}

/**
 * The exclusions in force. Sticky, because a cron entry is the command and a
 * directory and should not have to repeat them: naming none keeps whatever the
 * last run used, and naming any at all replaces the set, which is how a
 * category can be put back.
 */
function exclusionsFor(inv: Invocation, state: BackupState): string[] {
  const given: string[] = [];
  if (inv.bool('no-runs')) given.push('runs');
  if (inv.bool('no-sites')) given.push('sites');
  if (inv.bool('no-lfs')) given.push('lfs');
  if (inv.bool('no-secrets')) given.push('secrets');
  return given.length ? given : state.excluded;
}

function retentionFor(inv: Invocation, state: BackupState): Retention {
  return {
    daily: inv.int('keep-daily') ?? state.retention.daily,
    weekly: inv.int('keep-weekly') ?? state.retention.weekly,
    monthly: inv.int('keep-monthly') ?? state.retention.monthly,
  };
}

/**
 * Which vault, and with what token. targetFrom does the work, including the
 * --token-stdin rules and the exit codes docs/cli.md promises for them; the URL
 * recorded in backup.json is handed to it as the fallback that outranks the last
 * login, so a backup directory keeps pointing at the vault it is a backup of.
 */
async function targetForBackup(inv: Invocation, state: BackupState): Promise<RemoteTarget> {
  return await targetFrom(inv, { host: state.host || null });
}

// ---- the sync ----

interface SyncSummary {
  host: string;
  dir: string;
  repos: { total: number; cloned: number; fetched: number; skipped: number; removed: number };
  files: { total: number; fetched: number; removed: number; bytes: number };
  lfs: string;
  excluded: string[];
  snapshot: string | null;
  pruned: string[];
}

/**
 * Credentials for a git call against the vault, as a per-invocation config.
 * The backup token is a site admin's, so it may read every repository the
 * manifest names, private ones included; git alone would clone anonymously
 * and be told a private repository is not there. The username half of the
 * Basic pair is a placeholder: the server identifies a token by its value.
 */
function gitAuth(target: RemoteTarget): string[] {
  const basic = Buffer.from(`x-token:${target.token}`, 'utf8').toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

async function syncRepo(
  target: RemoteTarget,
  current: string,
  entry: ManifestRepo,
  quiet: boolean
): Promise<'cloned' | 'fetched'> {
  const dest = path.join(current, entry.path);
  const url = `${target.host}/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.repo)}`;
  if (!isBareRepo(dest)) {
    // A directory that is there but is not a repository is a previous run that
    // died during its clone. Nothing in it is worth keeping.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!quiet) console.error(`Cloning ${entry.collection}/${entry.repo}`);
    await gitOrFail([...gitAuth(target), 'clone', '--mirror', '--', url, dest], `could not clone ${url}`);
    // Reflogs are the one thing git appends to in place, and an appended file
    // corrupts every snapshot that has already hardlinked it. A mirror has no
    // use for them anyway: it holds no work of its own to recover.
    await gitOrFail(['-C', dest, 'config', 'core.logAllRefUpdates', 'false'], 'could not configure the mirror');
    return 'cloned';
  }
  if (!quiet) console.error(`Fetching ${entry.collection}/${entry.repo}`);
  // The refspec is written out, and forced, so that a ref the vault rewound or
  // force-pushed is followed rather than refused: this is a copy of the vault,
  // not a branch with opinions of its own. --prune is what carries a deletion
  // across.
  await gitOrFail(
    [...gitAuth(target), '-C', dest, 'fetch', '--prune', '--', url, '+refs/*:refs/*'],
    `could not fetch ${url}`
  );
  return 'fetched';
}

/**
 * Point the mirror's HEAD where the vault's points. A fetch does not carry HEAD,
 * so without this a repository whose default branch was changed would come back
 * from the backup still naming the old one.
 */
async function syncHead(target: RemoteTarget, current: string, entry: ManifestRepo): Promise<void> {
  const dest = path.join(current, entry.path);
  const url = `${target.host}/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.repo)}`;
  const r = await git([...gitAuth(target), 'ls-remote', '--symref', '--', url, 'HEAD']);
  if (r.code !== 0) return;
  const m = r.out.match(/^ref:\s+(\S+)\s+HEAD$/m);
  if (!m) return;
  const want = m[1];
  const have = await git(['-C', dest, 'symbolic-ref', '--quiet', 'HEAD']);
  if (have.code === 0 && have.out.trim() === want) return;
  await git(['-C', dest, 'symbolic-ref', 'HEAD', want]);
}

/**
 * Whether this file has to be fetched, which is the question the whole
 * incremental half turns on.
 *
 * Size and modification time, as rsync does by default, and against both ends:
 * the vault's timestamp must match the one the last run recorded, and the copy
 * on disk must still be the copy that run wrote. The second half is what
 * repairs a backup that was damaged locally; a comparison against the recorded
 * state alone would call a truncated or edited copy up to date forever.
 *
 * `--checksum` asks the vault for hashes and compares those against the bytes
 * on disk, which is slower, reads everything, and is the mode to reach for when
 * something is suspected rather than the one to run nightly.
 */
function needsFetch(f: ManifestFile, dest: string, known: FileRecord | undefined, checksum: boolean): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(dest);
  } catch {
    return true;
  }
  if (checksum) return !f.sha256 || sha256Of(dest) !== f.sha256;
  if (!known) return true;
  if (st.size !== f.size || known.size !== f.size) return true;
  if (known.mtime !== f.mtime) return true;
  return st.mtimeMs !== known.local;
}

/** The paths to fetch, in chunks that fit the server's caps. */
function chunkPaths(files: ManifestFile[]): ManifestFile[][] {
  const chunks: ManifestFile[][] = [];
  let chunk: ManifestFile[] = [];
  let bytes = 0;
  for (const f of files) {
    // A file over the whole per-request cap travels alone, which the server
    // allows precisely so that a large one is fetchable at all.
    if (f.size > MAX_FETCH_BYTES) {
      if (chunk.length) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunks.push([f]);
      continue;
    }
    if (chunk.length >= MAX_FETCH_PATHS || bytes + f.size > MAX_FETCH_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(f);
    bytes += f.size;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/**
 * Fetch one chunk of files into current/, returning what the vault said was
 * missing. A missing file is not a failure: run history is trimmed while a
 * backup of it is in flight, and the manifest was a walk of a live tree.
 */
async function fetchChunk(
  target: RemoteTarget,
  current: string,
  chunk: ManifestFile[],
  state: BackupState,
  wantHashes: boolean
): Promise<{ bytes: number; missing: string[] }> {
  const byPath = new Map(chunk.map((f) => [f.path, f]));
  let resp: Response;
  try {
    resp = await fetch(`${target.host}/api/backup/fetch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ paths: chunk.map((f) => f.path) }),
    });
  } catch (e) {
    throw new CliError(`Could not reach ${target.host}: ${e instanceof Error ? e.message : e}`);
  }
  if (!resp.ok) {
    let message = `HTTP ${resp.status} from ${target.host}/api/backup/fetch`;
    try {
      const data = JSON.parse(await resp.text()) as { error?: unknown };
      if (data.error) message = String(data.error);
    } catch {
      // not JSON
    }
    throw new CliError(message, exitCodeForStatus(resp.status));
  }
  if (!resp.body) throw new CliError('The vault answered a fetch with no body.');
  const reader = new FrameReader(resp.body as unknown as AsyncIterable<Uint8Array>);
  let bytes = 0;
  let missing: string[] = [];
  for (;;) {
    const line = await reader.line();
    if (line === null) throw new CliError('The vault ended a fetch without saying it had finished.');
    const frame = JSON.parse(line) as { path?: string; size?: number; end?: boolean; missing?: string[] };
    if (frame.end) {
      missing = frame.missing ?? [];
      break;
    }
    const rel = frame.path;
    const size = frame.size;
    if (typeof rel !== 'string' || typeof size !== 'number' || !byPath.has(rel)) {
      throw new CliError(`The vault sent a file this run did not ask for: ${String(rel)}`);
    }
    const wanted = byPath.get(rel) as ManifestFile;
    const dest = path.join(current, ...rel.split('/'));
    const hash = wantHashes ? crypto.createHash('sha256') : null;
    await writeVia(dest, wanted.mode, async (write) => {
      await reader.bytes(size, (b) => {
        if (hash) hash.update(b);
        write(b);
      });
    });
    // The vault's own timestamp, so that the next run's size-and-mtime
    // comparison is against what the vault has rather than against when this
    // run happened.
    const mtime = wanted.mtime / 1000;
    try {
      fs.utimesSync(dest, mtime, mtime);
    } catch {
      // A filesystem that will not take a timestamp costs this backup a
      // re-fetch of the file next time, and nothing else.
    }
    let local = wanted.mtime;
    try {
      local = fs.statSync(dest).mtimeMs;
    } catch {
      // Written a moment ago; if it cannot be stat'ed the next run fetches it.
    }
    const record: FileRecord = { size, mtime: wanted.mtime, local, mode: wanted.mode };
    if (hash) record.sha256 = hash.digest('hex');
    state.files[rel] = record;
    bytes += size;
  }
  return { bytes, missing };
}

/**
 * A mirror's config is one of the files copied from the vault, so after a fetch
 * the mirror's settings are the vault's own, `mochi.forkedFrom` and the
 * `receive.*` protections included. It is copied byte for byte and not edited
 * afterwards, because an edited copy would differ from the vault for good: every
 * later run would fetch it again and `verify` would report it as wrong.
 *
 * That leaves one thing to check rather than to set. A bare repository keeps no
 * reflogs by default, and the snapshots depend on that: a reflog is the one file
 * git appends to in place, and appending to a file under current/ corrupts every
 * snapshot that has hardlinked it. A vault whose config asks for reflogs is
 * therefore reported, and the mirror is left without them.
 */
async function settleMirrorConfigs(current: string, fetched: ManifestFile[], quiet: boolean): Promise<void> {
  const mirrors = new Set(
    fetched.filter((f) => f.path.endsWith('/config')).map((f) => f.path.slice(0, -'/config'.length))
  );
  for (const rel of mirrors) {
    const dir = path.join(current, ...rel.split('/'));
    if (!isBareRepo(dir)) continue;
    const r = await git(['-C', dir, 'config', '--bool', '--get', 'core.logAllRefUpdates']);
    // Nothing set, which for a bare repository means off: the usual case, and
    // the reason this is a check and not a write.
    if (r.code !== 0 || r.out.trim() !== 'true') continue;
    await git(['-C', dir, 'config', 'core.logAllRefUpdates', 'false']);
    if (!quiet) {
      console.error(
        `Warning: ${rel} asks for reflogs in the vault, which snapshots of this backup cannot allow, so the ` +
          'mirror keeps none. Its config will differ from the vault by that one setting.'
      );
    }
  }
}

/** Directories under dir that hold no files at all, deepest first. */
function emptyDirs(dir: string, rel = '', out: string[] = []): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!emptyDirs(dir, child, out)) empty = false;
      else out.push(child);
    } else {
      empty = false;
    }
  }
  return empty;
}

async function syncCmd(inv: Invocation): Promise<void> {
  const json = jsonMode(inv);
  // Two kinds of silence, and they are not the same. --json puts one JSON value
  // on stdout, so the running commentary has to go, but a warning is a
  // diagnostic on stderr and a caller parsing stdout still wants to see it.
  // --quiet means nothing on success, warnings included.
  const quiet = inv.bool('quiet') || json.enabled;
  const warn = !inv.bool('quiet');
  const dir = backupDirectory(inv, true);
  const state = loadState(dir);
  const target = await targetForBackup(inv, state);
  const exclude = exclusionsFor(inv, state);
  const retention = retentionFor(inv, state);
  const checksum = inv.bool('checksum');
  const current = path.join(dir, CURRENT);
  fs.mkdirSync(current, { recursive: true });

  const lock = takeLock(dir, !warn);
  const started = new Date().toISOString();
  const summary: SyncSummary = {
    host: target.host,
    dir,
    repos: { total: 0, cloned: 0, fetched: 0, skipped: 0, removed: 0 },
    files: { total: 0, fetched: 0, removed: 0, bytes: 0 },
    lfs: 'volume',
    excluded: exclude,
    snapshot: null,
    pruned: [],
  };
  try {
    if (!quiet) {
      console.error(`Backing up ${target.host} to ${dir}`);
      // A Fly machine with min_machines_running = 0 is stopped between
      // requests, so the first one waits for it to boot. Said plainly, because
      // a client that looks hung is a client someone interrupts.
      console.error('Asking for the manifest (a machine that sleeps when idle takes a few seconds to wake)');
    }
    const manifest = await fetchManifest(target, exclude, checksum);
    summary.lfs = manifest.lfs;
    summary.repos.total = manifest.repos.length;
    summary.files.total = manifest.files.size;
    state.host = target.host;
    state.lfs = manifest.lfs;
    state.excluded = exclude;
    state.retention = retention;

    if (manifest.lfs === 'bucket' && warn) {
      console.error(
        'Warning: this vault keeps its Git LFS objects in a bucket, so they are not in the vault and not in ' +
          'this backup. Back the bucket up alongside it, e.g. rclone sync; see docs/backup.md.'
      );
    }

    // Repositories, by mirror. A repository whose refs digest matches the one
    // the last run recorded is skipped entirely: no handshake, no request, and
    // nothing for a sleeping machine to wake up for.
    for (const entry of manifest.repos) {
      const known = state.repos[entry.path];
      const dest = path.join(current, entry.path);
      if (known && known.refs === entry.refs && isBareRepo(dest)) {
        summary.repos.skipped++;
        continue;
      }
      const how = await syncRepo(target, current, entry, quiet);
      await syncHead(target, current, entry);
      if (how === 'cloned') summary.repos.cloned++;
      else summary.repos.fetched++;
      state.repos[entry.path] = { refs: entry.refs };
    }

    // A mirror whose repository is gone from the vault goes too. It survives in
    // whatever snapshots hold it, which is the whole reason retention is worth
    // configuring.
    const live = new Set(manifest.repos.map((r) => r.path));
    for (const known of Object.keys(state.repos)) {
      if (live.has(known)) continue;
      // The recorded paths come from manifests this command already refused to
      // accept a climbing path from, so this holds for anything written by a
      // version that had that check. A state file from before it, or one edited
      // by hand, is the case worth refusing to delete through.
      if (!isVaultRelative(known)) {
        delete state.repos[known];
        continue;
      }
      fs.rmSync(path.join(current, known), { recursive: true, force: true });
      delete state.repos[known];
      summary.repos.removed++;
      if (!quiet) console.error(`Removed ${known}, which the vault no longer holds`);
    }

    // Files.
    const changed: ManifestFile[] = [];
    for (const f of manifest.files.values()) {
      const dest = path.join(current, ...f.path.split('/'));
      if (needsFetch(f, dest, state.files[f.path], checksum)) changed.push(f);
    }
    for (const chunk of chunkPaths(changed)) {
      const r = await fetchChunk(target, current, chunk, state, checksum);
      summary.files.fetched += chunk.length - r.missing.length;
      summary.files.bytes += r.bytes;
      for (const gone of r.missing) {
        delete state.files[gone];
        if (!quiet) console.error(`${gone} vanished from the vault while this run was reading it`);
      }
    }
    // A mirror's config is one of the files the manifest names, so the copy just
    // written is the vault's, which says nothing about reflogs. A bare
    // repository keeps none by default, but the snapshots depend on that being
    // true rather than merely usual, so it is stated on the mirror itself.
    await settleMirrorConfigs(current, changed, !warn);

    // The manifest is authoritative for deletions: a file in current/ that it
    // does not list is gone from the vault, or is a category this run excludes.
    // Either way it does not belong in a copy of what the vault holds now.
    const mirrors = [...live].map((p) => p.split('/').join(path.sep));
    const insideMirror = (rel: string) => mirrors.some((m) => rel === m || rel.startsWith(m + path.sep));
    for (const rel of walkFiles(current)) {
      const asPath = rel.split('/').join(path.sep);
      if (insideMirror(asPath)) continue;
      if (manifest.files.has(rel)) continue;
      fs.rmSync(path.join(current, asPath), { force: true });
      delete state.files[rel];
      summary.files.removed++;
    }
    // Records for files the manifest no longer lists, whether or not a copy was
    // still on disk to remove.
    for (const rel of Object.keys(state.files)) {
      if (!manifest.files.has(rel)) delete state.files[rel];
    }
    const empties: string[] = [];
    emptyDirs(current, '', empties);
    for (const rel of empties.sort((a, b) => b.length - a.length)) {
      if (insideMirror(rel.split('/').join(path.sep))) continue;
      try {
        fs.rmdirSync(path.join(current, ...rel.split('/')));
      } catch {
        // not empty after all, or already gone
      }
    }

    // One cheap mitigation for the fact that a backup is a walk of a live tree:
    // ask again, and re-fetch anything whose size or timestamp moved while this
    // run was working. It closes the window for everything except a file
    // written twice during the same run.
    const again = await fetchManifest(target, exclude, checksum);
    const moved: ManifestFile[] = [];
    for (const f of again.files.values()) {
      const dest = path.join(current, ...f.path.split('/'));
      if (needsFetch(f, dest, state.files[f.path], checksum)) moved.push(f);
    }
    if (moved.length) {
      if (!quiet) console.error(`${moved.length} file(s) changed during the run; fetching them again`);
      for (const chunk of chunkPaths(moved)) {
        const r = await fetchChunk(target, current, chunk, state, checksum);
        summary.files.fetched += chunk.length - r.missing.length;
        summary.files.bytes += r.bytes;
        for (const gone of r.missing) delete state.files[gone];
      }
      await settleMirrorConfigs(current, moved, !warn);
    }

    state.runs.push({
      started,
      finished: new Date().toISOString(),
      files: summary.files.fetched,
      bytes: summary.files.bytes,
      repos: summary.repos.cloned + summary.repos.fetched,
      deleted: summary.files.removed + summary.repos.removed,
    });
    state.runs = state.runs.slice(-KEEP_RUNS);
    saveState(dir, state);

    if (inv.bool('snapshot')) {
      summary.snapshot = takeSnapshot(dir, quiet).name;
      summary.pruned = pruneSnapshots(dir, retention, quiet);
    }
  } catch (e) {
    // A failed run is recorded too. "It has been failing since Tuesday" is the
    // thing a backup most needs to be able to say.
    state.runs.push({
      started,
      finished: new Date().toISOString(),
      files: summary.files.fetched,
      bytes: summary.files.bytes,
      repos: summary.repos.cloned + summary.repos.fetched,
      deleted: summary.files.removed + summary.repos.removed,
      error: e instanceof Error ? e.message : String(e),
    });
    state.runs = state.runs.slice(-KEEP_RUNS);
    try {
      saveState(dir, state);
    } catch {
      // Reporting the original failure matters more than recording it.
    }
    throw e;
  } finally {
    lock.release();
  }

  if (json.enabled) {
    printJson(pickObject(summary as unknown as Record<string, unknown>, json.fields));
    return;
  }
  if (quiet) return;
  const r = summary.repos;
  console.log(
    `${r.total} repositories: ${r.cloned} cloned, ${r.fetched} fetched, ${r.skipped} unchanged` +
      (r.removed ? `, ${r.removed} removed` : '')
  );
  console.log(
    `${summary.files.total} files: ${summary.files.fetched} fetched (${human(summary.files.bytes)})` +
      (summary.files.removed ? `, ${summary.files.removed} removed` : '')
  );
  if (summary.snapshot) console.log(`Snapshot ${summary.snapshot}`);
  console.log('');
  console.log(`Serve this backup to look at it, or to stand the vault back up:`);
  console.log(`  mochi serve ${path.join(dir, CURRENT)}`);
}

// ---- list, prune, verify ----

function listCmd(inv: Invocation): void {
  const { dir, state } = existingBackup(inv);
  const snapshots = listSnapshots(dir).map((s) => ({
    name: s.name,
    at: s.at.toISOString(),
    bytes: apparentSize(path.join(dir, SNAPSHOTS, s.name)),
  }));
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(
      pickObject(
        {
          host: state.host,
          dir,
          excluded: state.excluded,
          retention: state.retention,
          current: { bytes: apparentSize(path.join(dir, CURRENT)) },
          snapshots,
          runs: state.runs,
        },
        json.fields
      )
    );
    return;
  }
  console.log(`${dir}`);
  console.log(`  vault      ${state.host || '(unknown)'}`);
  console.log(`  current    ${human(apparentSize(path.join(dir, CURRENT)))} apparent`);
  console.log(`  excluded   ${state.excluded.length ? state.excluded.join(', ') : 'nothing'}`);
  console.log(
    `  retention  ${state.retention.daily} daily, ${state.retention.weekly} weekly, ${state.retention.monthly} monthly`
  );
  const last = state.runs[state.runs.length - 1];
  if (last) {
    console.log(
      `  last run   ${last.finished}${last.error ? ` FAILED: ${last.error}` : ` (${human(last.bytes)} in ${last.files} files)`}`
    );
  }
  console.log('');
  if (snapshots.length === 0) {
    console.log('No snapshots. `mochi backup <dir> --snapshot` takes one after a sync.');
    return;
  }
  // Apparent size rather than disk use: a snapshot is hardlinked, so what it
  // costs on disk is close to nothing and what it holds is this.
  printTable([['SNAPSHOT', 'TAKEN', 'APPARENT'], ...snapshots.map((s) => [s.name, s.at, human(s.bytes)])]);
}

function pruneCmd(inv: Invocation): void {
  const { dir, state } = existingBackup(inv);
  const retention = retentionFor(inv, state);
  const json = jsonMode(inv);
  const lock = takeLock(dir, inv.bool('quiet') || json.enabled);
  let dropped: string[];
  try {
    dropped = pruneSnapshots(dir, retention, true);
    state.retention = retention;
    saveState(dir, state);
  } finally {
    lock.release();
  }
  const kept = listSnapshots(dir).map((s) => s.name);
  if (json.enabled) {
    printJson(pickObject({ dir, pruned: dropped, kept, retention }, json.fields));
    return;
  }
  if (inv.bool('quiet')) return;
  console.log(
    dropped.length ? `Pruned ${dropped.length}: ${dropped.join(', ')}` : 'Nothing to prune under this retention.'
  );
  console.log(`${kept.length} snapshot${kept.length === 1 ? '' : 's'} kept.`);
}

async function verifyCmd(inv: Invocation): Promise<void> {
  const { dir, state } = existingBackup(inv);
  const json = jsonMode(inv);
  const quiet = inv.bool('quiet') || json.enabled;
  const current = path.join(dir, CURRENT);
  const target = await targetForBackup(inv, state);
  const problems: { path: string; problem: string }[] = [];

  // Each mirror is a real repository, so git can be asked the question rather
  // than reimplemented. --connectivity-only skips re-hashing every blob, which
  // turns an hour into a minute and still catches the failure that matters: an
  // object the history refers to and the backup does not have.
  const repos = Object.keys(state.repos).sort();
  for (const rel of repos) {
    const repoDir = path.join(current, rel);
    if (!isBareRepo(repoDir)) {
      problems.push({ path: rel, problem: 'not a repository' });
      continue;
    }
    if (!quiet) console.error(`Checking ${rel}`);
    const r = await git(['-C', repoDir, 'fsck', '--connectivity-only', '--no-progress']);
    if (r.code !== 0) problems.push({ path: rel, problem: `git fsck: ${r.out.trim().split('\n')[0]}` });
  }

  // The files, against hashes the vault computes now. This is the part a
  // size-and-mtime sync cannot check on its own.
  if (!quiet) console.error('Asking the vault for hashes');
  const manifest = await fetchManifest(target, state.excluded, true);
  for (const f of manifest.files.values()) {
    const dest = path.join(current, ...f.path.split('/'));
    let st: fs.Stats;
    try {
      st = fs.statSync(dest);
    } catch {
      problems.push({ path: f.path, problem: 'missing from the backup' });
      continue;
    }
    if (st.size !== f.size) {
      problems.push({ path: f.path, problem: `size ${st.size}, the vault has ${f.size}` });
      continue;
    }
    if (f.sha256 && sha256Of(dest) !== f.sha256) {
      problems.push({ path: f.path, problem: 'contents differ from the vault' });
    }
  }
  const mirrors = repos.map((p) => p.split('/').join(path.sep));
  const insideMirror = (rel: string) => mirrors.some((m) => rel === m || rel.startsWith(m + path.sep));
  for (const rel of walkFiles(current)) {
    const asPath = rel.split('/').join(path.sep);
    if (insideMirror(asPath)) continue;
    if (!manifest.files.has(rel)) problems.push({ path: rel, problem: 'in the backup, not in the vault' });
  }
  for (const entry of manifest.repos) {
    if (!state.repos[entry.path]) problems.push({ path: entry.path, problem: 'in the vault, not in the backup' });
  }

  // The hardlink invariant the snapshots rest on. A file with more links than
  // current/ plus the snapshots can account for is shared with something
  // outside this backup, which means a snapshot could be changed from outside.
  const maxLinks = listSnapshots(dir).length + 1;
  for (const rel of walkFiles(current)) {
    try {
      const st = fs.lstatSync(path.join(current, ...rel.split('/')));
      if (st.nlink > maxLinks) problems.push({ path: rel, problem: `${st.nlink} hard links, more than ${maxLinks}` });
    } catch {
      // walked a moment ago and gone now; the file checks above already say so
    }
  }

  if (json.enabled) {
    printJson(
      pickObject({ dir, host: target.host, repos: repos.length, files: manifest.files.size, problems }, json.fields)
    );
  } else if (problems.length === 0) {
    if (!inv.bool('quiet')) {
      console.log(`${repos.length} mirrors and ${manifest.files.size} files check out against ${target.host}.`);
    }
  } else {
    for (const p of problems) console.log(`${p.path}: ${p.problem}`);
    console.log('');
    console.log(`${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
  }
  if (problems.length) {
    throw new CliError(`${problems.length} problem${problems.length === 1 ? '' : 's'} in ${dir}.`, EXIT_FAIL);
  }
}

// ---- what a machine knows about its backups ----

/**
 * Where this machine's backup directories are remembered, so that `mochi
 * deploy fly show` can say whether the app it is describing has one. It is a
 * convenience and nothing depends on it: the backup itself is entirely
 * described by its own backup.json.
 */
export function backupsIndexPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'mochi', 'backups.json');
}

export function knownBackups(): { dir: string; host: string }[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(backupsIndexPath(), 'utf8')) as { backups?: unknown };
    if (!Array.isArray(parsed.backups)) return [];
    return parsed.backups.filter(
      (b): b is { dir: string; host: string } =>
        typeof b === 'object' && b !== null && typeof (b as { dir: unknown }).dir === 'string'
    );
  } catch {
    return [];
  }
}

function rememberBackup(dir: string, host: string): void {
  try {
    const others = knownBackups().filter((b) => b.dir !== dir && fs.existsSync(path.join(b.dir, STATE_FILE)));
    const file = backupsIndexPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ backups: [...others, { dir, host }] }, null, 2) + '\n');
  } catch {
    // A machine with no writable configuration directory still has a working
    // backup; only `deploy fly show` is any the wiser.
  }
}

/**
 * What to say about a vault's backup on this machine, if it has one. Several
 * hosts may name one vault, since a Fly app with a domain of its own answers on
 * both, and the backup records whichever name it was given.
 */
export function backupLineFor(hosts: string | string[]): string | null {
  const wanted = new Set((Array.isArray(hosts) ? hosts : [hosts]).map((h) => h.replace(/\/+$/, '')));
  for (const b of knownBackups()) {
    if (!wanted.has(b.host.replace(/\/+$/, ''))) continue;
    const state = loadState(b.dir);
    const last = state.runs[state.runs.length - 1];
    if (!last) return `${b.dir} (never run)`;
    const when = last.finished.slice(0, 10);
    return last.error ? `${b.dir} (last run ${when} FAILED)` : `${b.dir} (last run ${when})`;
  }
  return null;
}

// ---- the commands ----

const COMMON: OptionSpec[] = [JSON_OPTION, QUIET_OPTION, ...TARGET_OPTIONS];

export const backupCommands: Command[] = [
  {
    path: ['backup'],
    summary: 'Copy a whole vault to a directory on this machine, incrementally',
    description: `A vault is a directory, so a backup of one is a directory too, and this makes it
over HTTP: it needs no shell on the server, no flyctl, and no rsync at the far
end, so it works the same against a Fly app, a VPS, a Docker deployment, and
127.0.0.1:3000.

  <dir>/current      a servable vault. Restoring is: mochi serve <dir>/current
  <dir>/snapshots    hardlinked copies, each one also a servable vault
  <dir>/backup.json  which vault, what is left out, and how each run went

Repositories come across as mirrors, so a second run moves only the objects it
does not have and skips a repository nothing was pushed to. Everything beside
them - issues, pull requests, releases, sites, run history, LFS objects on the
volume, and the vault's state files - is compared by size and modification time
and fetched only where it differs.

The token needs to belong to a site admin, because the copy includes
vault.json. The vault URL, the exclusions, and the retention policy are recorded
in backup.json, so a cron entry is this command and a directory.

There is no vault-wide point-in-time image: the server holds no lock a client
could take, so a run is a walk of a live tree and can catch a mixed vintage.
Every individual file in a backup is one that really existed. See docs/backup.md.

Related: mochi backup list, verify, prune.`,
    args: [{ name: 'dir', required: true }],
    options: [
      { name: 'snapshot', type: 'boolean', summary: 'Take a snapshot after a successful sync, then prune' },
      ...RETENTION_OPTIONS,
      ...EXCLUDE_OPTIONS,
      { name: 'checksum', type: 'boolean', summary: 'Compare hashes rather than size and modification time' },
      ...COMMON,
    ],
    async run(inv) {
      await syncCmd(inv);
      const dir = path.resolve(inv.args[0]);
      rememberBackup(dir, loadState(dir).host);
    },
  },
  {
    path: ['backup', 'list'],
    summary: "Show a backup's snapshots, and how the last run went",
    args: [{ name: 'dir', required: true }],
    options: [JSON_OPTION],
    run: listCmd,
  },
  {
    path: ['backup', 'verify'],
    summary: 'Check a backup against the vault, and its mirrors against git',
    description: `Runs git fsck --connectivity-only over every mirror, asks the vault for hashes,
and reports anything missing, extra, or different. Exits non-zero when there is
something to report, so it can be run from cron.`,
    args: [{ name: 'dir', required: true }],
    options: [...COMMON],
    run: verifyCmd,
  },
  {
    path: ['backup', 'prune'],
    summary: 'Apply the retention policy to the snapshots, without syncing',
    description: `Grandfather-father-son: the newest snapshot of each of the last N days, weeks,
and months is kept and the rest are removed, evaluated in UTC. The newest
snapshot is always kept.

A snapshot pins the packfiles that were current when it was taken, so a repack
in a busy repository leaves the old pack on disk until the last snapshot
referring to it is pruned. This is what reclaims that space.`,
    args: [{ name: 'dir', required: true }],
    options: [...RETENTION_OPTIONS, JSON_OPTION, QUIET_OPTION],
    run: pruneCmd,
  },
];
