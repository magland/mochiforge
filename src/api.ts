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
  removeCollectionOwner,
  repoRole,
} from './perms';
import { displayName, isValidName, listCollections, listRepoDirs } from './scan';
import { AuthResult, loadVault } from './vault';
import { apiError, requireApiAuth as authenticateRequest } from './api/auth';
import { Egress } from './egress';
import { AuthLimiter, Gates } from './limit';
import { LfsContext } from './lfsstore';
import { CiEngine } from './ci/engine';
import { registerContentsApi } from './api/contents';
import { registerIssueApi } from './api/issues';
import { registerPullApi } from './api/pulls';
import { registerRepoApi } from './api/repos';
import { registerAdminApi } from './api/admin';
import { registerUsersApi } from './api/users';
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
  // Who the caller is, the users, and their tokens: see src/api/users.ts.
  registerUsersApi(app, root, authLimiter);
  // Reading a whole vault out over HTTP, for `mochi backup`. Admin over the
  // whole vault, and behind the same gate a file listing holds.
  registerBackupApi(app, root, authLimiter, gates);

  // Both helpers live in src/api/auth.ts now that more than one file of routes
  // uses them; this closure only saves passing root at every call site.
  const requireApiAuth = (req: Request, res: Response) => authenticateRequest(root, authLimiter, req, res);

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
}
