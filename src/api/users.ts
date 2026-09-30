import { Express, Request, Response } from 'express';
import { LOGIN_LINK_TTL_MS, mintLoginLink } from '../logincodes';
import { AuthLimiter } from '../limit';
import { collectionOwners, isSiteAdmin, removeUserGrants, tokenIsScoped } from '../perms';
import { isValidName, isValidUserName, listCollections } from '../scan';
import { AuthResult, addUserToken, loadVault, removeUser, revokeToken, setSiteAdmin, tokenId } from '../vault';
import { apiError, requireApiAuth as authenticateRequest } from './auth';
import { inviteLink, naming } from '../naming';

// The JSON API's routes about people rather than repositories: who the caller
// is, a one-time sign-in link for the browser, the users, the site-admin bit,
// and tokens. They were part of registerApi and registerAdminApi and are
// registered from the first of them still; they live apart so that a sibling
// application built on these modules (see src/naming.ts) can serve the same
// routes, and so drive the same user commands of the CLI.

export interface UsersApiOptions {
  /**
   * What deleting a user also removes: every grant naming them. mochi's
   * clears collection owners and repository collaborators.
   */
  removeUserGrants?: (root: string, username: string) => void;
}

export function registerUsersApi(app: Express, root: string, authLimiter: AuthLimiter, opts: UsersApiOptions = {}): void {
  const requireApiAuth = (req: Request, res: Response) => authenticateRequest(root, authLimiter, req, res);
  const removeGrants = opts.removeUserGrants ?? removeUserGrants;
  const limiter = authLimiter;

  function sanitizeGlobs(v: unknown): string[] | null | undefined {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length < 200)) {
      return v as string[];
    }
    return null;
  }

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
      by: auth.username,
    });
    res.json({
      username,
      created: result.created,
      token: result.token,
      siteAdmin: result.user.siteAdmin === true,
      ...(naming.invites ? { invite: inviteLink(`${req.protocol}://${req.get('host')}`, username, result.token) } : {}),
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

  // ---- users and their tokens ----

  // A token-scoped token reaches its globs and nothing else, and in
  // particular administers nothing (src/perms.ts). Its own user's token list
  // is something to administer: a scoped token handed to a script could
  // otherwise list and revoke the unrestricted tokens beside it, locking the
  // user out of git and the CLI.
  function requireUnscoped(auth: AuthResult, res: Response): boolean {
    if (!tokenIsScoped(auth)) return true;
    apiError(res, 403, 'a token-scoped token may not list or revoke tokens');
    return false;
  }

  app.get('/api/users/:name', (req, res) => {
    const auth = authenticateRequest(root, limiter, req, res);
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
    if (!requireUnscoped(auth, res)) return;
    res.json({
      name: req.params.name,
      siteAdmin: user.siteAdmin === true,
      tokens: user.tokens.map((t) => ({ id: tokenId(t), created: t.created ?? null, scope: t.scope ?? null })),
    });
  });

  app.get('/api/users/:name/tokens', (req, res) => {
    const auth = authenticateRequest(root, limiter, req, res);
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
    if (!requireUnscoped(auth, res)) return;
    // Never the token, and never the hash either: an id is what revocation
    // takes, and the hash is a credential-shaped thing with no reason to travel.
    res.json({
      tokens: user.tokens.map((t) => ({ id: tokenId(t), created: t.created ?? null, scope: t.scope ?? null })),
    });
  });

  app.delete('/api/users/:name/tokens/:id', (req, res) => {
    const auth = authenticateRequest(root, limiter, req, res);
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
    if (!requireUnscoped(auth, res)) return;
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
    const auth = authenticateRequest(root, limiter, req, res);
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
    if (removed) removeGrants(root, req.params.name);
    res.json({ deleted: req.params.name, removed });
  });
}
