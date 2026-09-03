import { Express, Request, Response } from 'express';
import { GitRepo, isValidRefName, isValidRepoPath } from '../git';
import { languageBreakdown } from '../languages';
import { AuthLimiter, BUSY_RETRY_SECONDS, Gates } from '../limit';
import { parsePointer } from '../pointer';
import { isBinary } from '../render';
import { apiError, limitParam, requireRepo } from './auth';

// Reading a repository: the tree, a file, history, a diff, blame, search.
//
// These are the routes that make an agent able to work without a clone. They are
// deliberately not the HTML routes answering JSON: the HTML routes carry
// UI-shaped parameters and costs (a tree listing with the last commit per entry
// is one `git log` per entry) that an API caller usually does not want, and
// sometimes wants more than.

/** The wildcard tail of a route path, as express leaves it. */
function tail(req: Request): string {
  return (req.params as Record<string, string>)['0'] ?? '';
}

/** A ref from ?ref=, falling back to the default branch. Never an arbitrary revision expression. */
async function refOf(req: Request, repo: GitRepo): Promise<string | null> {
  const asked = String(req.query.ref ?? '');
  if (asked === '') return await repo.defaultBranch(await repo.listRefs('heads'));
  return isValidRefName(asked) ? asked : null;
}

// How a gated route refuses. 503 rather than 429: this is server capacity rather
// than a client quota, and nothing about the request was wrong.
function sendBusy(res: Response): void {
  res.setHeader('Retry-After', String(BUSY_RETRY_SECONDS));
  apiError(res, 503, 'the server is busy with other git work; try again in a moment');
}

const MAX_COMMITS = 250;
const MAX_LISTED_PATHS = 20000;
/** The same ceiling the editor applies, so that the two interfaces agree on what is too big. */
const MAX_FILE_BYTES = 1024 * 1024;

export function registerContentsApi(app: Express, root: string, limiter: AuthLimiter, gates: Gates): void {
  // A directory listing. ?commits=1 adds the last commit per entry, which costs
  // one git log per entry; it is off by default because an API caller asking for
  // a listing usually wants names.
  const treeHandler = async (req: Request, res: Response): Promise<void> => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    if (!ref) {
      apiError(res, 400, 'ref is not a usable ref name');
      return;
    }
    const dir = tail(req);
    if (!isValidRepoPath(dir)) {
      apiError(res, 400, 'that is not a usable path');
      return;
    }
    let entries;
    try {
      entries = await found.repo.listTree(ref, dir);
    } catch {
      apiError(res, 404, `nothing at ${dir || '/'} in ${ref}`);
      return;
    }
    if (String(req.query.commits ?? '') === '1') {
      const paths = entries.map((e) => (dir ? `${dir}/${e.name}` : e.name));
      const last = await found.repo.lastCommits(ref, paths);
      res.json({
        ref,
        path: dir,
        entries: entries.map((e, i) => ({ ...e, lastCommit: last.get(paths[i]) ?? null })),
      });
      return;
    }
    res.json({ ref, path: dir, entries });
  };
  app.get('/api/repos/:collection/:repo/tree/*', treeHandler);
  app.get('/api/repos/:collection/:repo/tree', treeHandler);

  // One file, with its content. Text comes back as text; anything binary comes
  // back base64, and an LFS pointer is reported as one rather than handed over as
  // if it were the file, since the bytes are somewhere else.
  app.get('/api/repos/:collection/:repo/contents/*', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    if (!ref) {
      apiError(res, 400, 'ref is not a usable ref name');
      return;
    }
    const filePath = tail(req);
    if (filePath === '' || !isValidRepoPath(filePath)) {
      apiError(res, 400, 'that is not a usable path');
      return;
    }
    let buf: Buffer;
    try {
      if ((await found.repo.entryType(ref, filePath)) !== 'blob') {
        apiError(res, 404, `no file at ${filePath} in ${ref}`);
        return;
      }
      buf = await found.repo.catBlob(ref, filePath);
    } catch {
      apiError(res, 404, `no file at ${filePath} in ${ref}`);
      return;
    }
    const pointer = parsePointer(buf);
    // The commit the ref is at, so that a caller which reads, thinks, and then
    // writes can hand it back as expectedSha and be told if the branch moved
    // underneath it.
    const base = { ref, path: filePath, size: buf.length, commit: await found.repo.resolve(ref) };
    if (pointer) {
      res.json({
        ...base,
        encoding: 'lfs-pointer',
        lfs: { oid: pointer.oid, size: pointer.size },
        content: null,
        note: 'this path is a Git LFS pointer; fetch the object through the LFS endpoints or a clone with git-lfs',
      });
      return;
    }
    if (buf.length > MAX_FILE_BYTES) {
      apiError(res, 413, `${filePath} is larger than ${MAX_FILE_BYTES} bytes; fetch it from the raw route or a clone`);
      return;
    }
    if (isBinary(buf)) {
      res.json({ ...base, encoding: 'base64', content: buf.toString('base64') });
      return;
    }
    res.json({ ...base, encoding: 'utf-8', content: buf.toString('utf8') });
  });

  // The bytes, with no envelope. The sandbox headers are the same ones the web
  // raw route sets, because repository content must never be able to inject HTML
  // into this origin whichever door it came out of.
  app.get('/api/repos/:collection/:repo/raw/*', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    const filePath = tail(req);
    if (!ref || filePath === '' || !isValidRepoPath(filePath)) {
      apiError(res, 400, 'ask for a file as /raw/<path>?ref=<ref>');
      return;
    }
    let buf: Buffer;
    try {
      if ((await found.repo.entryType(ref, filePath)) !== 'blob') {
        apiError(res, 404, `no file at ${filePath} in ${ref}`);
        return;
      }
      buf = await found.repo.catBlob(ref, filePath);
    } catch {
      apiError(res, 404, `no file at ${filePath} in ${ref}`);
      return;
    }
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(isBinary(buf) ? 'application/octet-stream' : 'text/plain; charset=utf-8');
    res.send(buf);
  });

  app.get('/api/repos/:collection/:repo/commits', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    if (!ref) {
      apiError(res, 400, 'ref is not a usable ref name');
      return;
    }
    const filePath = String(req.query.path ?? '');
    if (filePath !== '' && !isValidRepoPath(filePath)) {
      apiError(res, 400, 'that is not a usable path');
      return;
    }
    const limit = limitParam(req.query.limit, 30, MAX_COMMITS);
    try {
      const commits = await found.repo.log(ref, 0, limit, filePath || undefined);
      res.json({ ref, commits });
    } catch {
      apiError(res, 404, `ref ${ref} not found`);
    }
  });

  // A commit id, possibly abbreviated, as the web route takes it. Checked
  // before it reaches git: an argument beginning with a dash is an option to
  // git, and `--output=<path>` would write the listing into the vault.
  const COMMIT_ID = /^[0-9a-f]{4,40}$/i;

  app.get('/api/repos/:collection/:repo/commits/:sha', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    if (!COMMIT_ID.test(req.params.sha)) {
      apiError(res, 404, `no commit ${req.params.sha}`);
      return;
    }
    const detail = await found.repo.commit(req.params.sha);
    if (!detail) {
      apiError(res, 404, `no commit ${req.params.sha}`);
      return;
    }
    res.json(detail);
  });

  app.get('/api/repos/:collection/:repo/commits/:sha/patch', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    if (!COMMIT_ID.test(req.params.sha) || !(await found.repo.commit(req.params.sha))) {
      apiError(res, 404, `no commit ${req.params.sha}`);
      return;
    }
    res.type('text/plain').send(await found.repo.commitPatch(req.params.sha));
  });

  // base...head, spelled as the web route spells it. A wildcard rather than one
  // segment, because a branch name may contain slashes.
  app.get('/api/repos/:collection/:repo/compare/*', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const parts = tail(req).split('...');
    if (parts.length !== 2 || !isValidRefName(parts[0]) || !isValidRefName(parts[1])) {
      apiError(res, 400, 'ask for a comparison as <base>...<head>');
      return;
    }
    try {
      const cmp = await found.repo.compare(parts[0], parts[1]);
      res.json({ base: parts[0], head: parts[1], ...cmp });
    } catch {
      apiError(res, 404, `could not compare ${parts[0]} with ${parts[1]}`);
    }
  });

  app.get('/api/repos/:collection/:repo/blame/*', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    const filePath = tail(req);
    if (!ref || filePath === '' || !isValidRepoPath(filePath)) {
      apiError(res, 400, 'ask for blame as /blame/<path>?ref=<ref>');
      return;
    }
    try {
      res.json({ ref, path: filePath, lines: await found.repo.blame(ref, filePath) });
    } catch {
      apiError(res, 404, `no file at ${filePath} in ${ref}`);
    }
  });

  // Literal search, gated like the web route: git grep over a whole tree is the
  // most expensive thing a reader can ask for.
  app.get('/api/repos/:collection/:repo/search', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    const query = String(req.query.q ?? '').slice(0, 256);
    if (!ref) {
      apiError(res, 400, 'ref is not a usable ref name');
      return;
    }
    if (query.trim() === '') {
      res.json({ ref, query, hits: [], truncated: false });
      return;
    }
    const release = await gates.search.enter();
    if (!release) {
      sendBusy(res);
      return;
    }
    try {
      const { hits, truncated } = await found.repo.search(ref, query);
      res.json({ ref, query, hits, truncated });
    } finally {
      release();
    }
  });

  // The file list the finder uses, which is what an agent wants before it asks
  // for any one file.
  app.get('/api/repos/:collection/:repo/paths', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    if (!ref) {
      apiError(res, 400, 'ref is not a usable ref name');
      return;
    }
    const limit = limitParam(req.query.limit, MAX_LISTED_PATHS, MAX_LISTED_PATHS);
    const release = await gates.tree.enter();
    if (!release) {
      sendBusy(res);
      return;
    }
    try {
      const { paths, truncated } = await found.repo.listPaths(ref, limit);
      res.json({ ref, paths, truncated });
    } catch {
      apiError(res, 404, `ref ${ref} not found`);
    } finally {
      release();
    }
  });

  app.get('/api/repos/:collection/:repo/contributors', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    if (!ref) {
      apiError(res, 400, 'ref is not a usable ref name');
      return;
    }
    try {
      res.json({ ref, contributors: await found.repo.contributors(ref) });
    } catch {
      apiError(res, 404, `ref ${ref} not found`);
    }
  });

  app.get('/api/repos/:collection/:repo/languages', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const ref = await refOf(req, found.repo);
    if (!ref) {
      apiError(res, 400, 'ref is not a usable ref name');
      return;
    }
    const release = await gates.tree.enter();
    if (!release) {
      sendBusy(res);
      return;
    }
    try {
      res.json({ ref, languages: await languageBreakdown(found.repo.dir, ref) });
    } catch {
      apiError(res, 404, `ref ${ref} not found`);
    } finally {
      release();
    }
  });
}
