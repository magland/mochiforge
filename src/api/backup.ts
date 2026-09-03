import { Express, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EGRESS_FILE } from '../egress';
import { execGit } from '../git';
import { GITHUB_SECRET_FILE } from '../githubauth';
import { AuthLimiter, BUSY_RETRY_SECONDS, Gates } from '../limit';
import { COLLECTIONS_DIR, REPOS_DIR, collectionDir, collectionsDir, reposDir } from '../layout';
import { containedIn } from '../ops';
import { isSiteAdmin } from '../perms';
import { isBareRepo, isValidName } from '../scan';
import { createLfsStore } from '../lfsstore';
import { apiError, requireApiAuth } from './auth';

// The two routes a backup needs, and nothing else.
//
// A vault is a directory, so most of it is copied by copying files. The half
// that already has a good incremental transport is the repositories: a mirror
// and `git fetch` move only the objects the far end lacks, over the anonymous
// smart-HTTP endpoint every clone already uses. What had no transport at all is
// everything beside the repositories - issues, pull requests, releases, sites,
// run history, LFS objects on the volume, and the state files at the vault root
// - which on a Fly volume cannot be reached without a shell.
//
// So: a manifest saying what is there, and a bulk read of named files. Both are
// deliberately dumb. There is no tar, no archive format, and no server-side
// notion of what a previous backup held; the client decides what it needs by
// comparing the manifest against what it already has, which is what keeps the
// server side to one file and the whole protocol inspectable with curl.
//
// See docs/backup.md for the client's half and for what a backup does not
// promise.

/**
 * The state files at the vault root. Nothing else there belongs to a vault.
 *
 * Named from the modules that write them where a module exports the name,
 * so that a file the server starts writing under a new name is a compile
 * error here rather than a file the backup quietly leaves behind. That is how
 * `.github-secret` was lost for a while: config.json kept the client id, so a
 * restored vault offered GitHub sign-in and failed every attempt at the
 * token exchange, and `mochi backup verify` had nothing to say about it.
 */
export const ROOT_FILES = [
  'vault.json',
  'config.json',
  'runners.json',
  'redirects.json',
  'domains.json',
  EGRESS_FILE,
  '.secret',
  GITHUB_SECRET_FILE,
];

/** Which of those `--no-secrets` leaves out. config.json holds no credential. */
export const SECRET_FILES = new Set(['vault.json', 'runners.json', '.secret', GITHUB_SECRET_FILE]);

/**
 * The files inside a bare repository that git's own transport leaves behind. A
 * mirror clone carries objects and refs; it writes its own default description
 * and its own config, so a backup that relied on it alone would lose every
 * repository's description, its `mochi.forkedFrom`, and the `receive.*`
 * settings a repository is created with. mochi.json is the worst of the
 * set to lose: it holds the private flag and the collaborators, so a
 * restore without it would serve every private repository as public.
 * site.json is the site's enabled switch, source, and label, which a restore
 * without it would leave every site dark.
 */
const REPO_FILES = ['description', 'config', 'mochi.json', 'site.json'];

/** What a caller may ask to have left out, as `?exclude=runs,sites`. */
const EXCLUDABLE = new Set(['runs', 'sites', 'lfs', 'secrets']);

/** At most this many paths in one fetch, so a request cannot become a whole vault. */
const MAX_FETCH_PATHS = 2000;

/**
 * At most this many bytes of file in one fetch. A request naming a single path
 * is exempt, since otherwise a file larger than the cap could never be fetched
 * at all; the cap is there to bound how much one request holds open, and one
 * file is the smallest a request can be.
 */
const MAX_FETCH_BYTES = 64 * 1024 * 1024;

/** A file writeFileAtomic is in the middle of writing. Not part of the vault yet. */
function isTempName(name: string): boolean {
  return /\.tmp-\d+$/.test(name);
}

/**
 * A file's SHA-256, read in chunks. Bounded memory rather than one Buffer per
 * file: this runs on a 512mb machine, and an LFS object on the volume can be
 * gigabytes, so reading a whole file to hash it would be the one place a backup
 * could take the vault down.
 */
function sha256File(file: string): string {
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

/**
 * Write, waiting for the socket when it is full. A vault with a hundred
 * thousand files produces a manifest larger than any socket buffer, and the
 * point of streaming it is that the 512mb machine serving it never holds the
 * whole thing.
 */
async function send(res: Response, chunk: string | Buffer): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false;
  if (res.write(chunk)) return true;
  await new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
  return !res.writableEnded && !res.destroyed;
}

/**
 * The vault-relative path a caller named, as an absolute path, or null if it is
 * not a path inside the vault. Refused rather than normalized: a caller sending
 * `..` or an absolute path has a bug, and answering it with some other file
 * would hide the bug rather than the file.
 *
 * Containment is re-checked against the real path when the file is opened,
 * which is what catches a symlink pointing out of the vault.
 */
function vaultPath(root: string, p: unknown): string | null {
  if (typeof p !== 'string' || p === '' || p.length > 1024) return null;
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/')) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return path.join(root, ...segments);
}

interface WalkOptions {
  hash: boolean;
  exclude: Set<string>;
}

interface Counts {
  files: number;
  bytes: number;
  repos: number;
}

/** One `kind:"file"` line, or null for something that is not a file of the vault. */
function fileLine(root: string, abs: string, opts: WalkOptions): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  // A symlink is not copied. A vault does not contain any, and following one
  // would make the backup's shape depend on what it points at.
  if (!st.isFile()) return null;
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const line: Record<string, unknown> = {
    kind: 'file',
    path: rel,
    size: st.size,
    mtime: Math.floor(st.mtimeMs),
    mode: st.mode & 0o777,
  };
  if (opts.hash) {
    try {
      line.sha256 = sha256File(abs);
    } catch {
      return null;
    }
  }
  return JSON.stringify(line);
}

/** How many bytes a bare repository occupies, as git already counts it. */
async function repoBytes(dir: string): Promise<number> {
  try {
    const out = (await execGit(dir, ['count-objects', '-v'])).toString();
    let kib = 0;
    for (const line of out.split('\n')) {
      const m = line.match(/^(size|size-pack):\s*(\d+)/);
      if (m) kib += parseInt(m[2], 10);
    }
    return kib * 1024;
  } catch {
    return 0;
  }
}

/**
 * A digest over every ref, what it points at, and where HEAD points, which
 * changes on any push and on nothing else. A repository whose digest a client
 * already has is one it can skip without a handshake, and skipping is what keeps
 * a nightly backup of a hundred quiet repositories to a single request.
 *
 * HEAD is in the digest because it is the default branch, and changing it moves
 * no ref at all: a digest over the refs alone would let a repository whose
 * default branch was changed be skipped forever, and the backup would keep
 * naming the old one. It is read from the file rather than asked of git, since
 * this runs once per repository per manifest.
 */
async function refsDigest(dir: string): Promise<string> {
  const out = await execGit(dir, ['for-each-ref', '--format=%(refname) %(objectname)']);
  let head = '';
  try {
    head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
  } catch {
    // A repository with no readable HEAD is odd but not this function's problem.
  }
  return crypto.createHash('sha256').update(out).update(`HEAD ${head}\n`).digest('hex');
}

export function registerBackupApi(app: Express, root: string, limiter: AuthLimiter, gates: Gates): void {
  // The manifest necessarily names vault.json and .secret, and a fetch will
  // hand over their contents, so nothing narrower than site admin is enough.
  // A restricted (token-scoped) token is refused by isSiteAdmin whatever its
  // user's standing, which is the behaviour wanted here.
  function requireVaultAdmin(req: Request, res: Response) {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return null;
    if (!isSiteAdmin(auth)) {
      apiError(res, 403, 'a backup needs a site admin, with an unrestricted token');
      return null;
    }
    return auth;
  }

  function sendBusy(res: Response): void {
    res.setHeader('Retry-After', String(BUSY_RETRY_SECONDS));
    apiError(res, 503, 'the vault is busy; try again shortly');
  }

  function exclusions(req: Request, res: Response): Set<string> | null {
    const raw = typeof req.query.exclude === 'string' ? req.query.exclude : '';
    const names = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const unknown = names.filter((n) => !EXCLUDABLE.has(n));
    if (unknown.length) {
      apiError(res, 400, `unknown exclusion${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; one of: ${[...EXCLUDABLE].join(', ')}`);
      return null;
    }
    return new Set(names);
  }

  app.get('/api/backup/manifest', async (req, res) => {
    if (!requireVaultAdmin(req, res)) return;
    const exclude = exclusions(req, res);
    if (!exclude) return;
    const opts: WalkOptions = { hash: req.query.hash === '1', exclude };

    // The same gate a file listing and a source archive hold, so that a backup
    // in progress cannot crowd out a push.
    const release = await gates.tree.enter();
    if (!release) {
      sendBusy(res);
      return;
    }
    res.type('application/x-ndjson');
    // A manifest is a walk of a live tree and is never worth a cache.
    res.set('Cache-Control', 'no-store');
    const counts: Counts = { files: 0, bytes: 0, repos: 0 };
    try {
      // Which LFS backend is live is decided from the environment, so the
      // client cannot infer it from the vault's files. A vault using a bucket
      // has objects that are not in the vault at all, and a backup that did not
      // say so would look complete while missing them.
      let lfs = 'volume';
      try {
        lfs = createLfsStore(root).store.kind === 's3' ? 'bucket' : 'volume';
      } catch {
        // A partially configured bucket throws at startup, so a serving vault
        // never reaches this; report the honest "unknown" if it somehow does.
        lfs = 'unknown';
      }
      if (!(await send(res, JSON.stringify({ kind: 'vault', lfs, excluded: [...exclude] }) + '\n'))) return;

      for (const name of ROOT_FILES) {
        if (exclude.has('secrets') && SECRET_FILES.has(name)) continue;
        const line = fileLine(root, path.join(root, name), opts);
        if (!line) continue;
        counts.files++;
        counts.bytes += JSON.parse(line).size as number;
        if (!(await send(res, line + '\n'))) return;
      }

      const walkFiles = async (dir: string): Promise<boolean> => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return true;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.isSymbolicLink() || isTempName(e.name)) continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!(await walkFiles(abs))) return false;
            continue;
          }
          const line = fileLine(root, abs, opts);
          if (!line) continue;
          counts.files++;
          counts.bytes += JSON.parse(line).size as number;
          if (!(await send(res, line + '\n'))) return false;
        }
        return true;
      };

      let collections: fs.Dirent[];
      try {
        collections = fs.readdirSync(collectionsDir(root), { withFileTypes: true });
      } catch {
        collections = [];
      }
      for (const c of collections.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!c.isDirectory() || c.isSymbolicLink() || !isValidName(c.name)) continue;

        // Whatever the collection keeps of its own, beside its repositories.
        // There is nothing there today; it is walked as ordinary files so that
        // the first thing put there is backed up without this being revisited.
        let ownEntries: fs.Dirent[];
        try {
          ownEntries = fs.readdirSync(collectionDir(root, c.name), { withFileTypes: true });
        } catch {
          ownEntries = [];
        }
        for (const e of ownEntries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.name === REPOS_DIR || e.isSymbolicLink() || isTempName(e.name)) continue;
          const abs = path.join(collectionDir(root, c.name), e.name);
          if (e.isDirectory()) {
            if (!(await walkFiles(abs))) return;
            continue;
          }
          const line = fileLine(root, abs, opts);
          if (!line) continue;
          counts.files++;
          counts.bytes += JSON.parse(line).size as number;
          if (!(await send(res, line + '\n'))) return;
        }

        const repos = reposDir(root, c.name);
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(repos, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.isSymbolicLink() || isTempName(e.name)) continue;
          const abs = path.join(repos, e.name);
          const rel = `${COLLECTIONS_DIR}/${c.name}/${REPOS_DIR}/${e.name}`;
          if (!e.isDirectory()) {
            const line = fileLine(root, abs, opts);
            if (!line) continue;
            counts.files++;
            counts.bytes += JSON.parse(line).size as number;
            if (!(await send(res, line + '\n'))) return;
            continue;
          }
          // A repository's contents are not enumerated: git is their
          // transport, and listing a hundred thousand loose objects as files
          // would be both enormous and the wrong way to move them.
          if (isValidName(e.name) && isBareRepo(abs)) {
            let refs: string;
            try {
              refs = await refsDigest(abs);
            } catch {
              // A directory that looks like a repository but cannot be read is
              // reported as nothing rather than failing the whole manifest.
              continue;
            }
            counts.repos++;
            const line = JSON.stringify({
              kind: 'repo',
              path: rel,
              collection: c.name,
              repo: e.name.replace(/\.git$/, ''),
              refs,
              packed: await repoBytes(abs),
            });
            if (!(await send(res, line + '\n'))) return;
            // A few files inside the repository are named all the same,
            // because a mirror clone does not carry them and they are not git
            // data: the description, which every listing shows; the config,
            // which holds the fork parent and the receive protections a
            // repository was created with; and mochi.json, which holds
            // the private flag and the collaborators. Restoring a vault whose
            // private repositories had come back public would be far worse
            // than a poor restore.
            for (const inside of REPO_FILES) {
              const fileEntry = fileLine(root, path.join(abs, inside), opts);
              if (!fileEntry) continue;
              counts.files++;
              counts.bytes += JSON.parse(fileEntry).size as number;
              if (!(await send(res, fileEntry + '\n'))) return;
            }
            continue;
          }
          if (exclude.has('runs') && e.name.endsWith('.runs')) continue;
          if (exclude.has('sites') && e.name.endsWith('.site')) continue;
          if (exclude.has('lfs') && e.name.endsWith('.lfs')) continue;
          if (!(await walkFiles(abs))) return;
        }
      }
      await send(res, JSON.stringify({ kind: 'end', ...counts }) + '\n');
      res.end();
    } catch (e) {
      // The status is long gone by the time a walk fails, so the failure is
      // reported in the stream: a client that never saw an "end" line knows the
      // manifest is incomplete, and this says why.
      console.error(e);
      await send(res, JSON.stringify({ kind: 'error', error: 'the manifest could not be completed' }) + '\n');
      res.end();
    } finally {
      release();
    }
  });

  // The bytes of the paths named, as a length-prefixed sequence.
  //
  // Not a tar. A length-prefixed stream needs no tar on either side, has no
  // symlink, ownership, or path-traversal edge cases to get wrong, and lets a
  // file that vanished between the manifest and the fetch be reported in the
  // end line rather than aborting the transfer. That last case is not
  // hypothetical: run history is trimmed by CI retention while a backup of it
  // is in flight.
  app.post('/api/backup/fetch', async (req, res) => {
    if (!requireVaultAdmin(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const paths = body.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      apiError(res, 400, '"paths" must be a non-empty list of vault-relative paths');
      return;
    }
    if (paths.length > MAX_FETCH_PATHS) {
      apiError(res, 400, `at most ${MAX_FETCH_PATHS} paths per request; ask for fewer`);
      return;
    }
    const absolute: string[] = [];
    for (const p of paths) {
      const abs = vaultPath(root, p);
      if (!abs) {
        apiError(res, 400, `not a path inside the vault: ${typeof p === 'string' ? p : typeof p}`);
        return;
      }
      absolute.push(abs);
    }

    let rootReal: string;
    try {
      rootReal = fs.realpathSync(root);
    } catch {
      apiError(res, 500, 'the vault directory could not be read');
      return;
    }

    // Sized before anything is sent, so that a request over the cap is a 400
    // naming the limit rather than a truncated stream. A path that has since
    // vanished simply weighs nothing and is reported as missing below.
    let total = 0;
    for (const abs of absolute) {
      try {
        total += fs.statSync(abs).size;
      } catch {
        // missing; reported in the end line
      }
    }
    if (absolute.length > 1 && total > MAX_FETCH_BYTES) {
      apiError(
        res,
        400,
        `the paths named come to ${total} bytes, over the ${MAX_FETCH_BYTES} byte limit for one request; ask for fewer`
      );
      return;
    }

    const release = await gates.tree.enter();
    if (!release) {
      sendBusy(res);
      return;
    }
    res.type('application/octet-stream');
    res.set('Cache-Control', 'no-store');
    const missing: string[] = [];
    try {
      for (let i = 0; i < absolute.length; i++) {
        const abs = absolute[i];
        const rel = paths[i] as string;
        // The size is taken from the open descriptor rather than from a stat
        // before it, so the length prefix cannot disagree with the bytes that
        // follow. Everything in a vault is written by rename, so an open
        // descriptor's contents no longer change.
        let fd: number;
        try {
          const st = fs.lstatSync(abs);
          if (!st.isFile()) throw new Error('not a file');
          fd = fs.openSync(abs, 'r');
        } catch {
          missing.push(rel);
          continue;
        }
        let size: number;
        try {
          size = fs.fstatSync(fd).size;
          // Checked with the descriptor in hand: a symlink that was swapped in
          // between the lstat and the open resolves here, not there.
          if (!containedIn(rootReal, abs)) throw new Error('outside the vault');
        } catch {
          fs.closeSync(fd);
          missing.push(rel);
          continue;
        }
        if (!(await send(res, JSON.stringify({ path: rel, size }) + '\n'))) {
          fs.closeSync(fd);
          return;
        }
        let sent = 0;
        const stream = fs.createReadStream('', { fd, autoClose: true, highWaterMark: 1 << 20 });
        try {
          for await (const chunk of stream) {
            const buf = chunk as Buffer;
            // Never more than the declared length, whatever the file does.
            const room = size - sent;
            const piece = buf.length > room ? buf.subarray(0, room) : buf;
            if (piece.length === 0) break;
            sent += piece.length;
            if (!(await send(res, piece))) {
              stream.destroy();
              return;
            }
          }
        } catch {
          // A read that failed part way leaves the frame short, which no client
          // can recover from, so the stream ends here rather than lying.
          stream.destroy();
          res.end();
          return;
        }
        // A file truncated after it was opened would otherwise leave the frame
        // short. Padding keeps the framing honest; the client's next run sees
        // the new size and fetches it again.
        if (sent < size) {
          if (!(await send(res, Buffer.alloc(size - sent)))) return;
        }
      }
      await send(res, JSON.stringify({ end: true, missing }) + '\n');
      res.end();
    } finally {
      release();
    }
  });
}
