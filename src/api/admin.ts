import { Express } from 'express';
import * as fs from 'fs';
import { CiEngine } from '../ci/engine';
import { CiConfig, LimitsConfig, SitesConfig, isPlausibleHostname, loadConfig, saveConfig } from '../config';
import { Egress } from '../egress';
import { AuthLimiter } from '../limit';
import { LfsContext } from '../lfsstore';
import { collectionDir } from '../layout';
import { RepoContext, deleteCollection, renameCollection } from '../ops';
import { displayName, isValidName, listRepoDirs } from '../scan';
import { normalizeHostname } from '../siteshost';
import {
  collectionAliasConflict,
  collectionSiteAlias,
  isUsableCollectionAlias,
  setCollectionAlias,
  storedCollectionAlias,
} from '../sitesettings';
import { DEFAULT_THEME, findTheme, themeNames } from '../themes';
import { canAdminCollection, isSiteAdmin, removeUserGrants } from '../perms';
import { loadVault, removeUser, revokeToken, tokenId } from '../vault';
import { apiError, bodyOf, requireApiAuth, sendOpError, stringField } from './auth';

// Administration: users, their tokens, collections, and the vault's own settings.
//
// Reading a user's tokens never returns a token. Only a SHA-256 hash is stored, so
// there is nothing to return even if it were a good idea; what a caller gets is an
// id, a creation time, and a scope, which is enough to revoke one.

export function registerAdminApi(
  app: Express,
  root: string,
  limiter: AuthLimiter,
  lfs: LfsContext | null = null,
  engine?: CiEngine,
  egress?: Egress
): void {
  // One context for the collection rename, as the other two surfaces build for
  // theirs; see RepoContext in ops.ts.
  const repoCtx: RepoContext = { lfs: lfs?.store, runs: engine };

  /**
   * A site admin, which is what a vault-wide setting takes. Not merely a
   * collection owner: an owner should not restyle the whole vault or remove a
   * collection that is not theirs, which is the same rule canSetTheme applies
   * on the web.
   */
  const requireOwner = (req: Parameters<typeof requireApiAuth>[2], res: Parameters<typeof requireApiAuth>[3]) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return null;
    if (!isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin required (with an unrestricted token)');
      return null;
    }
    return auth;
  };

  // ---- collections ----

  /**
   * Rename a collection, with everything in it. The same operation the web
   * offers on a collection's settings page, and the same question: ownership
   * of the collection. The owners file moves with the collection, so the
   * owners after the rename are the owners before it.
   *
   * Unlike a repository rename this is not offered under a typed
   * confirmation, here or on the web. A rename is undone by renaming back, and
   * the confirmation belongs to deletion.
   */
  app.post('/api/collections/:name/rename', async (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const name = req.params.name;
    if (!isValidName(name)) {
      apiError(res, 400, 'that is not a usable collection name');
      return;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(collectionDir(root, name)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      apiError(res, 404, `no collection ${name} in this vault`);
      return;
    }
    const repos = listRepoDirs(root, name).map(displayName);
    if (!canAdminCollection(root, auth, name)) {
      apiError(res, 403, `you are not an owner of ${name}`);
      return;
    }
    const to = stringField(bodyOf(req), 'name')?.trim() ?? '';
    if (!isValidName(to)) {
      apiError(res, 400, 'a valid "name" is required (letters, digits, dot, underscore, dash; not a reserved word)');
      return;
    }
    try {
      await renameCollection(root, name, to, repoCtx);
      res.json({ name: to, renamedFrom: name, repos: repos.length, renamed: true });
    } catch (e) {
      sendOpError(res, e, 'could not rename the collection');
    }
  });

  /**
   * A collection's site alias: the label standing in for its name in each of
   * its repositories' derived site hostnames. Ownership of the collection, as
   * the rename above takes, since it decides those hostnames and nothing else.
   *
   * `siteAlias` is the only field, `""` clearing it and falling back to the
   * collection's own name where that is usable as a hostname label and its name
   * rewritten as one otherwise. An alias another collection is already reached
   * by is refused with 409, naming it, the same answer a claimed repository
   * label gets.
   */
  app.patch('/api/collections/:name', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const name = req.params.name;
    if (!isValidName(name) || !isCollection(name)) {
      apiError(res, 404, `no collection ${name} in this vault`);
      return;
    }
    if (!canAdminCollection(root, auth, name)) {
      apiError(res, 403, `you are not an owner of ${name}`);
      return;
    }
    const alias = stringField(bodyOf(req), 'siteAlias');
    if (alias === null) {
      apiError(res, 400, 'nothing to change; provide "siteAlias"');
      return;
    }
    if (alias !== '' && !isUsableCollectionAlias(alias)) {
      apiError(
        res,
        400,
        '"siteAlias" is lowercase letters, digits, and single interior hyphens, with no doubled hyphen, at most 63 characters'
      );
      return;
    }
    if (alias !== '') {
      const holder = collectionAliasConflict(root, alias, name);
      if (holder) {
        apiError(res, 409, `the alias ${alias} is already how the collection ${holder} is reached`);
        return;
      }
    }
    setCollectionAlias(root, name, alias);
    res.json({ name, siteAlias: storedCollectionAlias(root, name), alias: collectionSiteAlias(root, name) });
  });

  /** Whether the vault holds a collection of this name; the rename's own check. */
  function isCollection(name: string): boolean {
    try {
      return fs.statSync(collectionDir(root, name)).isDirectory();
    } catch {
      return false;
    }
  }

  // Only an empty one: what "empty" means, and what goes with the directory,
  // is deleteCollection's business, shared with the web route.
  app.delete('/api/collections/:name', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const name = req.params.name;
    if (!canAdminCollection(root, auth, name)) {
      apiError(res, 403, `you are not an owner of ${name}`);
      return;
    }
    try {
      deleteCollection(root, name);
    } catch (e) {
      sendOpError(res, e, 'could not remove the collection');
      return;
    }
    res.json({ deleted: name });
  });

  // ---- users and their tokens ----

  app.get('/api/users/:name', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const user = state.vault.users[req.params.name];
    if (!user) {
      apiError(res, 404, `no user ${req.params.name}`);
      return;
    }
    // A user may read their own record; reading anyone else's takes a site
    // admin.
    if (req.params.name !== auth.username && !isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin required to touch another user');
      return;
    }
    res.json({
      name: req.params.name,
      siteAdmin: user.siteAdmin === true,
      tokens: user.tokens.map((t) => ({ id: tokenId(t), created: t.created ?? null, scope: t.scope ?? null })),
    });
  });

  app.get('/api/users/:name/tokens', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const user = state.vault.users[req.params.name];
    if (!user) {
      apiError(res, 404, `no user ${req.params.name}`);
      return;
    }
    if (req.params.name !== auth.username && !isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin required to touch another user');
      return;
    }
    // Never the token, and never the hash either: an id is what revocation
    // takes, and the hash is a credential-shaped thing with no reason to travel.
    res.json({
      tokens: user.tokens.map((t) => ({ id: tokenId(t), created: t.created ?? null, scope: t.scope ?? null })),
    });
  });

  app.delete('/api/users/:name/tokens/:id', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const user = state.vault.users[req.params.name];
    if (!user) {
      apiError(res, 404, `no user ${req.params.name}`);
      return;
    }
    const ownToken = req.params.name === auth.username && tokenId(auth.token) === req.params.id;
    if (req.params.name !== auth.username && !isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin required to touch another user');
      return;
    }
    let result;
    try {
      result = revokeToken(root, req.params.name, req.params.id);
    } catch (e) {
      apiError(res, 500, e instanceof Error ? e.message : String(e));
      return;
    }
    if (!result.revoked) {
      apiError(res, 404, `no token ${req.params.id} for ${req.params.name}`);
      return;
    }
    // Revoking the token in use is allowed. It is reported rather than refused:
    // locking yourself out is your business, and vault.json stays hand-editable.
    res.json({ revoked: req.params.id, remaining: result.remaining, wasThisToken: ownToken });
  });

  app.delete('/api/users/:name', (req, res) => {
    const auth = requireApiAuth(root, limiter, req, res);
    if (!auth) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return;
    }
    const user = state.vault.users[req.params.name];
    if (!user) {
      apiError(res, 404, `no user ${req.params.name}`);
      return;
    }
    if (!isSiteAdmin(auth)) {
      apiError(res, 403, 'site admin required to touch another user');
      return;
    }
    // Deleting yourself would leave a vault an owner cannot administer except by
    // hand, and unlike revoking one token it cannot be undone by minting another.
    if (req.params.name === auth.username) {
      apiError(res, 409, 'a user cannot delete themselves; another admin can, or edit vault.json by hand');
      return;
    }
    if (String(req.query.confirm ?? '') !== req.params.name) {
      apiError(res, 400, `to remove this user and every token they hold, send ?confirm=${req.params.name}`);
      return;
    }
    const removed = removeUser(root, req.params.name);
    // Their grants go with them: a collaborator entry or an owners listing
    // left behind would belong to whoever is given this name next.
    if (removed) removeUserGrants(root, req.params.name);
    res.json({ deleted: req.params.name, removed });
  });

  // ---- vault settings ----

  app.get('/api/config', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const config = loadConfig(root);
    res.json({ ...config, themes: themeNames() });
  });

  app.patch('/api/config', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const body = bodyOf(req);
    const changes: { theme?: string; ci?: CiConfig; sites?: SitesConfig; limits?: LimitsConfig } = {};
    if (body.theme !== undefined) {
      if (typeof body.theme !== 'string' || !findTheme(body.theme)) {
        apiError(res, 400, `"theme" must be one of: ${themeNames().join(', ')} (default ${DEFAULT_THEME})`);
        return;
      }
      changes.theme = body.theme;
    }
    if (body.ci !== undefined) {
      if (typeof body.ci !== 'object' || body.ci === null || Array.isArray(body.ci)) {
        apiError(res, 400, '"ci" must be an object');
        return;
      }
      const ci = body.ci as Record<string, unknown>;
      const current = loadConfig(root).ci;
      const number = (v: unknown, fallback: number, min: number) =>
        typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
      changes.ci = {
        runs: number(ci.runs, current.runs, 0),
        days: number(ci.days, current.days, 0),
        artifactMb: number(ci.artifactMb, current.artifactMb, 1),
      };
    }
    // The hostname whose subdomains serve repository sites. Every reader of it
    // calls loadConfig per request, so a change here is in effect on the next
    // one; it is the setting a hosted vault most needs to change, and reaching a
    // volume to edit config.json by hand is the worst step in that whole path.
    if (body.sites !== undefined) {
      if (typeof body.sites !== 'object' || body.sites === null || Array.isArray(body.sites)) {
        apiError(res, 400, '"sites" must be an object');
        return;
      }
      const sites = body.sites as Record<string, unknown>;
      if (typeof sites.host !== 'string') {
        apiError(res, 400, '"sites" takes a "host" string; send "" to serve sites on the forge host again');
        return;
      }
      const host = normalizeHostname(sites.host);
      // loadConfig ignores a value that is not a hostname and uses the default,
      // which is right for a hand-edited file and wrong here: a caller who just
      // asked for a change should be told it was not one, rather than reading
      // back a value they did not send.
      if (host !== '' && !isPlausibleHostname(host)) {
        apiError(
          res,
          400,
          `"${sites.host}" is not a hostname: give at least two labels of letters, digits, and interior hyphens, ` +
            'with no scheme, port, or path'
        );
        return;
      }
      changes.sites = { host };
    }
    // One field of the limits block is writable, and only the one: the daily
    // egress cap is read per request, so a change to it is in force on the next
    // one. The rest of the block is read at startup, so a route that changed it
    // would report a change the running server had not made.
    //
    // The whole block is written back, merged over what is on disk, because
    // saveConfig replaces a top-level key rather than merging into it.
    if (body.limits !== undefined) {
      if (typeof body.limits !== 'object' || body.limits === null || Array.isArray(body.limits)) {
        apiError(res, 400, '"limits" must be an object');
        return;
      }
      const limits = body.limits as Record<string, unknown>;
      const unknown = Object.keys(limits).filter((k) => k !== 'egressGbPerDay');
      if (unknown.length > 0) {
        apiError(
          res,
          400,
          `only "egressGbPerDay" can be set here; ${unknown.join(', ')} ${
            unknown.length === 1 ? 'is' : 'are'
          } read when the server starts, so edit config.json in the vault and restart`
        );
        return;
      }
      const gb = limits.egressGbPerDay;
      if (typeof gb !== 'number' || !Number.isFinite(gb) || gb < 0) {
        apiError(res, 400, '"egressGbPerDay" must be a number of gigabytes, 0 to send without a daily limit');
        return;
      }
      changes.limits = { ...loadConfig(root).limits, egressGbPerDay: gb };
    }
    if (Object.keys(changes).length === 0) {
      apiError(res, 400, 'nothing to change; provide "theme", "ci", "sites", and/or "limits"');
      return;
    }
    // network is deliberately not writable here, and neither is the rest of
    // limits: both are read once at startup, so a route that changed them would
    // report a change the running server had not made. docs/deploying.md says to
    // edit config.json and restart.
    res.json(saveConfig(root, changes));
  });

  // ---- outgoing bytes ----

  /**
   * What the vault has sent today, per repository, and what it sent on the days
   * before. The same numbers /admin/egress shows, for anyone who would rather
   * watch a bill from a script.
   *
   * Owner scope, like the rest of the vault's own settings: the breakdown says
   * which repositories are being read and how heavily, which is more than a
   * collection administrator is owed about a collection that is not theirs.
   */
  app.get('/api/egress', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    if (!egress) {
      apiError(res, 503, 'this server is not counting outgoing bytes');
      return;
    }
    const snap = egress.snapshot();
    res.json({
      ...snap,
      // Said here as well as on the page: a caller adding these numbers up
      // against a hosting bill needs to know what is missing from them.
      lfsBucketExcluded: lfs?.offloaded ?? false,
    });
  });
}
