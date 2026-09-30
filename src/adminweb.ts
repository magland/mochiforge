import { Express, Request, Response } from 'express';
import { githubCallbackUrl, safeNext } from './accountweb';
import { loadConfig, saveConfig } from './config';
import { Egress } from './egress';
import * as forms from './forms';
import {
  clearGithubSecret,
  isPlausibleGithubLogin,
  lookupGithubLogin,
  readGithubSecret,
  writeGithubSecret,
} from './githubauth';
import { AdminSection, adminSectionEnabled } from './naming';
import { isSiteAdmin, removeUserGrants } from './perms';
import { isValidName, isValidUserName } from './scan';
import { Viewer, viewerIsAdmin } from './session';
import { THEMES, findTheme, setActiveTheme } from './themes';
import {
  UserRecord,
  addUserToken,
  approveGithub,
  findGithubAccount,
  loadVault,
  removePasskey,
  removeUser,
  revokeToken,
  setSiteAdmin,
  setUserEmails,
  tokenId,
  unapproveGithub,
  unlinkGithub,
} from './vault';
import { ah, fail, field, requireViewerPage, requireViewerPost, urlencodedForm } from './web';

// The site admin's pages: the users (creating them, their tokens, passkeys,
// emails, site admin, deletion), sign-in with GitHub, the theme, and, for a
// vault, the egress budget. They were the end of registerWebOps and are
// registered from it still, so a vault serves what it did; they live apart so
// that a sibling application built on these modules (see src/naming.ts) can
// register the same administration without the forge's repository routes.
//
// Which sections exist is naming.adminSections, read here for the routes and
// by the admin shell for its menu, so the two cannot disagree. The egress
// page needs the forge's byte counter, and is registered only where a
// section list includes it.

const form = urlencodedForm('3mb');

function globsField(req: Request, name: string): string[] | null {
  const parts = field(req, name)
    .split(/[\s,]+/)
    .filter((s) => s.length > 0);
  if (parts.some((s) => s.length >= 200)) return null;
  return parts;
}

/** A GET page for site admins: anyone else is sent to sign in, or refused. */
export function requireAdminPage(root: string, req: Request, res: Response): Viewer | null {
  const viewer = requireViewerPage(root, req, res);
  if (!viewer) return null;
  if (!viewerIsAdmin(viewer)) {
    fail(res, 403, 'Site admin access required (sessions from restricted tokens carry no admin rights).', viewer, '/');
    return null;
  }
  return viewer;
}

/** A form post for site admins, with the session's CSRF value. */
export function requireAdminPost(root: string, req: Request, res: Response): Viewer | null {
  const viewer = requireViewerPost(root, req, res);
  if (!viewer) return null;
  if (!viewerIsAdmin(viewer)) {
    fail(res, 403, 'Site admin access required (sessions from restricted tokens carry no admin rights).', viewer, '/');
    return null;
  }
  return viewer;
}

// Everything under /admin already takes a site admin; the helper survives so
// a page for a weaker audience added later has the check to reach for.
export function canSetVaultWide(viewer: Viewer): boolean {
  return isSiteAdmin(viewer.auth);
}

export interface AdminWebOptions {
  /** The forge's outgoing-byte counter, for the egress page. */
  egress?: Egress;
  /** Whether LFS objects live in a bucket, which the egress page mentions. */
  lfsOffloaded?: boolean;
  /**
   * What deleting a user also removes: every grant naming them, so that a
   * later user given the same name inherits nothing. mochi's clears
   * collection owners and repository collaborators.
   */
  removeUserGrants?: (root: string, username: string) => void;
}

export function registerAdminWeb(app: Express, root: string, opts: AdminWebOptions = {}): void {
  const { egress } = opts;
  const lfs = { offloaded: opts.lfsOffloaded ?? false };
  const removeGrants = opts.removeUserGrants ?? removeUserGrants;
  const has = (section: AdminSection) => adminSectionEnabled(section);

  // ---- user administration ----
  // Users are the site admin's business, mirroring the JSON API: creating
  // them, the site-admin bit, and their tokens. What a user may reach is not
  // set here; it lives with the repositories (collaborators) and collections
  // (owners) that grant it.

  app.get('/admin', (req, res) => {
    const viewer = requireAdminPage(root, req, res);
    if (!viewer) return;
    res.type('html').send(forms.adminIndexPage(viewer, canSetVaultWide(viewer)));
  });

  if (has('egress')) {
    app.get('/admin/egress', (req, res) => {
      const viewer = requireAdminPage(root, req, res);
      if (!viewer) return;
      if (!canSetVaultWide(viewer)) {
        const why = 'The egress budget is vault-wide, so it takes a site admin.';
        fail(res, 403, why, viewer, '/admin');
        return;
      }
      if (!egress) {
        fail(res, 500, 'This server is not counting outgoing bytes.', viewer, '/admin');
        return;
      }
      const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
      res.type('html').send(
        forms.egressPage(viewer, egress.snapshot(), { lfsBucket: lfs?.offloaded ?? false, msg })
      );
    });

    app.post('/admin/egress', form, (req, res) => {
      const viewer = requireAdminPost(root, req, res);
      if (!viewer) return;
      if (!canSetVaultWide(viewer)) {
        const why = 'The egress budget is vault-wide, so it takes a site admin.';
        fail(res, 403, why, viewer, '/admin');
        return;
      }
      const raw = field(req, 'egressGbPerDay').trim();
      const gb = Number(raw);
      if (raw === '' || !Number.isFinite(gb) || gb < 0) {
        fail(res, 400, 'Give a number of gigabytes per day, or 0 to send without a limit.', viewer, '/admin/egress');
        return;
      }
      // The whole block is written back, since saveConfig replaces a top-level key
      // rather than merging into it. Every other field keeps the value it has, so a
      // vault that has tuned its concurrencies by hand does not lose them here.
      saveConfig(root, { limits: { ...loadConfig(root).limits, egressGbPerDay: gb } });
      const msg = gb > 0 ? `Daily egress limit set to ${gb} GB.` : 'Daily egress limit removed.';
      res.redirect(`/admin/egress?msg=${encodeURIComponent(msg)}`);
    });
  }

  if (has('appearance')) {
    app.get('/admin/appearance', (req, res) => {
      const viewer = requireAdminPage(root, req, res);
      if (!viewer) return;
      if (!canSetVaultWide(viewer)) {
        fail(res, 403, 'Changing the theme takes a site admin.', viewer, '/admin');
        return;
      }
      const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
      res.type('html').send(forms.appearancePage(viewer, THEMES, loadConfig(root).theme, msg));
    });

    app.post('/admin/appearance', form, (req, res) => {
      const viewer = requireAdminPost(root, req, res);
      if (!viewer) return;
      if (!canSetVaultWide(viewer)) {
        fail(res, 403, 'Changing the theme takes a site admin.', viewer, '/admin');
        return;
      }
      const name = field(req, 'theme');
      if (!findTheme(name)) {
        fail(res, 400, `Unknown theme: ${name || '(none selected)'}.`, viewer, '/admin/appearance');
        return;
      }
      saveConfig(root, { theme: name });
      setActiveTheme(name);
      res.redirect(`/admin/appearance?msg=${encodeURIComponent(`Theme set to ${name}.`)}`);
    });
  }

  if (has('github')) {
    // ---- sign-in with GitHub, administered ----
    //
    // One page: the OAuth App's credentials, the approved list, and what is
    // already linked. All of it is vault-wide, so all of it takes a site admin,
    // like the theme and the egress budget.

    const githubAdminOnly = (viewer: Viewer, res: Response): boolean => {
      if (canSetVaultWide(viewer)) return true;
      fail(res, 403, 'Sign-in with GitHub is vault-wide, so it takes a site admin.', viewer, '/admin');
      return false;
    };

    app.get('/admin/github', (req, res) => {
      const viewer = requireAdminPage(root, req, res);
      if (!viewer) return;
      if (!githubAdminOnly(viewer, res)) return;
      const state = loadVault(root);
      if (state.status !== 'ok') {
        fail(res, 500, 'The vault is not available.', viewer, '/admin');
        return;
      }
      const approved = (state.vault.githubApproved ?? []).map((a) => ({
        ...a,
        account: findGithubAccount(state.vault, a.id)?.username ?? null,
      }));
      const linked = Object.entries(state.vault.users).flatMap(([username, u]) =>
        u.github ? [{ username, id: u.github.id, login: u.github.login }] : []
      );
      const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
      res.type('html').send(
        forms.adminGithubPage(viewer, {
          clientId: loadConfig(root).auth.githubClientId,
          secretSet: readGithubSecret(root) !== null,
          callbackUrl: githubCallbackUrl(req),
          approved,
          linked,
          msg,
        })
      );
    });

    // The credentials post back to the page's own two-segment URL, like the
    // egress and appearance forms: a third segment named `settings` would be
    // shadowed by the /:collection/:repo/settings route registered above.
    app.post('/admin/github', form, (req, res) => {
      const viewer = requireAdminPost(root, req, res);
      if (!viewer) return;
      if (!githubAdminOnly(viewer, res)) return;
      const clientId = field(req, 'clientId').trim();
      const clientSecret = field(req, 'clientSecret').trim();
      if (clientId === '') {
        saveConfig(root, { auth: { githubClientId: '' } });
        clearGithubSecret(root);
        res.redirect(`/admin/github?msg=${encodeURIComponent('Sign-in with GitHub is off; the stored secret was removed.')}`);
        return;
      }
      if (!/^[\x21-\x7e]{1,100}$/.test(clientId)) {
        fail(res, 400, 'That does not look like a client id.', viewer, '/admin/github');
        return;
      }
      if (clientSecret !== '' && !/^[\x21-\x7e]{1,200}$/.test(clientSecret)) {
        fail(res, 400, 'That does not look like a client secret.', viewer, '/admin/github');
        return;
      }
      saveConfig(root, { auth: { githubClientId: clientId } });
      if (clientSecret !== '') writeGithubSecret(root, clientSecret);
      const ready = readGithubSecret(root) !== null;
      res.redirect(
        `/admin/github?msg=${encodeURIComponent(
          ready ? 'Saved. Sign-in with GitHub is on.' : 'Client id saved. Add the client secret to turn sign-in on.'
        )}`
      );
    });

    app.post(
      '/admin/github/approve',
      form,
      ah(async (req, res) => {
        const viewer = requireAdminPost(root, req, res);
        if (!viewer) return;
        if (!githubAdminOnly(viewer, res)) return;
        const login = field(req, 'login').trim().replace(/^@/, '');
        if (!isPlausibleGithubLogin(login)) {
          fail(res, 400, 'That does not look like a GitHub username.', viewer, '/admin/github');
          return;
        }
        // Resolved to the numeric id now, over GitHub's public API, so the
        // approval survives any later rename of the login.
        const resolved = await lookupGithubLogin(login);
        if (!resolved) {
          fail(res, 404, `GitHub does not know a user ${login}, or could not be reached; try again.`, viewer, '/admin/github');
          return;
        }
        approveGithub(root, resolved);
        res.redirect(`/admin/github?msg=${encodeURIComponent(`Approved ${resolved.login} (GitHub id ${resolved.id}).`)}`);
      })
    );

    app.post('/admin/github/approved/:id/remove', form, (req, res) => {
      const viewer = requireAdminPost(root, req, res);
      if (!viewer) return;
      if (!githubAdminOnly(viewer, res)) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !unapproveGithub(root, id)) {
        fail(res, 404, 'That GitHub account is not on the approved list.', viewer, '/admin/github');
        return;
      }
      res.redirect(`/admin/github?msg=${encodeURIComponent('Approval removed. Accounts already linked keep signing in until unlinked.')}`);
    });

    // The admin's off switch for a GitHub link, beside the ones for tokens and
    // passkeys: the user unlinks their own on /account, and this is for the day
    // they cannot.
    app.post('/admin/users/:name/github/unlink', form, (req, res) => {
      const viewer = requireAdminPost(root, req, res);
      if (!viewer) return;
      const backUrl = `/admin/users/${encodeURIComponent(req.params.name)}`;
      const found = loadUserForAdmin(req, res, viewer, backUrl);
      if (!found) return;
      if (!unlinkGithub(root, found.name)) {
        fail(res, 404, `No GitHub account is linked to ${found.name}.`, viewer, backUrl);
        return;
      }
      res.redirect(`${backUrl}?msg=${encodeURIComponent('GitHub account unlinked.')}`);
    });
  }

  app.get('/admin/users', (req, res) => {
    const viewer = requireAdminPage(root, req, res);
    if (!viewer) return;
    const state = loadVault(root);
    if (state.status !== 'ok') {
      fail(res, 500, 'The vault is not available.', viewer);
      return;
    }
    const users = Object.entries(state.vault.users).map(([name, user]) => ({ name, user }));
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(forms.adminUsersPage(viewer, users, msg));
  });

  app.post('/admin/users', form, (req, res) => {
    const viewer = requireAdminPost(root, req, res);
    if (!viewer) return;
    const username = field(req, 'username').trim();
    const backUrl = '/admin/users';
    if (!isValidUserName(username)) {
      fail(
        res,
        400,
        'A valid username is required (letters, digits, dot, underscore, dash, not starting with a dot).',
        viewer,
        backUrl
      );
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      fail(res, 500, 'The vault is not available.', viewer, backUrl);
      return;
    }
    if (state.vault.users[username]) {
      fail(res, 409, `User ${username} already exists; use Grant or Mint token on the users page instead.`, viewer, backUrl);
      return;
    }
    const result = addUserToken(root, username, { siteAdmin: field(req, 'siteAdmin') === 'true', by: viewer.auth.username });
    res.type('html').send(forms.tokenPage(viewer, username, result.token, true, `${req.protocol}://${req.get('host')}`));
  });

  /**
   * One user, with their tokens laid out and revocable. requireAdminPage has
   * already established the actor is a site admin, which is the whole
   * authorization here, as it is on the JSON API.
   */
  function loadUserForAdmin(
    req: Request,
    res: Response,
    viewer: Viewer,
    backUrl: string
  ): { name: string; user: UserRecord } | null {
    const name = req.params.name;
    if (!isValidName(name)) {
      fail(res, 400, 'Invalid username.', viewer, backUrl);
      return null;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      fail(res, 500, 'The vault is not available.', viewer, backUrl);
      return null;
    }
    const user = state.vault.users[name];
    if (!user) {
      fail(res, 404, `No user ${name}.`, viewer, backUrl);
      return null;
    }
    return { name, user };
  }

  app.get('/admin/users/:name', (req, res) => {
    const viewer = requireAdminPage(root, req, res);
    if (!viewer) return;
    const found = loadUserForAdmin(req, res, viewer, '/admin/users');
    if (!found) return;
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(forms.adminUserPage(viewer, found.name, found.user, msg));
  });

  app.post('/admin/users/:name/tokens/:id/revoke', form, (req, res) => {
    const viewer = requireAdminPost(root, req, res);
    if (!viewer) return;
    const backUrl = `/admin/users/${encodeURIComponent(req.params.name)}`;
    const found = loadUserForAdmin(req, res, viewer, backUrl);
    if (!found) return;
    const wasThisSession = found.name === viewer.auth.username && tokenId(viewer.auth.token) === req.params.id;
    let result;
    try {
      result = revokeToken(root, found.name, req.params.id);
    } catch (e) {
      fail(res, 500, e instanceof Error ? e.message : String(e), viewer, backUrl);
      return;
    }
    if (!result.revoked) {
      fail(res, 404, `No token ${req.params.id} for ${found.name}.`, viewer, backUrl);
      return;
    }
    // Revoking the session's own token is allowed, and the session it ends is
    // this one: the redirect lands on the sign-in page rather than pretending
    // otherwise.
    if (wasThisSession) {
      res.redirect('/login');
      return;
    }
    res.redirect(`${backUrl}?msg=${encodeURIComponent(`Revoked token ${req.params.id}.`)}`);
  });

  // The admin's off switch for a passkey, beside the one for tokens: the
  // user removes their own on /account, and this is for the day they cannot.
  app.post('/admin/users/:name/passkeys/:id/delete', form, (req, res) => {
    const viewer = requireAdminPost(root, req, res);
    if (!viewer) return;
    const backUrl = `/admin/users/${encodeURIComponent(req.params.name)}`;
    const found = loadUserForAdmin(req, res, viewer, backUrl);
    if (!found) return;
    if (!removePasskey(root, found.name, req.params.id)) {
      fail(res, 404, `No such passkey for ${found.name}.`, viewer, backUrl);
      return;
    }
    res.redirect(`${backUrl}?msg=${encodeURIComponent('Passkey removed.')}`);
  });

  app.post('/admin/users/:name/emails', form, (req, res) => {
    const viewer = requireAdminPost(root, req, res);
    if (!viewer) return;
    const backUrl = `/admin/users/${encodeURIComponent(req.params.name)}`;
    const found = loadUserForAdmin(req, res, viewer, backUrl);
    if (!found) return;
    const emails = field(req, 'emails')
      .split(/[\s,]+/)
      .filter((s) => s.length > 0);
    // The shape check is deliberately loose -- an @ with something either
    // side -- since git itself enforces nothing about author emails and the
    // point is to match whatever this person's commits actually carry.
    const bad = emails.find((e) => e.length >= 200 || !/^[^@\s]+@[^@\s]+$/.test(e));
    if (bad !== undefined) {
      fail(res, 400, `That does not look like an email: ${bad}`, viewer, backUrl);
      return;
    }
    setUserEmails(root, found.name, emails);
    const msg = emails.length ? `Emails saved for ${found.name}.` : `Emails cleared for ${found.name}.`;
    res.redirect(`${backUrl}?msg=${encodeURIComponent(msg)}`);
  });

  app.post('/admin/users/:name/delete', form, (req, res) => {
    const viewer = requireAdminPost(root, req, res);
    if (!viewer) return;
    const backUrl = `/admin/users/${encodeURIComponent(req.params.name)}`;
    const found = loadUserForAdmin(req, res, viewer, backUrl);
    if (!found) return;
    // Deleting yourself would leave a vault its owner cannot administer except
    // by hand, and unlike revoking one token it cannot be undone by minting
    // another.
    if (found.name === viewer.auth.username) {
      fail(res, 409, 'A user cannot delete themselves; another admin can, or edit vault.json by hand.', viewer, backUrl);
      return;
    }
    if (field(req, 'confirm').trim() !== found.name) {
      fail(res, 400, `Type ${found.name} exactly to confirm deletion.`, viewer, backUrl);
      return;
    }
    // Their grants go with them: a collaborator entry or an owners listing
    // left behind would belong to whoever is given this name next.
    if (removeUser(root, found.name)) removeGrants(root, found.name);
    res.redirect(`/admin/users?msg=${encodeURIComponent(`Deleted ${found.name} and revoked their tokens.`)}`);
  });

  app.post('/admin/users/:name/grant', form, (req, res) => {
    const viewer = requireAdminPost(root, req, res);
    if (!viewer) return;
    const username = req.params.name;
    const backUrl = safeNext(field(req, 'next')) === '/' ? '/admin/users' : safeNext(field(req, 'next'));
    if (!isValidName(username)) {
      fail(res, 400, 'Invalid username.', viewer, backUrl);
      return;
    }
    const value = field(req, 'siteAdmin');
    if (value !== 'true' && value !== 'false') {
      fail(res, 400, 'Say whether to grant or withdraw site admin.', viewer, backUrl);
      return;
    }
    try {
      setSiteAdmin(root, username, value === 'true');
    } catch (e) {
      fail(res, 404, e instanceof Error ? e.message : String(e), viewer, backUrl);
      return;
    }
    const msg = value === 'true' ? `${username} is now a site admin.` : `${username} is no longer a site admin.`;
    res.redirect(`${backUrl}?msg=${encodeURIComponent(msg)}`);
  });

  app.post('/admin/users/:name/token', form, (req, res) => {
    const viewer = requireAdminPost(root, req, res);
    if (!viewer) return;
    const username = req.params.name;
    const backUrl = '/admin/users';
    if (!isValidName(username)) {
      fail(res, 400, 'Invalid username.', viewer, backUrl);
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      fail(res, 500, 'The vault is not available.', viewer, backUrl);
      return;
    }
    const existing = state.vault.users[username];
    if (!existing) {
      fail(res, 404, `User ${username} does not exist.`, viewer, backUrl);
      return;
    }
    const tokenScope = globsField(req, 'tokenScope');
    if (tokenScope === null) {
      fail(res, 400, 'Token scope globs are too long.', viewer, backUrl);
      return;
    }
    const result = addUserToken(root, username, {
      tokenScope: tokenScope.length ? tokenScope : undefined,
      by: viewer.auth.username,
    });
    res.type('html').send(forms.tokenPage(viewer, username, result.token, false, `${req.protocol}://${req.get('host')}`));
  });
}
