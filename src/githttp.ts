import { Express, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as stream from 'stream';
import * as zlib from 'zlib';
import { CiEngine } from './ci/engine';
import { GitRepo, execGit } from './git';
import { grantCovers, verifyJobToken } from './jobtoken';
import { OpError, createRepo, opErrorStatus } from './ops';
import { atLeast, canCreateRepo, canReadRepo, repoIsPrivate, repoRole } from './perms';
import { displayName, findRepo, isDotName, isValidName, reservedRepoSuffix } from './scan';
import { AuthLimiter, BUSY_RETRY_SECONDS, Gates } from './limit';
import { AuthResult, authenticate, authenticateToken, loadVault } from './vault';
import { ah } from './web';

// git smart HTTP. Anonymous fetch (upload-pack) stays open for public
// repositories; a private one asks for Basic auth and then serves only a
// reader. Push (receive-pack) always requires a token presented over HTTP
// Basic auth. Session cookies are never consulted here: git and the browser
// present distinct credentials by design.

function pkt(s: string): string {
  return (s.length + 4).toString(16).padStart(4, '0') + s;
}

// The environment a git subprocess is given. GIT_PROTOCOL is how the version
// the client asked for reaches git, and its value arrives in a request header,
// so it is held to the shape git itself defines (`version=2`, and the
// colon-separated key or key=value list the protocol allows) rather than being
// passed on as written. Anything else is dropped, which leaves git at the
// version it would have negotiated without the header.
const GIT_PROTOCOL_RE = /^[A-Za-z0-9_.=-]{1,64}(:[A-Za-z0-9_.=-]{1,64})*$/;

function gitEnv(req: Request): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const proto = req.get('git-protocol');
  if (proto && GIT_PROTOCOL_RE.test(proto)) env.GIT_PROTOCOL = proto;
  return env;
}

export function parseBasicAuth(req: Request): { username: string; password: string } | null {
  const h = req.get('authorization');
  if (!h || !/^basic /i.test(h)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i === -1) return null;
  return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

// The authorization decisions, shared with the LFS endpoints. The caller
// renders a denial in its own content type (plain text for git, LFS JSON for
// the batch API), so these return a result rather than writing the response.
type Denied = { ok: false; status: 401 | 403 | 404 | 429 | 500; message: string; retryAfter?: number };
/** Read grants may be anonymous (a public repository) or a job token, so auth may be null. */
export type GitAuthCheck = { ok: true; auth: AuthResult | null } | Denied;
/** A push is always somebody's. */
export type PushAuthCheck = { ok: true; auth: AuthResult } | Denied;

// The vault has to be loadable before any credential means anything.
function vaultOf(root: string, verb: string): { vault: import('./vault').Vault } | Denied {
  const state = loadVault(root);
  if (state.status === 'missing') {
    return {
      ok: false,
      status: 401,
      message: `${verb} denied: no vault.json in this vault; restart the server to initialize one`,
    };
  }
  if (state.status === 'error') {
    return { ok: false, status: 500, message: `${verb} denied: vault.json could not be read: ${state.message}` };
  }
  return { vault: state.vault };
}

function checkCreds(
  root: string,
  limiter: AuthLimiter,
  req: Request,
  verb: string
): { auth: AuthResult } | Denied {
  const v = vaultOf(root, verb);
  if ('ok' in v) return v;
  // git's first request carries no Basic auth by protocol and always will, so
  // a missing credential is not a failed attempt and is not charged.
  const creds = parseBasicAuth(req);
  if (!creds) {
    return { ok: false, status: 401, message: `authentication required to ${verb}` };
  }
  const allowed = limiter.allow(req, creds.username);
  if (!allowed.ok) {
    return {
      ok: false,
      status: 429,
      message: 'too many failed authentication attempts; try again later',
      retryAfter: allowed.retryAfter,
    };
  }
  // The username first, and the token alone as the fallback: a token is 64
  // random hex characters and identifies its owner by itself, so any username
  // with a valid token works, as it does on GitHub. That is what lets a
  // client that holds only a token (the backup client, a script) clone
  // without also being told whose it is.
  const auth = authenticate(v.vault, creds.username, creds.password) ?? authenticateToken(v.vault, creds.password);
  if (!auth) {
    limiter.fail(req, creds.username);
    return { ok: false, status: 401, message: 'invalid username or token' };
  }
  return { auth };
}

/**
 * Whether this request may read the repository over git. A public repository
 * reads anonymously. A private one and an absent one answer identically, so
 * the wire cannot distinguish them: no credential gets the 401 challenge
 * (which is also what makes git ask the user for one), and a credential that
 * proves no read access gets the same "repository not found" a truly absent
 * repository gets. A workflow job's ephemeral token (src/jobtoken.ts) reads
 * exactly the repository it was minted for.
 */
export function checkReadAuth(
  root: string,
  limiter: AuthLimiter,
  req: Request,
  repo: GitRepo | null
): GitAuthCheck {
  if (repo && !repoIsPrivate(repo.dir)) return { ok: true, auth: null };
  const creds = parseBasicAuth(req);
  if (repo && creds) {
    const grant = verifyJobToken(root, creds.password);
    if (grant && grantCovers(grant, repo.collection, repo.name)) return { ok: true, auth: null };
  }
  const checked = checkCreds(root, limiter, req, 'read');
  if ('ok' in checked) return checked;
  if (!repo || !canReadRepo(root, checked.auth, repo)) {
    return { ok: false, status: 404, message: 'repository not found' };
  }
  return { ok: true, auth: checked.auth };
}

/**
 * Whether this request may push. `repo` is null for push-to-create, where the
 * question is creation in the collection rather than the write role on an
 * existing repository. On an existing private repository a credential without
 * even the read role gets "repository not found", as on the read path.
 */
export function checkPushAuth(
  root: string,
  limiter: AuthLimiter,
  req: Request,
  collection: string,
  repoName: string,
  repo: GitRepo | null
): PushAuthCheck {
  const checked = checkCreds(root, limiter, req, 'push');
  if ('ok' in checked) return checked;
  const auth = checked.auth;
  if (repo) {
    const role = repoRole(root, auth, repo);
    if (role === null) return { ok: false, status: 404, message: 'repository not found' };
    if (!atLeast(role, 'write')) {
      return {
        ok: false,
        status: 403,
        message: `user ${auth.username} is not allowed to push to ${collection}/${repoName}`,
      };
    }
    return { ok: true, auth };
  }
  if (!canCreateRepo(root, auth, collection, repoName)) {
    return {
      ok: false,
      status: 403,
      message: `user ${auth.username} is not allowed to create ${collection}/${repoName}`,
    };
  }
  return { ok: true, auth };
}

// The refs a push may have changed, read before and after receive-pack. A
// snapshot diff rather than a post-receive hook script: it needs no hook
// installed in each repository, so it works for repositories imported by
// `git clone --bare` as well as ones this server created.
async function refSnapshot(repo: GitRepo): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  try {
    const out = (
      await execGit(repo.dir, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/tags'])
    ).toString('utf8');
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, sha] = line.split('\0');
      if (name && sha) snap.set(name, sha);
    }
  } catch {
    // an unreadable ref list yields no events rather than failing the push
  }
  return snap;
}

const ZERO = '0'.repeat(40);

export function registerGitHttp(app: Express, root: string, gates: Gates, authLimiter: AuthLimiter, engine?: CiEngine): void {
  // git shows the body of a 503 on the RPC to the person who ran the command, so
  // it is one sentence. Not 429: this is server capacity rather than a client
  // quota, and git's own error surface reads better with 503.
  function denyBusy(res: Response) {
    res.status(503).setHeader('Retry-After', String(BUSY_RETRY_SECONDS));
    res.type('text/plain').send('the server is busy with other git work; please try again in a moment\n');
  }

  function deny(res: Response, status: number, message: string, retryAfter?: number) {
    if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="mochi"');
    if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).type('text/plain').send(message + '\n');
  }

  function requirePushAuth(
    req: Request,
    res: Response,
    collection: string,
    repoName: string,
    repo: GitRepo | null
  ): AuthResult | null {
    const check = checkPushAuth(root, authLimiter, req, collection, repoName, repo);
    if (!check.ok) {
      deny(res, check.status, check.message, check.retryAfter);
      return null;
    }
    return check.auth;
  }

  /** The repository, readable by this request, or null having sent the refusal. */
  function requireReadAuth(req: Request, res: Response): GitRepo | null {
    const repo = findRepo(root, req.params.collection, req.params.repo);
    const check = checkReadAuth(root, authLimiter, req, repo);
    if (!check.ok) {
      deny(res, check.status, check.message, check.retryAfter);
      return null;
    }
    if (!repo) {
      // Unreachable: checkReadAuth answers ok only for a repository it saw.
      deny(res, 404, 'repository not found');
      return null;
    }
    return repo;
  }

  async function ensureHead(repo: GitRepo): Promise<void> {
    const branches = await repo.listRefs('heads');
    if (branches.length === 0) return;
    try {
      const head = (await execGit(repo.dir, ['symbolic-ref', '--short', 'HEAD'])).toString('utf8').trim();
      if (branches.some((b) => b.name === head)) return;
    } catch {
      // detached or unreadable HEAD; repoint below
    }
    const names = branches.map((b) => b.name).sort();
    const pick = names.includes('main') ? 'main' : names.includes('master') ? 'master' : names[0];
    await execGit(repo.dir, ['symbolic-ref', 'HEAD', `refs/heads/${pick}`]);
  }

  // Both of these spawn git, and both hold their gate slot until the child is
  // gone rather than until the handler returns: runService pipes and returns
  // immediately, so releasing on return would bound nothing at all. The gate's
  // release is idempotent, which is what lets it be wired to both the child
  // closing and the response closing; an aborted clone is ordinary traffic, and
  // a gate that leaked a slot per abort would stop answering after four of them.
  function gateFor(service: 'git-upload-pack' | 'git-receive-pack') {
    return service === 'git-upload-pack' ? gates.clone : gates.push;
  }

  async function advertise(
    req: Request,
    res: Response,
    service: 'git-upload-pack' | 'git-receive-pack',
    dir: string
  ): Promise<void> {
    const release = await gateFor(service).enter();
    if (!release) {
      denyBusy(res);
      return;
    }
    res.on('close', release);
    res.setHeader('Content-Type', `application/x-${service}-advertisement`);
    res.setHeader('Cache-Control', 'no-cache');
    res.write(pkt(`# service=${service}\n`) + '0000');
    const child = spawn('git', [service.slice(4), '--stateless-rpc', '--advertise-refs', dir], {
      env: gitEnv(req),
    });
    child.on('close', release);
    child.stdout.pipe(res);
    child.on('error', () => {
      release();
      res.end();
    });
  }

  async function runService(
    req: Request,
    res: Response,
    service: 'git-upload-pack' | 'git-receive-pack',
    dir: string,
    onClose?: (code: number | null) => void
  ): Promise<void> {
    const release = await gateFor(service).enter();
    if (!release) {
      denyBusy(res);
      return;
    }
    res.on('close', release);
    res.setHeader('Content-Type', `application/x-${service}-result`);
    res.setHeader('Cache-Control', 'no-cache');
    const child = spawn('git', [service.slice(4), '--stateless-rpc', dir], { env: gitEnv(req) });
    // The request body reaches git through a pipeline rather than a chain of
    // pipe() calls, because pipe() leaves an error on the destination with no
    // listener, and an 'error' nobody listens for ends the process. A body
    // declared gzip that is not gzip is the case that reaches here from the
    // network: it is a bad request, and what should die is the request.
    // Likewise git exiting early, which turns its stdin into an EPIPE for the
    // writer: the exit code is the answer, and the pipe error is noise.
    const stages: NodeJS.ReadableStream[] = [req];
    if (req.headers['content-encoding'] === 'gzip') stages.push(zlib.createGunzip());
    stream.pipeline([...stages, child.stdin] as unknown as NodeJS.ReadWriteStream[], (err) => {
      if (err) child.kill();
    });
    child.stdout.pipe(res);
    // A client that goes away mid-transfer leaves git writing into a pipe
    // nobody drains. Node unpipes and pauses the source, which is a git
    // process blocked forever, holding its packfile in memory, one per
    // abandoned clone. A response closed without finishing is that case;
    // one that finished has a git that is already exiting.
    res.on('close', () => {
      if (!res.writableFinished) child.kill();
    });
    child.on('error', () => {
      release();
      if (!res.headersSent) res.status(500);
      res.end();
    });
    child.on('close', (code) => {
      release();
      if (onClose) onClose(code);
    });
  }

  app.get(
    '/:collection/:repo/info/refs',
    ah(async (req, res) => {
      const service = req.query.service;
      const collectionName = req.params.collection;
      const repoName = displayName(req.params.repo);
      if (service === 'git-upload-pack') {
        const repo = requireReadAuth(req, res);
        if (!repo) return;
        await advertise(req, res, 'git-upload-pack', repo.dir);
        return;
      }
      if (service === 'git-receive-pack') {
        if (!isValidName(collectionName) || !isValidName(repoName)) {
          res.status(404).type('text/plain').send('invalid repository name\n');
          return;
        }
        let repo = findRepo(root, collectionName, req.params.repo);
        const auth = requirePushAuth(req, res, collectionName, repoName, repo);
        if (!auth) return;
        if (!repo) {
          // Push-to-create, so the name has to survive the same check the web
          // form applies. An existing repository is served whatever it is
          // called; only a new one is refused.
          const reserved = reservedRepoSuffix(repoName);
          if (reserved) {
            res
              .status(400)
              .type('text/plain')
              .send(`repository names may not end in ${reserved}, which is reserved for the directories a repository keeps beside it\n`);
            return;
          }
          // A push creates the collection too when it does not exist, and only
          // a repository may carry a leading dot.
          if (isDotName(collectionName)) {
            res.status(400).type('text/plain').send('collection names may not begin with a dot\n');
            return;
          }
          // The ops layer applies the rest of what a new name must satisfy
          // (length, case collisions with existing names); its refusal is an
          // answer for the pusher, not a failure of the server.
          try {
            repo = await createRepo(root, collectionName, repoName);
          } catch (e) {
            if (e instanceof OpError) {
              res.status(opErrorStatus(e.kind)).type('text/plain').send(`${e.message}\n`);
              return;
            }
            throw e;
          }
        }
        await advertise(req, res, 'git-receive-pack', repo.dir);
        return;
      }
      res.status(403).type('text/plain').send('unsupported service\n');
    })
  );

  app.post(
    '/:collection/:repo/git-upload-pack',
    ah(async (req, res) => {
      const repo = requireReadAuth(req, res);
      if (!repo) return;
      // The gate is entered after the read check and before anything expensive.
      await runService(req, res, 'git-upload-pack', repo.dir);
    })
  );

  app.post(
    '/:collection/:repo/git-receive-pack',
    ah(async (req, res) => {
      const collectionName = req.params.collection;
      const repoName = displayName(req.params.repo);
      if (!isValidName(collectionName) || !isValidName(repoName)) {
        res.status(404).type('text/plain').send('invalid repository name\n');
        return;
      }
      let repo = findRepo(root, collectionName, req.params.repo);
      const auth = requirePushAuth(req, res, collectionName, repoName, repo);
      if (!auth) return;
      if (!repo) {
        const reserved = reservedRepoSuffix(repoName);
        if (reserved) {
          res
            .status(400)
            .type('text/plain')
            .send(`repository names may not end in ${reserved}, which is reserved for the directories a repository keeps beside it\n`);
          return;
        }
        if (isDotName(collectionName)) {
          res.status(400).type('text/plain').send('collection names may not begin with a dot\n');
          return;
        }
        // As in the advertisement above: the ops layer's refusal of a new
        // name is an answer for the pusher.
        try {
          repo = await createRepo(root, collectionName, repoName);
        } catch (e) {
          if (e instanceof OpError) {
            res.status(opErrorStatus(e.kind)).type('text/plain').send(`${e.message}\n`);
            return;
          }
          throw e;
        }
      }
      const target = repo;
      const actor = auth.username;
      const before = await refSnapshot(target);
      // The push gate is entered only now, after requirePushAuth has succeeded:
      // an unauthenticated request must not be able to occupy a slot that
      // authorized users depend on.
      await runService(req, res, 'git-receive-pack', repo.dir, (code) => {
        if (code !== 0) return;
        ensureHead(target)
          .then(() => (engine ? firePushEvents(engine, target, before, actor) : undefined))
          .catch((e) => console.error(`post-receive handling failed: ${e instanceof Error ? e.message : e}`));
      });
    })
  );
}

// Turn a before/after ref snapshot into push events for the CI engine. Ref
// deletions are reported (with an all-zero "after") and ignored downstream;
// a workflow file that fails to parse still produces a visible failed run,
// which is why nothing here filters on content.
async function firePushEvents(
  engine: CiEngine,
  repo: GitRepo,
  before: Map<string, string>,
  actor: string
): Promise<void> {
  const after = await refSnapshot(repo);
  for (const [ref, sha] of after) {
    if (before.get(ref) === sha) continue;
    await engine.handlePush(repo, { ref, before: before.get(ref) ?? ZERO, after: sha, actor });
  }
}
