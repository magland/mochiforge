import * as fs from 'fs';
import express, { Express, Request, Response } from 'express';
import * as ops from './ops';
import { MAX_UPLOAD_SIZE, OpError, opErrorStatus } from './ops';
import { collectionDir, repoPath } from './layout';
import {
  addCollectionOwner,
  canAdminCollection,
  canCreateCollection,
  collectionOwners,
  isSiteAdmin,
  removeCollectionOwner,
  repoRole,
} from './perms';
import { displayName, isValidName, isValidUserName, listCollections, listRepoDirs } from './scan';
import { AuthResult, addUserToken, loadVault, setSiteAdmin } from './vault';
import { apiError, requireApiAuth as authenticateRequest } from './api/auth';
import { LOGIN_LINK_TTL_MS, mintLoginLink } from './logincodes';
import { Egress } from './egress';
import { AuthLimiter, Gates } from './limit';
import { LfsContext } from './lfsstore';
import { CiEngine } from './ci/engine';
import { registerContentsApi } from './api/contents';
import { registerIssueApi } from './api/issues';
import { registerPullApi } from './api/pulls';
import { registerRepoApi } from './api/repos';
import { registerAdminApi } from './api/admin';
import { registerBackupApi } from './api/backup';
import { collectionSiteAlias, storedCollectionAlias } from './sitesettings';
import { loadConfig } from './config';
import { registerCiRunApi } from './api/ci';
import { registerReleaseApi } from './api/releases';
import { registerWriteApi } from './api/write';

// The bearer-token JSON API used by the mochi CLI. Only Bearer tokens are
// accepted; session cookies never authorize API calls.

export function registerApi(
  app: Express,
  root: string,
  authLimiter: AuthLimiter,
  gates: Gates,
  lfs: LfsContext | null = null,
  engine?: CiEngine,
  egress?: Egress
): void {
  // A write route carries a file in its body, so the limit is the one the upload
  // route already applies rather than express's 100 kB default. Anything larger
  // belongs in a push, or in Git LFS.
  app.use('/api', express.json({ limit: MAX_UPLOAD_SIZE }));

  // The routes are split by subject, mirroring the split the HTML modules
  // already have, so that no one file grows unmanageable. Each of them calls the
  // same domain functions the web handlers call and the same authorization
  // helpers, so the duplication between the two transports is transport only.
  registerRepoApi(app, root, authLimiter);
  registerContentsApi(app, root, authLimiter, gates);
  registerIssueApi(app, root, authLimiter);
  registerPullApi(app, root, authLimiter, engine);
  registerWriteApi(app, root, authLimiter, lfs, engine);
  // The engine is constructed in createApp and already handed to registerCiApi,
  // so these routes take it the same way. A vault serving with no engine has no
  // workflows to answer about.
  if (engine) registerCiRunApi(app, root, authLimiter, engine);
  registerReleaseApi(app, root, authLimiter);
  registerAdminApi(app, root, authLimiter, lfs, engine, egress);
  // Reading a whole vault out over HTTP, for `mochi backup`. Admin over the
  // whole vault, and behind the same gate a file listing holds.
  registerBackupApi(app, root, authLimiter, gates);

  // Both helpers live in src/api/auth.ts now that more than one file of routes
  // uses them; this closure only saves passing root at every call site.
  const requireApiAuth = (req: Request, res: Response) => authenticateRequest(root, authLimiter, req, res);

  function sanitizeGlobs(v: unknown): string[] | null | undefined {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length < 200)) {
      return v as string[];
    }
    return null;
  }

  // What a caller may reach, filtered to their eyes: a private repository the
  // caller has no role on is left out, here and in every listing.
  const visibleRepos = (auth: AuthResult, collection: string): string[] =>
    listRepoDirs(root, collection).filter(
      (dirName) =>
        repoRole(root, auth, {
          collection,
          name: displayName(dirName),
          dir: repoPath(root, collection, dirName),
        }) !== null
    );

  // A one-time sign-in URL for the browser, which is how `mochi web` opens
  // the vault already signed in: the CLI proves the token over the API, and
  // the session the link starts is bound to that same token, so revoking it
  // ends both. The link lands on a page that names the account and asks for a
  // click; see /login/code/:code in src/webops.ts.
  app.post('/api/login-url', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = typeof body.next === 'string' ? body.next : '/';
    const code = mintLoginLink(root, auth.username, auth.token.hash, next);
    res.json({
      url: `${req.protocol}://${req.get('host')}/login/code/${code}`,
      username: auth.username,
      expiresInSeconds: Math.round(LOGIN_LINK_TTL_MS / 1000),
    });
  });

  app.get('/api/whoami', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    res.json({
      username: auth.username,
      siteAdmin: auth.user.siteAdmin === true,
      ownedCollections: listCollections(root)
        .map((c) => c.name)
        .filter((c) => c === auth.username || collectionOwners(root, c).includes(auth.username)),
      tokenScope: auth.token.scope ?? null,
    });
  });

  // Collections, for the CLI. `mochi import` asks what is already in a
  // collection before it pushes, and `mochi collection add` makes an empty
  // one, which is the case a push cannot cover: pushing creates the collection
  // it lands in, so a collection with nothing in it yet has to be asked for.
  app.get('/api/collections', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    res.json({
      collections: listCollections(root).map((c) => ({ name: c.name, repoCount: visibleRepos(auth, c.name).length })),
    });
  });

  app.get('/api/collections/:name', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const name = req.params.name;
    let isDir = false;
    try {
      isDir = fs.statSync(collectionDir(root, name)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isValidName(name) || !isDir) {
      apiError(res, 404, `no collection ${name} in this vault`);
      return;
    }
    // siteAlias is what is stored and siteHostAlias what is in effect, the two
    // differing wherever a tier below the stored one is answering; see the
    // tiers in src/sitesettings.ts. Both are null on a vault with no sites
    // host, where a derived hostname would mean nothing.
    const sitesHost = loadConfig(root).sites.host;
    res.json({
      name,
      owners: collectionOwners(root, name),
      repos: visibleRepos(auth, name).map(displayName),
      siteAlias: sitesHost ? storedCollectionAlias(root, name) : null,
      siteHostAlias: sitesHost ? collectionSiteAlias(root, name) : null,
    });
  });

  app.post('/api/collections', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isValidName(name)) {
      apiError(res, 400, 'a valid "name" is required (letters, digits, dot, underscore, dash; not a reserved word)');
      return;
    }
    if (!canCreateCollection(root, auth, name)) {
      apiError(res, 403, `only a site admin can create a collection not named after you`);
      return;
    }
    try {
      ops.createCollection(root, name);
    } catch (e) {
      if (e instanceof OpError) {
        apiError(res, opErrorStatus(e.kind), e.message);
        return;
      }
      throw e;
    }
    res.json({ name, created: true });
  });

  // ---- collection owners ----

  // Owners manage the owners list, and site admins do; the same rule the
  // collection's settings page applies.
  app.put('/api/collections/:name/owners/:user', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const name = req.params.name;
    const username = req.params.user;
    if (!isValidName(name) || !fs.existsSync(collectionDir(root, name))) {
      apiError(res, 404, `no collection ${name} in this vault`);
      return;
    }
    if (!canAdminCollection(root, auth, name)) {
      apiError(res, 403, `you are not an owner of ${name}`);
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok' || !state.vault.users[username]) {
      apiError(res, 404, `no user ${username} in this vault`);
      return;
    }
    if (username === name) {
      res.json({ name, owners: collectionOwners(root, name), note: `${username} owns ${name} by name already` });
      return;
    }
    addCollectionOwner(root, name, username);
    res.json({ name, owners: collectionOwners(root, name) });
  });

  app.delete('/api/collections/:name/owners/:user', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const name = req.params.name;
    const username = req.params.user;
    if (!isValidName(name) || !fs.existsSync(collectionDir(root, name))) {
      apiError(res, 404, `no collection ${name} in this vault`);
      return;
    }
    if (!canAdminCollection(root, auth, name)) {
      apiError(res, 403, `you are not an owner of ${name}`);
      return;
    }
    if (!collectionOwners(root, name).includes(username)) {
      apiError(res, 404, `${username} is not an explicit owner of ${name}`);
      return;
    }
    removeCollectionOwner(root, name, username);
    res.json({ name, owners: collectionOwners(root, name) });
  });

  // Users are the site admin's business, as they are on GitHub: creating one,
  // listing them, and the site-admin bit itself. What a user may reach is not
  // set here at all; it lives with the collections and repositories that
  // grant it.

  app.get('/api/users', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    if (!isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin required (with an unrestricted token)');
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    res.json({
      users: Object.entries(state.vault.users).map(([name, u]) => ({
        name,
        siteAdmin: u.siteAdmin === true,
        tokens: u.tokens.length,
      })),
    });
  });

  app.post('/api/users', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username : '';
    if (!isValidUserName(username)) {
      apiError(res, 400, 'a valid "username" is required');
      return;
    }
    const tokenScope = sanitizeGlobs(body.tokenScope);
    if (tokenScope === null) {
      apiError(res, 400, '"tokenScope" must be a list of strings');
      return;
    }
    // Refused loudly rather than ignored: an older client sending the glob
    // fields would otherwise create a user without the access its operator
    // asked for, and silence is the worst way to deliver that.
    if (body.scope !== undefined || body.admin !== undefined) {
      apiError(
        res,
        400,
        '"scope" and "admin" are gone: a user owns the collection named after them, and anything more is ' +
          'granted where it applies (repository collaborators, collection owners) or with "siteAdmin"'
      );
      return;
    }
    if (body.siteAdmin !== undefined && typeof body.siteAdmin !== 'boolean') {
      apiError(res, 400, '"siteAdmin" must be a boolean');
      return;
    }
    if (!isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin required (with an unrestricted token)');
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const existing = state.vault.users[username];
    if (existing && body.siteAdmin !== undefined) {
      apiError(res, 409, `user ${username} already exists; use 'mochi user grant' to change the site-admin bit`);
      return;
    }
    const result = addUserToken(root, username, {
      siteAdmin: body.siteAdmin === true,
      tokenScope: tokenScope ?? undefined,
    });
    res.json({
      username,
      created: result.created,
      token: result.token,
      siteAdmin: result.user.siteAdmin === true,
    });
  });

  app.post('/api/users/:name/grant', (req, res) => {
    const auth = requireApiAuth(req, res);
    if (!auth) return;
    const username = req.params.name;
    if (!isValidName(username)) {
      apiError(res, 400, 'invalid username');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.siteAdmin !== 'boolean') {
      apiError(
        res,
        400,
        'provide "siteAdmin": true or false; per-repository access is granted on the repository (collaborators) or the collection (owners)'
      );
      return;
    }
    if (!isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin required (with an unrestricted token)');
      return;
    }
    let user;
    try {
      user = setSiteAdmin(root, username, body.siteAdmin);
    } catch (e) {
      apiError(res, 404, e instanceof Error ? e.message : String(e));
      return;
    }
    res.json({ username, siteAdmin: user.siteAdmin === true });
  });
}
