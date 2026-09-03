import express, { Express, Request, Response } from 'express';
import * as fs from 'fs';
import { CiEngine } from './ci/engine';
import { isPlausibleHostname, loadConfig, saveConfig } from './config';
import { Egress } from './egress';
import { isValidNewRepoPath, isValidRefName, isValidRepoPath, isValidSha } from './git';
import { firePush } from './ci/trigger';
import { AuthLimiter } from './limit';
import { LfsContext } from './lfsstore';
import { collectionDir } from './layout';
import { looksLikePointer } from './pointer';
import { THEMES, findTheme, setActiveTheme } from './themes';
import * as forms from './forms';
import * as ops from './ops';
import { MAX_EDIT_SIZE, MAX_UPLOAD_SIZE, OpError, opErrorStatus } from './ops';
import { isAgeFile, looksLikeAge } from './agefile';
import { parseTopicsInput, repoTopics, setTopics } from './topics';
import {
  displayName,
  findRepo,
  isValidName,
  isValidUserName,
  listCollections,
  listRepoDirs,
  repoDescription,
  reservedRepoSuffix,
  siteDir,
} from './scan';
import { clearRepoDomain, repoDomain, setRepoDomain } from './domains';
import { isReservedSiteLabel, normalizeHostname, reservedSiteLabels } from './siteshost';
import {
  collectionAliasConflict,
  collectionSiteAlias,
  collectionSiteAliases,
  editSiteSettings,
  isUsableCollectionAlias,
  isUsableSiteLabel,
  listSiteLabels,
  setCollectionAlias,
  siteHostFor,
  siteLabelConflict,
  siteSettings,
  storedCollectionAlias,
} from './sitesettings';
import {
  Viewer,
  clearSessionCookie,
  csrfMatches,
  getViewer,
  setSessionCookie,
  viewerIsAdmin,
  originOk,
} from './session';
import {
  addCollectionOwner,
  atLeast,
  canAdminCollection,
  canCreateCollection,
  canCreateRepo,
  canCreateSomeRepo,
  collectionOwners,
  isSiteAdmin,
  removeCollaborator,
  removeCollectionOwner,
  removeUserGrants,
  repoAccess,
  repoRenameBlocker,
  setCollaborator,
  setRepoPrivate,
} from './perms';
import {
  UserRecord,
  addPasskey,
  approveGithub,
  authForBinding,
  authenticate,
  findGithubAccount,
  findPasskey,
  githubBinding,
  linkGithub,
  loadVault,
  addUserToken,
  passkeyBinding,
  removePasskey,
  removeUser,
  resolveGithubSignIn,
  revokeToken,
  setPasskeyCounter,
  setSiteAdmin,
  setUserEmails,
  setUserProfile,
  tokenId,
  unapproveGithub,
  unlinkGithub,
} from './vault';
import {
  clearGithubSecret,
  exchangeGithubCode,
  fetchGithubUser,
  githubAuthorizeUrl,
  githubConfigured,
  isPlausibleGithubLogin,
  lookupGithubLogin,
  readGithubSecret,
  writeGithubSecret,
} from './githubauth';
import {
  SUPPORTED_ALGS,
  WebAuthnError,
  claimedChallenge,
  fromB64url,
  verifyAssertion,
  verifyRegistration,
} from './webauthn';
import { createOneTimeStore } from './onetime';
import { HANDOFF_TTL_MS, mintHandoff, peekLoginLink, takeHandoff, takeLoginLink } from './logincodes';
import { encPath, repoUrl } from './views';
import {
  LoadedRepo,
  ah,
  fail,
  field,
  loadRepo,
  makeCtx,
  requireViewerPage,
  requireViewerPost,
  send404,
  urlencodedForm,
  wildcard,
} from './web';
import { isBinary } from './render';
import { renderMarkdown } from './markdown';
import { boundaryOf, parseMultipart, partField, partFiles } from './multipart';

function urlOf(repo: { collection: string; name: string }): string {
  return repoUrl({ collection: repo.collection, repo: repo.name });
}

// UI operations: every handler here re-derives the actor's abilities from
// live vault.json (via the session cookie) and checks the CSRF field before
// calling into the ops layer. All POSTs follow POST-redirect-GET.

// The largest body here is a file being edited in the browser, and the editor
// accepts files up to MAX_EDIT_SIZE, so the limit has to leave room for a
// megabyte of text after percent-encoding.
const form = urlencodedForm('3mb');

/**
 * The commit box posts a summary and an optional extended description; git's
 * convention joins them with a blank line. An empty summary falls back to the
 * placeholder the form showed, so a commit is never made with no subject.
 */
function commitMessage(req: Request, fallback: string): string {
  const summary = field(req, 'message').trim() || fallback;
  const description = field(req, 'description').trim();
  return description ? `${summary}\n\n${description}` : summary;
}

/**
 * Where signing in returns to: a path on this vault, or the front page.
 *
 * The sign-in page is the one place in the interface that asks for a token, so
 * it is the one place a redirect elsewhere is worth the most to somebody else.
 * A leading `//` is refused because the browser reads it as an authority, and a
 * leading `/\` for the same reason: the URL standard treats a backslash as a
 * slash for http and https, `Location: /\evil.com` therefore resolves to
 * http://evil.com, and the header carries the character through unencoded. A
 * control character is refused too, since a browser strips tab and newline out
 * of a URL before parsing it, which would turn `/<tab>/evil.com` into the
 * authority the first two checks just refused.
 */
function safeNext(v: string): string {
  if (!v.startsWith('/')) return '/';
  if (v[1] === '/' || v[1] === '\\') return '/';
  if (/[\x00-\x1f\x7f]/.test(v)) return '/';
  return v;
}

function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function globsField(req: Request, name: string): string[] | null {
  const parts = field(req, name)
    .split(/[\s,]+/)
    .filter((s) => s.length > 0);
  if (parts.some((s) => s.length >= 200)) return null;
  return parts;
}

export function registerWebOps(
  app: Express,
  root: string,
  authLimiter: AuthLimiter,
  lfs: LfsContext | null = null,
  engine?: CiEngine,
  egress?: Egress
): void {
  // What a repository move or removal has to carry with it, built once here so
  // that no handler has to remember either half. See RepoContext in ops.ts.
  const repoCtx: ops.RepoContext = { lfs: lfs?.store, runs: engine };

  // A commit made in the browser is a push like any other as far as workflows
  // are concerned, so the same event goes to the CI engine, through the same
  // function the API write paths use.
  const fire = (
    repo: { dir: string; collection: string; name: string },
    branch: string,
    before: string | null,
    after: string,
    actor: string
  ) => firePush(root, engine, repo, branch, before, after, actor);

  /**
   * The branch the form asked to commit to, when "commit to a new branch" was
   * ticked. Creating it is ops.writeFile's business; reading the form is this
   * function's, and an empty name means the box was ticked without one.
   */
  function newBranchWanted(req: Request): string | null {
    if (field(req, 'newBranchWanted') !== '1') return null;
    const wanted = field(req, 'newBranch').trim();
    if (wanted === '') throw new OpError('Name the new branch, or untick the box to commit to this one.');
    return wanted;
  }

  function authorFor(viewer: Viewer, req: Request): ops.CommitAuthor {
    const host = (req.get('host') ?? 'localhost').replace(/:\d+$/, '');
    return { name: viewer.auth.username, email: `${viewer.auth.username}@noreply.${host}` };
  }

  // ---- sign in / sign out ----

  app.get('/login', (req, res) => {
    const next = safeNext(String(req.query.next ?? '/'));
    if (getViewer(req, root)) {
      res.redirect(next);
      return;
    }
    res.type('html').send(forms.loginPage(next, undefined, githubConfigured(root)));
  });

  // A sign-in form posted from another site is refused. None of these
  // handlers have a session to check a CSRF token against, since their whole
  // purpose is to start one, so the Origin header is the check: a browser
  // sends it on every cross-site POST, and a page elsewhere that auto-submits
  // an attacker's own username and token would otherwise sign the visitor in
  // as the attacker without their noticing. A request with no Origin is
  // allowed, as it is for the CSRF check: plenty of clients send none.
  function refuseCrossSite(req: Request, res: Response): boolean {
    if (originOk(req)) return false;
    fail(res, 403, 'This sign-in was posted from another site and was not accepted.', null, '/login');
    return true;
  }

  app.post('/login', form, (req, res) => {
    if (refuseCrossSite(req, res)) return;
    const next = safeNext(field(req, 'next'));
    const github = githubConfigured(root);
    const state = loadVault(root);
    if (state.status !== 'ok') {
      res
        .status(500)
        .type('html')
        .send(forms.loginPage(next, 'The vault is not available; try again later.', github));
      return;
    }
    const username = field(req, 'username');
    // Throttled per address, and per address and username together, so that one
    // person mistyping a token does not lock out everyone behind the same
    // address. Never per account: anyone could then lock an owner out by
    // presenting wrong tokens for their username.
    const allowed = authLimiter.allow(req, username);
    if (!allowed.ok) {
      const minutes = Math.max(1, Math.ceil(allowed.retryAfter / 60));
      res.status(429).setHeader('Retry-After', String(allowed.retryAfter));
      res
        .type('html')
        .send(
          forms.loginPage(
            next,
            `Too many failed sign-in attempts from this address. Try again in ${minutes} minute${
              minutes === 1 ? '' : 's'
            }.`,
            github
          )
        );
      return;
    }
    const auth = authenticate(state.vault, username, field(req, 'token'));
    if (!auth) {
      authLimiter.fail(req, username);
      // One generic message: no username/token distinction. The refusal above
      // says nothing about whether the username exists either.
      res.status(401).type('html').send(forms.loginPage(next, 'Invalid username or token.', github));
      return;
    }
    setSessionCookie(req, res, root, auth);
    res.redirect(next);
  });

  // Cleared without a CSRF check: signing someone out is not an action worth
  // forging, and requiring a live token would leave a stale form redirecting
  // to / still signed in with no sign anything went wrong.
  app.post('/logout', form, (_req, res) => {
    clearSessionCookie(res);
    res.redirect('/');
  });

  // ---- passkeys, the account page, and sign-in codes ----
  //
  // Three more ways into a session, all ending at the same setSessionCookie
  // the token form uses: a passkey (WebAuthn), a short code shown by a
  // signed-in browser, and a one-time link minted by `mochi web` against the
  // API. The WebAuthn endpoints speak JSON because the ceremonies run through
  // fetch; everything else is ordinary forms.

  const jsonForm = express.json({ limit: '64kb' });

  // Pending WebAuthn challenges. The store's opaque id is the challenge
  // itself: finishing a ceremony hands it back inside clientDataJSON, so
  // nothing else has to travel, and taking it makes each challenge one use.
  const registrationChallenges = createOneTimeStore<{ username: string }>();
  const loginChallenges = createOneTimeStore<true>();
  const CHALLENGE_TTL_MS = 2 * 60 * 1000;
  const WEBAUTHN_TIMEOUT_MS = 120000;

  // The RP ID is the hostname the vault is being served under, which is what
  // scopes a passkey to this vault: a key made for one hostname does not
  // answer for another, and moving a vault to a new domain means registering
  // new passkeys (tokens keep working, so nobody is locked out by the move).
  const rpIdOf = (req: Request) => req.hostname;
  const originOf = (req: Request) => `${req.protocol}://${req.get('host')}`;

  // A restricted token may not add passkeys or hand off sessions broader than
  // itself: a passkey signs in with the user's full standing, so minting one
  // from a session that does not have it would widen the token it came from.
  const restricted = (viewer: Viewer) => viewer.auth.token.scope !== undefined;

  function jsonViewer(req: Request, res: Response): Viewer | null {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.status(403).json({ error: 'You are signed out. Reload the page and sign in.' });
      return null;
    }
    if (!csrfMatches(req, field(req, 'csrf'), viewer)) {
      res.status(403).json({ error: 'The page has expired; reload it and try again.' });
      return null;
    }
    return viewer;
  }

  app.get('/account', (req, res) => {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return;
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(
      forms.accountPage(viewer, {
        restricted: restricted(viewer),
        msg,
        github: { enabled: githubConfigured(root), account: viewer.auth.user.github ?? null },
      })
    );
  });

  app.post('/account/passkeys/challenge', jsonForm, (req, res) => {
    const viewer = jsonViewer(req, res);
    if (!viewer) return;
    if (restricted(viewer)) {
      res.status(403).json({ error: 'A session from a restricted token may not add passkeys.' });
      return;
    }
    const username = viewer.auth.username;
    res.json({
      challenge: registrationChallenges.put({ username }, CHALLENGE_TTL_MS),
      rp: { id: rpIdOf(req), name: `Mochi Forge (${rpIdOf(req)})` },
      // The user handle is what a later usernameless sign-in identifies the
      // account by; usernames are short and stable, so they are it, verbatim.
      user: { id: Buffer.from(username, 'utf8').toString('base64url'), name: username, displayName: username },
      pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
      // Resident keys, so signing in needs no username typed first; every
      // platform authenticator that offers passkeys keeps them.
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      timeout: WEBAUTHN_TIMEOUT_MS,
      attestation: 'none',
      excludeCredentials: (viewer.auth.user.passkeys ?? []).map((p) => ({ type: 'public-key', id: p.id })),
    });
  });

  app.post('/account/passkeys', jsonForm, (req, res) => {
    const viewer = jsonViewer(req, res);
    if (!viewer) return;
    if (restricted(viewer)) {
      res.status(403).json({ error: 'A session from a restricted token may not add passkeys.' });
      return;
    }
    let clientDataJSON: Buffer;
    let attestationObject: Buffer;
    try {
      clientDataJSON = fromB64url(field(req, 'clientDataJSON'));
      attestationObject = fromB64url(field(req, 'attestationObject'));
    } catch {
      res.status(400).json({ error: 'The registration payload is not base64url.' });
      return;
    }
    const challenge = claimedChallenge(clientDataJSON);
    const pending = challenge ? registrationChallenges.take(challenge) : null;
    if (!pending || pending.username !== viewer.auth.username) {
      res.status(400).json({ error: 'The challenge is missing or expired; try again.' });
      return;
    }
    let reg;
    try {
      reg = verifyRegistration({
        attestationObject,
        clientDataJSON,
        challenge: challenge as string,
        origin: originOf(req),
        rpId: rpIdOf(req),
      });
    } catch (e) {
      res.status(400).json({ error: e instanceof WebAuthnError ? e.message : 'The registration could not be verified.' });
      return;
    }
    const name = field(req, 'name').trim().slice(0, 60);
    try {
      addPasskey(root, viewer.auth.username, {
        id: reg.id,
        publicKey: reg.publicKey,
        alg: reg.alg,
        counter: reg.counter,
        ...(name ? { name } : {}),
      });
    } catch (e) {
      res.status(409).json({ error: e instanceof Error ? e.message : 'The passkey could not be stored.' });
      return;
    }
    res.json({ next: `/account?msg=${encodeURIComponent(`Passkey ${name ? `${name} ` : ''}added.`)}` });
  });

  app.post('/account/passkeys/:id/delete', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const wasThisSession = viewer.auth.token.hash === passkeyBinding(req.params.id);
    if (!removePasskey(root, viewer.auth.username, req.params.id)) {
      fail(res, 404, 'No such passkey on your account.', viewer, '/account');
      return;
    }
    // Removing the passkey this session signed in with ends this session; the
    // redirect says so instead of pretending otherwise.
    if (wasThisSession) {
      res.redirect('/login');
      return;
    }
    res.redirect(`/account?msg=${encodeURIComponent('Passkey removed.')}`);
  });

  app.post('/account/link', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    // The new session is bound to whatever this one is -- the same token
    // hash (scope and all), or the same passkey -- so nothing new is minted,
    // nothing widens, and one revocation ends both.
    const code = mintHandoff(root, viewer.auth.username, viewer.auth.token.hash);
    res.type('html').send(forms.accountLinkPage(viewer, code, Math.round(HANDOFF_TTL_MS / 60000)));
  });

  app.get('/login/link', (req, res) => {
    const next = safeNext(String(req.query.next ?? '/'));
    if (getViewer(req, root)) {
      res.redirect(next);
      return;
    }
    res.type('html').send(forms.loginLinkPage(next));
  });

  // Redeeming any kind of sign-in code shares the token form's rate limiter:
  // a code is a credential being presented, and guessing them is the same
  // attack mistyping tokens is throttled as.
  function redeemPending(
    req: Request,
    res: Response,
    pending: { username: string; binding: string; next?: string } | null,
    renderRefusal: (error: string, status: number) => void
  ): void {
    if (!pending) {
      authLimiter.fail(req, null);
      renderRefusal('That code is not valid. Codes work once and expire after a few minutes.', 401);
      return;
    }
    const state = loadVault(root);
    const auth = state.status === 'ok' ? authForBinding(state.vault, pending.username, pending.binding) : null;
    if (!auth) {
      renderRefusal('The credential behind this code has been revoked; sign in another way.', 403);
      return;
    }
    setSessionCookie(req, res, root, auth);
    res.redirect(safeNext(pending.next ?? field(req, 'next')));
  }

  app.post('/login/link', form, (req, res) => {
    if (refuseCrossSite(req, res)) return;
    const next = safeNext(field(req, 'next'));
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      res.status(429).setHeader('Retry-After', String(allowed.retryAfter));
      res.type('html').send(forms.loginLinkPage(next, 'Too many attempts from this address. Try again later.'));
      return;
    }
    redeemPending(req, res, takeHandoff(root, field(req, 'code')), (error, status) => {
      res.status(status).type('html').send(forms.loginLinkPage(next, error));
    });
  });

  // The landing page of a `mochi web` link: it looks the code up without
  // consuming it and asks for a click, so a GET never changes who the browser
  // is and a prefetch cannot burn the code.
  app.get('/login/code/:code', (req, res) => {
    const pending = peekLoginLink(root, req.params.code);
    if (!pending) {
      fail(res, 404, 'This sign-in link has expired or was already used. Run mochi web again for a fresh one.', null, '/login');
      return;
    }
    res.type('html').send(forms.loginLinkConfirmPage(pending.username, req.params.code, safeNext(pending.next ?? '/')));
  });

  app.post('/login/code', form, (req, res) => {
    if (refuseCrossSite(req, res)) return;
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      res.status(429).setHeader('Retry-After', String(allowed.retryAfter));
      fail(res, 429, 'Too many attempts from this address. Try again later.', null, '/login');
      return;
    }
    redeemPending(req, res, takeLoginLink(root, field(req, 'code')), (error, status) => {
      fail(res, status, error, null, '/login');
    });
  });

  app.post('/login/passkey/challenge', jsonForm, (req, res) => {
    res.json({
      challenge: loginChallenges.put(true, CHALLENGE_TTL_MS),
      rpId: rpIdOf(req),
      timeout: WEBAUTHN_TIMEOUT_MS,
      userVerification: 'preferred',
    });
  });

  app.post('/login/passkey', jsonForm, (req, res) => {
    if (!originOk(req)) {
      res.status(403).json({ error: 'This sign-in was posted from another site and was not accepted.' });
      return;
    }
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      res.setHeader('Retry-After', String(allowed.retryAfter));
      res.status(429).json({ error: 'Too many failed sign-in attempts from this address; try again later.' });
      return;
    }
    let clientDataJSON: Buffer;
    let authenticatorData: Buffer;
    let signature: Buffer;
    try {
      clientDataJSON = fromB64url(field(req, 'clientDataJSON'));
      authenticatorData = fromB64url(field(req, 'authenticatorData'));
      signature = fromB64url(field(req, 'signature'));
    } catch {
      res.status(400).json({ error: 'The sign-in payload is not base64url.' });
      return;
    }
    const challenge = claimedChallenge(clientDataJSON);
    if (!challenge || !loginChallenges.take(challenge)) {
      res.status(400).json({ error: 'The challenge is missing or expired; try again.' });
      return;
    }
    const state = loadVault(root);
    if (state.status !== 'ok') {
      res.status(500).json({ error: 'The vault is not available; try again later.' });
      return;
    }
    const found = findPasskey(state.vault, field(req, 'id'));
    if (!found) {
      authLimiter.fail(req, null);
      res.status(401).json({ error: 'This passkey is not registered on this vault.' });
      return;
    }
    // The authenticator says whose credential it presented; when it does, it
    // must agree with where the credential id was found.
    const handle = field(req, 'userHandle');
    if (handle) {
      let claimed: string;
      try {
        claimed = fromB64url(handle).toString('utf8');
      } catch {
        claimed = '';
      }
      if (claimed !== found.username) {
        authLimiter.fail(req, null);
        res.status(401).json({ error: 'The passkey does not match its account.' });
        return;
      }
    }
    let assertion;
    try {
      assertion = verifyAssertion({
        authenticatorData,
        clientDataJSON,
        signature,
        publicKey: found.passkey.publicKey,
        alg: found.passkey.alg,
        challenge,
        origin: originOf(req),
        rpId: rpIdOf(req),
      });
    } catch (e) {
      authLimiter.fail(req, null);
      res.status(401).json({ error: e instanceof WebAuthnError ? e.message : 'The sign-in could not be verified.' });
      return;
    }
    // A counter that moved backwards means two devices hold this key, which
    // resident passkeys do legitimately (they sync); most report 0 and skip
    // this entirely. Only an actual regression from a counter-keeping key is
    // refused.
    if (assertion.counter > 0 && found.passkey.counter > 0 && assertion.counter <= found.passkey.counter) {
      authLimiter.fail(req, null);
      res.status(401).json({ error: 'The passkey presented an old signature counter; remove and re-register it.' });
      return;
    }
    if (assertion.counter > 0) setPasskeyCounter(root, found.username, found.passkey.id, assertion.counter);
    setSessionCookie(req, res, root, {
      username: found.username,
      user: found.user,
      token: { hash: passkeyBinding(found.passkey.id) },
    });
    res.json({ next: safeNext(field(req, 'next')) });
  });

  // ---- sign in with GitHub ----
  //
  // The OAuth code flow, ending at the same setSessionCookie as every other
  // way in. The state parameter is a one-time id from the same kind of store
  // the WebAuthn challenges use, so a callback that was not started here, or
  // is replayed, redeems nothing; an entry marked with `link` was started by
  // a signed-in user's own CSRF-checked form and attaches the GitHub account
  // to them instead of signing anyone in. The access token GitHub hands back
  // is used for one request -- who is this -- and dropped. The session is
  // bound to gh:<numeric id> and resolves against live vault.json on every
  // request (authForBinding in src/vault.ts), so unlinking the account ends
  // its sessions the way revoking a token does.

  const githubStates = createOneTimeStore<{ next: string; link?: string }>();
  const GITHUB_STATE_TTL_MS = 10 * 60 * 1000;
  const githubCallbackUrl = (req: Request) => `${req.protocol}://${req.get('host')}/login/github/callback`;

  app.get('/login/github', (req, res) => {
    const next = safeNext(String(req.query.next ?? '/'));
    if (getViewer(req, root)) {
      res.redirect(next);
      return;
    }
    if (!githubConfigured(root)) {
      fail(res, 404, 'Sign-in with GitHub is not configured on this vault.', null, '/login');
      return;
    }
    const state = githubStates.put({ next }, GITHUB_STATE_TTL_MS);
    res.redirect(githubAuthorizeUrl(loadConfig(root).auth.githubClientId, githubCallbackUrl(req), state));
  });

  // Linking starts from a POST on the account page, so the CSRF check has
  // already vouched that the account's owner asked for it; the state entry
  // carries their name to the callback. A restricted session may not link,
  // for the passkey rule's reason: signing in with GitHub carries the user's
  // full standing, so minting the way in from a session that does not have it
  // would widen the token it came from.
  app.post('/account/github', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    if (restricted(viewer)) {
      fail(res, 403, 'A session from a restricted token may not link a GitHub account.', viewer, '/account');
      return;
    }
    if (!githubConfigured(root)) {
      fail(res, 404, 'Sign-in with GitHub is not configured on this vault.', viewer, '/account');
      return;
    }
    const state = githubStates.put({ next: '/account', link: viewer.auth.username }, GITHUB_STATE_TTL_MS);
    res.redirect(githubAuthorizeUrl(loadConfig(root).auth.githubClientId, githubCallbackUrl(req), state));
  });

  app.get(
    '/login/github/callback',
    ah(async (req, res) => {
      // The shared sign-in limiter: a forged or replayed callback is a
      // credential being guessed, like a mistyped token.
      const allowed = authLimiter.allow(req, null);
      if (!allowed.ok) {
        res.setHeader('Retry-After', String(allowed.retryAfter));
        fail(res, 429, 'Too many attempts from this address. Try again later.', null, '/login');
        return;
      }
      const pending = githubStates.take(String(req.query.state ?? ''));
      if (!pending) {
        authLimiter.fail(req, null);
        fail(
          res,
          400,
          'This sign-in attempt is stale or was not started here; start again from the sign-in page.',
          null,
          '/login'
        );
        return;
      }
      const code = String(req.query.code ?? '');
      if (code === '') {
        // GitHub answers a cancelled authorization with ?error=access_denied
        // and no code: a choice, not a failure worth a limiter charge.
        fail(res, 400, 'GitHub did not complete the sign-in.', null, '/login');
        return;
      }
      const clientId = loadConfig(root).auth.githubClientId;
      const clientSecret = readGithubSecret(root);
      if (clientId === '' || clientSecret === null) {
        fail(res, 404, 'Sign-in with GitHub is not configured on this vault.', null, '/login');
        return;
      }
      const accessToken = await exchangeGithubCode({
        clientId,
        clientSecret,
        code,
        redirectUri: githubCallbackUrl(req),
      });
      const account = accessToken === null ? null : await fetchGithubUser(accessToken);
      // The access token's one use has been made; nothing keeps it.
      if (!account) {
        fail(res, 502, 'GitHub did not confirm the sign-in; try again.', null, '/login');
        return;
      }
      if (pending.link !== undefined) {
        const viewer = getViewer(req, root);
        if (!viewer || viewer.auth.username !== pending.link || restricted(viewer)) {
          fail(
            res,
            403,
            'The session that started linking is gone; sign in and link again from your account page.',
            null,
            '/account'
          );
          return;
        }
        try {
          linkGithub(root, viewer.auth.username, account);
        } catch (e) {
          fail(res, 409, e instanceof Error ? e.message : String(e), viewer, '/account');
          return;
        }
        res.redirect(`/account?msg=${encodeURIComponent(`Linked GitHub account ${account.login}.`)}`);
        return;
      }
      const outcome = resolveGithubSignIn(root, account);
      if (outcome.kind === 'refused') {
        authLimiter.fail(req, null);
        fail(
          res,
          403,
          `The GitHub account ${account.login} is not authorized on this vault. An administrator can approve it, ` +
            'or you can link it from your account page if you already have an account here.',
          null,
          '/login'
        );
        return;
      }
      if (outcome.kind === 'error') {
        fail(res, 409, outcome.message, null, '/login');
        return;
      }
      const state = loadVault(root);
      const auth = state.status === 'ok' ? authForBinding(state.vault, outcome.username, githubBinding(account.id)) : null;
      if (!auth) {
        fail(res, 500, 'The vault is not available; try again later.', null, '/login');
        return;
      }
      setSessionCookie(req, res, root, auth);
      res.redirect(safeNext(pending.next));
    })
  );

  app.post('/account/github/unlink', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const linked = viewer.auth.user.github;
    if (!linked) {
      fail(res, 404, 'No GitHub account is linked.', viewer, '/account');
      return;
    }
    // An account whose GitHub link is its only credential would be stranded
    // by unlinking -- and, if its GitHub id is still on the approved list, a
    // later sign-in would mint a second account beside the orphan. Refused
    // with the way out named instead.
    if (viewer.auth.user.tokens.length === 0 && !viewer.auth.user.passkeys?.length) {
      fail(
        res,
        409,
        'This GitHub link is the only way this account can sign in. Add a passkey, or have an administrator mint a token, before unlinking it.',
        viewer,
        '/account'
      );
      return;
    }
    const wasThisSession = viewer.auth.token.hash === githubBinding(linked.id);
    unlinkGithub(root, viewer.auth.username);
    // Unlinking the credential this session signed in with ends this session;
    // the redirect says so instead of pretending otherwise.
    if (wasThisSession) {
      res.redirect('/login');
      return;
    }
    res.redirect(`/account?msg=${encodeURIComponent('GitHub account unlinked.')}`);
  });

  // ---- the signed-in user's own profile ----

  // The profile a user's page at /<username> shows. The name "settings" is
  // reserved as a collection name, so this path can never shadow one, and the
  // route registers before the generic /:collection/:repo browse routes.
  app.get('/settings/profile', (req, res) => {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return;
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(forms.profileSettingsPage(viewer, viewer.auth.user.profile, msg));
  });

  app.post('/settings/profile', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const rerender = (status: number, error: string) => {
      res.status(status).type('html').send(forms.profileSettingsPage(viewer, viewer.auth.user.profile, undefined, error));
    };
    const displayName = field(req, 'displayName').trim();
    const bio = field(req, 'bio').trim();
    if (displayName.length > 80 || /[\r\n]/.test(displayName)) {
      rerender(400, 'The display name must be one line of at most 80 characters.');
      return;
    }
    if (bio.length > 500) {
      rerender(400, 'The bio must be at most 500 characters.');
      return;
    }
    const links = field(req, 'links')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (links.length > 5) {
      rerender(400, 'At most five links.');
      return;
    }
    // http(s) only: these render as hyperlinks on a page other people read,
    // and nothing else belongs in an href there.
    const bad = links.find((l) => l.length > 200 || !/^https?:\/\/\S+$/i.test(l));
    if (bad !== undefined) {
      rerender(400, `That does not look like an http(s) URL: ${bad}`);
      return;
    }
    setUserProfile(root, viewer.auth.username, { name: displayName, bio, links });
    res.redirect(`/settings/profile?msg=${encodeURIComponent('Profile saved.')}`);
  });

  // ---- new repository, new collection, import ----

  // Importing is a client-side operation: git copies the repository from its
  // current home and pushes it here, where push-to-create makes it. The server
  // never fetches from another host, so it needs no outbound access, no stored
  // credentials for other services, and no work that outlives a request. What
  // performs it is `mochi import` on the operator's machine, and this page
  // only says what to run: no form, since there is nothing here to submit to.
  app.get('/import', (req, res) => {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return;
    const asked = typeof req.query.collection === 'string' ? req.query.collection.trim() : '';
    const collection = isValidName(asked) ? asked : null;
    // Nothing here performs the import, but a page that hands someone a command
    // their token cannot run is worse than a refusal, so the collection they
    // asked about is checked against their scope before it is written into one.
    if (collection && !canCreateSomeRepo(root, viewer.auth, collection)) {
      fail(
        res,
        403,
        `You are not allowed to create repositories in ${collection}, so the push would be refused.`,
        viewer,
        `/${encodeURIComponent(collection)}`
      );
      return;
    }
    const host = req.get('host') ?? '';
    const vaultUrl = `${req.protocol}://${host}`;
    // The git fallback ends up on a command line, so it is written only when
    // the host name and the username carry nothing a shell would read.
    const plain = /^[A-Za-z0-9.:_-]+$/.test(host) && /^[A-Za-z0-9._-]+$/.test(viewer.auth.username);
    // The clone is a scratch copy, so it goes to a temporary directory rather
    // than to whatever directory the command happens to be pasted into. A
    // fresh one each time means a failed attempt never blocks the next, and
    // what it leaves behind is under /tmp rather than in someone's work tree.
    // mktemp is given an explicit template because plain `mktemp -d` is a
    // usage error on BSD, and `-t prefix` is a usage error on GNU.
    //
    // GIT_ASKPASS= on the push keeps the password prompt in the terminal the
    // command was pasted into. Editors that set GIT_ASKPASS (VS Code does for
    // its integrated terminal) otherwise redirect it to a dialog elsewhere in
    // the window, and an unanswered dialog looks exactly like a hang: git
    // prints nothing after the clone and waits. Credential helpers are
    // consulted before askpass, so a stored credential still works.
    const dest = `${req.protocol}://${encodeURIComponent(viewer.auth.username)}@${host}/${encodeURIComponent(
      collection ?? 'mycollection'
    )}/REPO-NAME`;
    const gitCommand = plain
      ? `tmp="$(mktemp -d /tmp/import.XXXXXX)"` +
        ` && git clone --bare SOURCE-URL "$tmp"` +
        ` && GIT_ASKPASS= git -C "$tmp" push --mirror ${dest}` +
        ` && rm -rf "$tmp"`
      : null;
    res.type('html').send(forms.importPage(viewer, { collection, vaultUrl, gitCommand }));
  });

  // A collection with nothing in it yet. Creating a repository or pushing to a
  // new path creates its collection on the way, so this is the other order:
  // the collection first, filled by an import or a push afterwards.
  app.get('/new/collection', (req, res) => {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return;
    res.type('html').send(forms.newCollectionPage(viewer, {}));
  });

  app.post('/new/collection', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const name = field(req, 'name').trim();
    const rerender = (status: number, error: string) => {
      res.status(status).type('html').send(forms.newCollectionPage(viewer, { name }, error));
    };
    if (!isValidName(name)) {
      rerender(400, 'A collection name may use letters, digits, dot, underscore, and dash, and must not be a reserved word.');
      return;
    }
    if (!canCreateCollection(root, viewer.auth, name)) {
      rerender(403, 'A collection not named after you takes a site admin to create.');
      return;
    }
    try {
      ops.createCollection(root, name);
    } catch (e) {
      if (e instanceof OpError) {
        rerender(opErrorStatus(e.kind), e.message);
        return;
      }
      throw e;
    }
    res.redirect(`/${encodeURIComponent(name)}`);
  });

  // ---- vault settings ----
  //
  // Registered ahead of the collection settings below, because the
  // /:collection/settings pattern would otherwise swallow /admin/settings:
  // 'admin' is a reserved name, so it can never be a collection, but the
  // parameter route cannot know that and answers first in registration
  // order. The helpers this block calls are declared in the administration
  // section further down, which function hoisting makes reachable.
  //
  // The rest of config.json, administered from the browser: the sites
  // hostname, CI retention, and the startup-read network and limits blocks.
  // The JSON API refuses to write the startup-read ones, because an API caller
  // reads the response as the new state of the server. A page can say more
  // than a status code, so here they are editable, and the page names each
  // saved value the running server is not yet using, with the command that
  // restarts it.

  // What the running server actually read: registration happens once, at
  // startup, alongside server.ts reading the same file for its limiters, so
  // this snapshot is the values the process is living by.
  const startupConfig = loadConfig(root);

  /**
   * How this server is restarted, for the page's restart notes. The
   * environment says which deployment this is: a Fly machine carries its app
   * name, which names the exact command; a container carries /.dockerenv,
   * which says only that it is one, so the command is the documented compose
   * deployment's and is offered with that said. Null means nothing identifies
   * a deployment, and the page says to start it again however it was started,
   * which is the honest answer rather than a guess at somebody's unit file.
   */
  function restartHow(): { command: string; caveat: string } | null {
    const flyApp = process.env.FLY_APP_NAME;
    if (flyApp) return { command: `fly apps restart ${flyApp}`, caveat: '' };
    if (fs.existsSync('/.dockerenv')) {
      return {
        command: 'docker compose restart mochi',
        caveat: 'if this is the compose deployment; otherwise restart the container however it was started',
      };
    }
    return null;
  }

  /** Back to the box the form was posted from, carrying its confirmation; see settingsBack above. */
  function vaultSettingsBack(section: forms.VaultSettingsSection, msg: string): string {
    return `/admin/settings?msg=${encodeURIComponent(msg)}&in=${section}#${section}`;
  }

  const VAULT_WIDE = 'Vault settings are vault-wide, so they take a site admin.';

  app.get('/admin/settings', (req, res) => {
    const viewer = requireAdminPage(req, res);
    if (!viewer) return;
    if (!canSetVaultWide(viewer)) {
      fail(res, 403, VAULT_WIDE, viewer, '/admin');
      return;
    }
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    const inBox = typeof req.query.in === 'string' ? req.query.in : '';
    const config = loadConfig(root);
    res.type('html').send(
      forms.vaultSettingsPage(
        viewer,
        {
          sitesHost: config.sites.host,
          // What is already named under the sites host. Only gathered when
          // there is one: the two scans are cheap but pointless on a vault
          // serving its sites sandboxed on the forge host.
          names: config.sites.host
            ? {
                labels: listSiteLabels(root),
                collections: collectionSiteAliases(root),
                reserved: reservedSiteLabels(),
              }
            : null,
          ci: config.ci,
          trustProxy: config.network.trustProxy,
          limits: config.limits,
          startup: { trustProxy: startupConfig.network.trustProxy, limits: startupConfig.limits },
          restart: restartHow(),
        },
        msg,
        forms.isVaultSettingsSection(inBox) ? inBox : undefined
      )
    );
  });

  /** A whole number from a form field, at least min, or null when it is not one. */
  function intField(req: Request, name: string, min: number): number | null {
    const raw = field(req, name).trim();
    if (!/^\d{1,9}$/.test(raw)) return null;
    const n = parseInt(raw, 10);
    return n >= min ? n : null;
  }

  function requireVaultAdminPost(req: Request, res: Response): Viewer | null {
    const viewer = requireAdminPost(req, res);
    if (!viewer) return null;
    if (!canSetVaultWide(viewer)) {
      fail(res, 403, VAULT_WIDE, viewer, '/admin');
      return null;
    }
    return viewer;
  }

  app.post('/admin/settings/sites', form, (req, res) => {
    const viewer = requireVaultAdminPost(req, res);
    if (!viewer) return;
    const host = normalizeHostname(field(req, 'host'));
    // loadConfig ignores a value that is not a hostname and uses the default,
    // which is right for a hand-edited file and wrong here: refuse the typo
    // with a message, as the API does, rather than store it silently inert.
    if (host !== '' && !isPlausibleHostname(host)) {
      fail(
        res,
        400,
        `${field(req, 'host').trim()} is not a hostname: give at least two labels of letters, digits, and interior hyphens, with no scheme, port, or path.`,
        viewer,
        '/admin/settings'
      );
      return;
    }
    saveConfig(root, { sites: { host } });
    const msg = host
      ? `Sites are served from their own hostnames under ${host}, from the next request on.`
      : 'Sites are served on the forge host, sandboxed, from the next request on.';
    res.redirect(vaultSettingsBack('sites', msg));
  });

  app.post('/admin/settings/ci', form, (req, res) => {
    const viewer = requireVaultAdminPost(req, res);
    if (!viewer) return;
    const runs = intField(req, 'runs', 0);
    const days = intField(req, 'days', 0);
    const artifactMb = intField(req, 'artifactMb', 1);
    if (runs === null || days === null || artifactMb === null) {
      fail(
        res,
        400,
        'Runs and days are whole numbers, 0 disabling the age limit, and the artifact size is at least 1 MB.',
        viewer,
        '/admin/settings'
      );
      return;
    }
    saveConfig(root, { ci: { runs, days, artifactMb } });
    res.redirect(
      vaultSettingsBack(
        'ci',
        `CI retention saved: keep ${runs} runs${days > 0 ? ` and ${days} days` : ''}, artifacts up to ${artifactMb} MB.`
      )
    );
  });

  app.post('/admin/settings/network', form, (req, res) => {
    const viewer = requireVaultAdminPost(req, res);
    if (!viewer) return;
    const value = field(req, 'trustProxy');
    if (value !== 'true' && value !== 'false') {
      fail(res, 400, 'Say whether the forwarded headers are believed or not.', viewer, '/admin/settings');
      return;
    }
    const trustProxy = value === 'true';
    saveConfig(root, { network: { trustProxy } });
    res.redirect(
      vaultSettingsBack(
        'network',
        trustProxy === startupConfig.network.trustProxy
          ? `Saved: forwarded headers ${trustProxy ? 'believed' : 'not believed'}, which is what the running server started with.`
          : 'Saved to config.json; the running server keeps its startup value until it restarts.'
      )
    );
  });

  app.post('/admin/settings/limits', form, (req, res) => {
    const viewer = requireVaultAdminPost(req, res);
    if (!viewer) return;
    const requestsPerMinute = intField(req, 'requestsPerMinute', 0);
    const authFailures = intField(req, 'authFailures', 0);
    const clone = intField(req, 'clone', 1);
    const push = intField(req, 'push', 1);
    const search = intField(req, 'search', 1);
    const tree = intField(req, 'tree', 1);
    if (
      requestsPerMinute === null ||
      authFailures === null ||
      clone === null ||
      push === null ||
      search === null ||
      tree === null
    ) {
      fail(
        res,
        400,
        'Limits are whole numbers: 0 disables a rate limit, and each concurrency is at least 1.',
        viewer,
        '/admin/settings'
      );
      return;
    }
    // The whole block is written back, since saveConfig replaces a top-level
    // key rather than merging into it; the egress cap keeps the value it has,
    // because its lever is the Egress page.
    saveConfig(root, {
      limits: { ...loadConfig(root).limits, requestsPerMinute, authFailures, clone, push, search, tree },
    });
    const s = startupConfig.limits;
    const applied =
      requestsPerMinute === s.requestsPerMinute &&
      authFailures === s.authFailures &&
      clone === s.clone &&
      push === s.push &&
      search === s.search &&
      tree === s.tree;
    res.redirect(
      vaultSettingsBack(
        'limits',
        applied
          ? 'Limits saved, matching what the running server started with.'
          : 'Limits saved to config.json; values the running server read at startup keep applying until it restarts.'
      )
    );
  });


  // ---- a collection's own settings ----
  //
  // These sit at /:collection/settings, one segment shallower than a
  // repository's, and are registered here rather than in browse.ts so that
  // they are matched ahead of /:collection/:repo. Nothing is shadowed by
  // them: `settings` is a reserved name, so no repository can be called it.

  /**
   * The collection named in the path, with the repositories it holds, or null
   * once a response has been sent. Renaming needs the repository names twice
   * over - to decide the actor's abilities, and to say in the page what moves
   * with the collection - so both handlers start here.
   */
  function loadCollection(
    req: Request,
    res: Response,
    viewer: Viewer,
    post: boolean
  ): { name: string; repos: string[] } | null {
    const name = req.params.collection;
    let isDir = false;
    try {
      isDir = fs.statSync(collectionDir(root, name)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isValidName(name) || !isDir) {
      if (post) fail(res, 404, `Collection ${name} not found`, viewer, '/');
      else send404(res, `Collection ${name} not found`, viewer);
      return null;
    }
    const repos = listRepoDirs(root, name).map(displayName);
    if (!canAdminCollection(root, viewer.auth, name)) {
      fail(res, 403, `Collection settings are for the owners of ${name}.`, viewer, `/${encodeURIComponent(name)}`);
      return null;
    }
    return { name, repos };
  }

  /**
   * What the collection's Site alias box shows: which tier its alias comes
   * from, and, when the rewritten label is unavailable, who holds it. The
   * resolution is the vault's, so it is done here rather than in the page.
   */
  function collectionSites(collection: string): forms.CollectionSitesInfo {
    const row = collectionSiteAliases(root).find((r) => r.collection === collection);
    const taken = row?.taken ?? '';
    return {
      host: loadConfig(root).sites.host,
      stored: storedCollectionAlias(root, collection),
      alias: row?.alias ?? null,
      taken,
      takenBy: taken ? (collectionAliasConflict(root, taken, collection) ?? '') : '',
    };
  }

  app.get('/:collection/settings', (req, res) => {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return;
    const loaded = loadCollection(req, res, viewer, false);
    if (!loaded) return;
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res
      .type('html')
      .send(
        forms.collectionSettingsPage(
          viewer,
          loaded.name,
          loaded.repos.length,
          collectionOwners(root, loaded.name),
          collectionSites(loaded.name),
          msg
        )
      );
  });

  /**
   * Store or clear the collection's site alias. Ownership of the collection is
   * the whole question, as it is for the owners list and the rename: the alias
   * decides the hostnames of the sites in this collection and nothing else.
   * The label it claims is checked against every other collection's, so an
   * owner cannot take a name another collection is already reached by.
   */
  app.post('/:collection/settings/site', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const loaded = loadCollection(req, res, viewer, true);
    if (!loaded) return;
    const backUrl = `/${encodeURIComponent(loaded.name)}/settings`;
    const alias = field(req, 'alias').trim();
    if (alias !== '' && !isUsableCollectionAlias(alias)) {
      fail(
        res,
        400,
        'A site alias is lowercase letters, digits, and single interior hyphens, with no doubled hyphen, at most 63 characters.',
        viewer,
        backUrl
      );
      return;
    }
    if (alias !== '') {
      const holder = collectionAliasConflict(root, alias, loaded.name);
      if (holder) {
        fail(res, 409, `The alias ${alias} is already how the collection ${holder} is reached.`, viewer, backUrl);
        return;
      }
    }
    setCollectionAlias(root, loaded.name, alias);
    const effective = collectionSiteAlias(root, loaded.name);
    const msg =
      alias === ''
        ? effective
          ? `Alias cleared; the collection is reached as ${effective}.`
          : 'Alias cleared; the collection has no derived hostname.'
        : `Sites in this collection are now served under ${alias}.`;
    res.redirect(`${backUrl}?msg=${encodeURIComponent(msg)}`);
  });

  app.post(
    '/:collection/settings/rename',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = loadCollection(req, res, viewer, true);
      if (!loaded) return;
      const from = loaded.name;
      const backUrl = `/${encodeURIComponent(from)}/settings`;
      const toName = field(req, 'name').trim();
      // Ownership, which loadCollection has already established, is the whole
      // permission: the owners file moves with the collection, so the owners
      // after the rename are the owners before it. Whether the new name is
      // free is the operation's own check.
      if (!isValidName(toName)) {
        fail(
          res,
          400,
          'A collection name may use letters, digits, dot, underscore, and dash, and must not be a reserved word.',
          viewer,
          backUrl
        );
        return;
      }
      try {
        await ops.renameCollection(root, from, toName, repoCtx);
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not rename the collection.';
        fail(res, e instanceof OpError ? opErrorStatus(e.kind) : 400, message, viewer, backUrl);
        return;
      }
      res.redirect(
        `/${encodeURIComponent(toName)}/settings?msg=${encodeURIComponent(`Renamed from ${from}.`)}`
      );
    })
  );

  // Owners manage the owners list, which loadCollection has established. The
  // implicit owner (the user the collection is named after) is not on the
  // list and cannot be removed from it.
  app.post('/:collection/settings/owners', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const loaded = loadCollection(req, res, viewer, true);
    if (!loaded) return;
    const backUrl = `/${encodeURIComponent(loaded.name)}/settings`;
    const username = field(req, 'username').trim();
    const state = loadVault(root);
    if (state.status !== 'ok' || !state.vault.users[username]) {
      fail(res, 404, `No user ${username || '(no name given)'} in this vault.`, viewer, backUrl);
      return;
    }
    if (username === loaded.name) {
      fail(res, 400, `${username} owns ${loaded.name} by bearing its name already.`, viewer, backUrl);
      return;
    }
    addCollectionOwner(root, loaded.name, username);
    res.redirect(`${backUrl}?msg=${encodeURIComponent(`${username} is now an owner of ${loaded.name}.`)}`);
  });

  app.post('/:collection/settings/owners/remove', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const loaded = loadCollection(req, res, viewer, true);
    if (!loaded) return;
    const backUrl = `/${encodeURIComponent(loaded.name)}/settings`;
    const username = field(req, 'username').trim();
    if (!collectionOwners(root, loaded.name).includes(username)) {
      fail(res, 404, `${username} is not an explicit owner of ${loaded.name}.`, viewer, backUrl);
      return;
    }
    removeCollectionOwner(root, loaded.name, username);
    res.redirect(`${backUrl}?msg=${encodeURIComponent(`Removed ${username} from the owners of ${loaded.name}.`)}`);
  });

  // Deletion, confirmed by typing the name as a repository's is. Ownership,
  // which loadCollection has established, is the whole permission; whether the
  // collection is empty is the operation's own check, so a repository pushed
  // between loading the page and clicking the button is a refusal, not a loss.
  app.post('/:collection/settings/delete', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    const loaded = loadCollection(req, res, viewer, true);
    if (!loaded) return;
    const backUrl = `/${encodeURIComponent(loaded.name)}/settings`;
    if (field(req, 'confirm').trim() !== loaded.name) {
      fail(res, 400, `Type ${loaded.name} exactly to confirm deletion.`, viewer, backUrl);
      return;
    }
    try {
      ops.deleteCollection(root, loaded.name);
    } catch (e) {
      const message = e instanceof OpError ? e.message : 'Could not delete the collection.';
      fail(res, e instanceof OpError ? opErrorStatus(e.kind) : 400, message, viewer, backUrl);
      return;
    }
    res.redirect('/');
  });

  app.get('/new', (req, res) => {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return;
    const collections = listCollections(root).map((o) => o.name);
    const collection = typeof req.query.collection === 'string' ? req.query.collection : '';
    // A name may be suggested too, which is how the prompt to write a
    // collection's profile README arrives here with .mochi already filled
    // in (see src/profile.ts).
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    res.type('html').send(forms.newRepoPage(viewer, collections, { collection, name }));
  });

  app.post(
    '/new',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const collection = field(req, 'collection').trim();
      const name = field(req, 'name').trim();
      const description = field(req, 'description').trim();
      const collections = listCollections(root).map((o) => o.name);
      const rerender = (status: number, error: string) => {
        res
          .status(status)
          .type('html')
          .send(forms.newRepoPage(viewer, collections, { collection, name, description }, error));
      };
      if (!isValidName(collection) || !isValidName(name)) {
        rerender(
          400,
          'Collection and repository names may use letters, digits, dot, underscore, and dash, and must not be reserved words. Only a repository may begin with a dot.'
        );
        return;
      }
      const reserved = reservedRepoSuffix(name);
      if (reserved) {
        rerender(400, `A repository name may not end in ${reserved}, which is reserved for the directories a repository keeps beside it.`);
        return;
      }
      if (!canCreateRepo(root, viewer.auth, collection, name)) {
        rerender(403, `You are not allowed to create repositories in ${collection}.`);
        return;
      }
      if (findRepo(root, collection, name)) {
        rerender(409, `Repository ${collection}/${name} already exists.`);
        return;
      }
      // The checks above answer every refusal this form can provoke, so the
      // ops layer's own are a backstop. Rendered rather than thrown all the
      // same: a backstop that reaches the reader as a 500 is one that says the
      // server broke when what happened is that it declined.
      let created;
      try {
        created = await ops.createRepoWithReadme(root, collection, name, {
          description,
          readme: field(req, 'init') === '1',
          private: field(req, 'private') === '1',
          author: authorFor(viewer, req),
        });
      } catch (e) {
        if (e instanceof OpError) {
          rerender(opErrorStatus(e.kind), e.message);
          return;
        }
        throw e;
      }
      if (created.sha) fire(created.repo, 'main', null, created.sha, viewer.auth.username);
      res.redirect(`/${encodeURIComponent(collection)}/${encodeURIComponent(name)}`);
    })
  );

  // ---- file operations ----

  interface FileOpTarget {
    loaded: LoadedRepo;
    branch: string;
    filePath: string;
    // Branch tip at load time (null only while the repository has no branches).
    tip: string | null;
  }

  // Resolves an /:collection/:repo/<verb>/<branch>/<path> URL and enforces what all
  // file operations share: the ref must be a branch (or the repository must
  // be empty) and the viewer needs the write role on the repository.
  async function loadFileTarget(
    req: Request,
    res: Response,
    viewer: Viewer,
    opts: { allowEmptyRepo: boolean }
  ): Promise<FileOpTarget | null> {
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    const { ref, path: filePath } = loaded.repo.resolveRefAndPath(wildcard(req), loaded.refNames);
    if (!isValidRepoPath(filePath)) {
      send404(res, 'Not found', viewer);
      return null;
    }
    if (!atLeast(loaded.role, 'write')) {
      fail(res, 403, `You do not have the write role on ${loaded.repo.collection}/${loaded.repo.name}.`, viewer, urlOf(loaded.repo));
      return null;
    }
    const branchInfo = loaded.branches.find((b) => b.name === ref);
    if (!branchInfo) {
      if (opts.allowEmptyRepo && loaded.branches.length === 0 && isValidRefName(ref) && !ref.startsWith('-')) {
        return { loaded, branch: ref, filePath, tip: null };
      }
      fail(
        res,
        400,
        'Files can only be changed on a branch. Switch to a branch and try again.',
        viewer,
        urlOf(loaded.repo)
      );
      return null;
    }
    return { loaded, branch: ref, filePath, tip: branchInfo.sha };
  }

  async function handleOpError(
    e: unknown,
    req: Request,
    res: Response,
    viewer: Viewer,
    target: FileOpTarget,
    retryUrl: string
  ): Promise<void> {
    if (e instanceof OpError && e.kind === 'conflict') {
      const ctx = await makeCtx(root, req, target.loaded, target.branch, viewer);
      res.status(409).type('html').send(forms.conflictPage(ctx, target.branch, retryUrl));
      return;
    }
    // A branch that could not be made is not a file that could not be written:
    // a name already taken is somebody else's branch, and 409 says so.
    if (e instanceof ops.NewBranchError) {
      fail(res, opErrorStatus(e.kind), e.message, viewer, retryUrl);
      return;
    }
    if (e instanceof OpError) {
      fail(res, opErrorStatus(e.kind), e.message, viewer, retryUrl);
      return;
    }
    throw e;
  }

  // The markdown editor's Preview tab posts a draft here and gets it back
  // rendered. The route is repo-scoped so relative links, `#12`, and commit
  // ids resolve exactly as they will on the saved page, and it sits behind the
  // same session and CSRF check as the write being drafted: the renderer
  // sanitizes what it is given, but there is no reason to render for anyone
  // who could not save.
  app.post(
    '/:collection/:repo/preview',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const text = field(req, 'text');
      // The ref and directory are the draft's claim about where it sits: an
      // unknown ref falls back to the default branch, and a directory is only
      // honoured when it is a plain relative path.
      const asked = field(req, 'ref');
      const ref = asked !== '' && loaded.refNames.includes(asked) ? asked : ctx.defaultBranch || ctx.ref || 'HEAD';
      const dirAsked = field(req, 'dir');
      const dir =
        dirAsked !== '' && dirAsked.split('/').every((s) => s !== '' && s !== '.' && s !== '..') ? dirAsked : '';
      const base = urlOf(loaded.repo);
      const at = (kind: string) => `${base}/${kind}/${encPath(ref)}${dir === '' ? '' : `/${encPath(dir)}`}`;
      const rendered =
        text.trim() === ''
          ? '<p class="muted">Nothing to preview.</p>'
          : renderMarkdown(text, {
              rawBase: at('raw'),
              blobBase: at('blob'),
              issueBase: `${base}/issues`,
              commitBase: `${base}/commit`,
              mentions: ctx.hasUser,
            });
      res.type('html').send(rendered);
    })
  );

  app.get(
    '/:collection/:repo/edit/*',
    ah(async (req, res) => {
      const viewer = requireViewerPage(root, req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: false });
      if (!target) return;
      const { loaded, branch, filePath } = target;
      const type = await loaded.repo.entryType(branch, filePath);
      if (type !== 'blob') {
        send404(res, `File ${filePath} not found at ${branch}`, viewer);
        return;
      }
      const buf = await loaded.repo.catBlob(branch, filePath);
      // Editing a pointer as text would silently corrupt the repository's
      // LFS state, so it is refused outright (deletion remains allowed).
      if (looksLikePointer(buf)) {
        fail(
          res,
          400,
          'This file is stored with Git LFS; the repository holds only a pointer to it. Change the file with a git client instead.',
          viewer,
          urlOf(loaded.repo)
        );
        return;
      }
      // An age file gets the decrypt-in-the-browser editor, whichever framing
      // it is in: the ciphertext may be binary, but what the editor holds and
      // what the commit posts are text. The size cap still applies, since the
      // posted ciphertext travels the same form as any other edit.
      if (isAgeFile(filePath)) {
        if (buf.length > MAX_EDIT_SIZE) {
          fail(res, 400, 'Only files up to 1 MB can be edited in the browser.', viewer, urlOf(loaded.repo));
          return;
        }
        const ctx = await makeCtx(root, req, loaded, branch, viewer);
        res.type('html').send(forms.editAgeFilePage(ctx, filePath, target.tip!));
        return;
      }
      if (isBinary(buf) || buf.length > MAX_EDIT_SIZE) {
        fail(res, 400, 'Only text files up to 1 MB can be edited in the browser.', viewer, urlOf(loaded.repo));
        return;
      }
      const ctx = await makeCtx(root, req, loaded, branch, viewer);
      res.type('html').send(forms.editFilePage(ctx, filePath, buf.toString('utf8'), target.tip!));
    })
  );

  app.post(
    '/:collection/:repo/edit/*',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: false });
      if (!target) return;
      const { loaded, branch, filePath } = target;
      const expected = field(req, 'expected');
      if (!isValidSha(expected)) {
        fail(res, 400, 'The form is missing its base commit; reload and try again.', viewer);
        return;
      }
      const content = normalizeContent(field(req, 'content'));
      const retryUrl = `${urlOf(loaded.repo)}/edit/${encPath(branch)}/${encPath(filePath)}`;
      // The editor only opens files up to MAX_EDIT_SIZE, so content beyond it
      // means a paste that outgrew what this form is for. Checked here so the
      // refusal names the way that does work, instead of the body limit 413ing
      // with no advice.
      if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_SIZE) {
        fail(
          res,
          413,
          'Files over 1 MB cannot be committed through the editor. Use the Upload files form, or push with git.',
          viewer,
          retryUrl
        );
        return;
      }
      // A changed path renames or moves the file in the same commit, which is
      // what the path field on the form is for. Rejected rather than silently
      // rewritten when it is not a path this repository can take.
      const wantedPath = field(req, 'path').trim();
      const toPath = wantedPath === '' || wantedPath === filePath ? undefined : wantedPath;
      if (toPath !== undefined && !isValidNewRepoPath(toPath)) {
        fail(res, 400, `${toPath} is not a usable path.`, viewer, retryUrl);
        return;
      }
      // What stands between a failed script and a plaintext commit: a .age
      // path only ever receives age-shaped bytes through this form. The
      // browser editor encrypts before posting, so ordinary use never sees
      // this; a page where that script did not run must not quietly write
      // the secret it was meant to protect. Byte-exact writes that are not
      // age files remain possible over git and the API, where nothing is
      // encrypting on the caller's behalf.
      if (isAgeFile(toPath ?? filePath) && !looksLikeAge(Buffer.from(content, 'utf8'))) {
        fail(
          res,
          400,
          'A .age file holds an age ciphertext, and this content is not one. The editor encrypts in the browser before committing; committing this text as-is would store it unencrypted under a name that promises otherwise. To write these bytes anyway, use git or the API.',
          viewer,
          retryUrl
        );
        return;
      }
      const message = commitMessage(
        req,
        toPath === undefined ? `Update ${filePath.split('/').pop()}` : `Rename ${filePath} to ${toPath}`
      );
      // The branch choice, the pointer refusal, and the guarded commit are one
      // sequence in ops.writeFile, which the API write path calls too. The GET
      // form already refuses a pointer file; writeFile re-checks, so the refusal
      // cannot be bypassed by posting directly.
      let written;
      try {
        written = await ops.writeFile(loaded.repo.dir, {
          branch,
          newBranch: newBranchWanted(req),
          filePath,
          message,
          author: authorFor(viewer, req),
          expectedHead: expected,
          action: { kind: 'edit', content: Buffer.from(content, 'utf8'), toPath },
        });
      } catch (e) {
        await handleOpError(e, req, res, viewer, target, retryUrl);
        return;
      }
      const onto = written.branch;
      fire(loaded.repo, onto, expected, written.sha, viewer.auth.username);
      // A commit on a new branch wants to be seen against the one it left, so
      // that is where the editor lands.
      if (onto !== branch) {
        res.redirect(`${urlOf(loaded.repo)}/compare/${encPath(branch)}...${encPath(onto)}`);
        return;
      }
      res.redirect(`${urlOf(loaded.repo)}/blob/${encPath(onto)}/${encPath(toPath ?? filePath)}`);
    })
  );

  // ---- uploading files ----

  // The body is multipart, which express does not parse, so it arrives raw and
  // multipart.ts takes it apart. The cap is enforced twice: here, where a
  // larger body is refused before it is read, and again on the sum of the
  // parts.
  const uploadBody = express.raw({ type: 'multipart/form-data', limit: MAX_UPLOAD_SIZE });

  app.get(
    '/:collection/:repo/upload/*',
    ah(async (req, res) => {
      const viewer = requireViewerPage(root, req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: true });
      if (!target) return;
      const ctx = await makeCtx(root, req, target.loaded, target.branch, viewer);
      res.type('html').send(forms.uploadPage(ctx, target.branch, target.filePath, target.tip, MAX_UPLOAD_SIZE));
    })
  );

  app.post(
    '/:collection/:repo/upload/*',
    uploadBody,
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      if (!viewer) {
        fail(res, 403, 'You must be signed in to do that.', null, '/login');
        return;
      }
      const boundary = boundaryOf(req.get('content-type'));
      if (!boundary || !Buffer.isBuffer(req.body)) {
        fail(res, 400, 'That upload did not arrive as a form; try again.', viewer);
        return;
      }
      const parts = parseMultipart(req.body, boundary);
      // The CSRF value rides in the same form, so it is compared from the
      // parsed parts: express did not fill in req.body for a multipart post.
      if (!csrfMatches(req, partField(parts, 'csrf'), viewer)) {
        fail(res, 403, 'The form has expired; go back, reload the page, and try again.', viewer);
        return;
      }
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: true });
      if (!target) return;
      const { loaded, branch, filePath: dir } = target;
      const retryUrl = `${urlOf(loaded.repo)}/upload/${encPath(branch)}${dir === '' ? '' : `/${encPath(dir)}`}`;
      const expectedField = partField(parts, 'expected');
      const expected = expectedField === '' ? null : expectedField;
      if (expected !== null && !isValidSha(expected)) {
        fail(res, 400, 'The form is missing its base commit; reload and try again.', viewer, retryUrl);
        return;
      }
      const uploads = partFiles(parts, 'files');
      if (uploads.length === 0) {
        fail(res, 400, 'Choose at least one file to upload.', viewer, retryUrl);
        return;
      }
      const total = uploads.reduce((n, f) => n + f.data.length, 0);
      if (total > MAX_UPLOAD_SIZE) {
        fail(res, 413, 'That is more than one upload may carry; push it with git instead.', viewer, retryUrl);
        return;
      }
      // Browsers send the name the file had on disk, and some send a whole
      // path; only the last segment is ours to use, and it still has to be a
      // path this repository would accept. When the last segment is not the
      // name that arrived, the reader is told what the file was saved as,
      // rather than the flattening happening in silence.
      const files: ops.UploadedFile[] = [];
      const renamed: string[] = [];
      for (const upload of uploads) {
        const sent = upload.filename ?? '';
        const name = sent.split(/[\\/]/).pop() ?? '';
        const full = dir === '' ? name : `${dir}/${name}`;
        if (name === '' || name === '.' || name === '..' || !isValidNewRepoPath(full)) {
          fail(res, 400, `${name || 'That file'} does not have a usable name.`, viewer, retryUrl);
          return;
        }
        if (name !== sent) renamed.push(`${sent} was saved as ${name}`);
        files.push({ path: full, content: upload.data });
      }
      const summary = partField(parts, 'message').trim();
      const description = partField(parts, 'description').trim();
      const fallback = files.length === 1 ? `Add ${files[0].path.split('/').pop()}` : `Add ${files.length} files`;
      const message = `${summary || fallback}${description ? `\n\n${description}` : ''}`;
      let onto = branch;
      if (partField(parts, 'newBranchWanted') === '1') {
        const wanted = partField(parts, 'newBranch').trim();
        if (wanted === '' || expected === null) {
          fail(res, 400, 'Name the new branch, or untick the box to commit to this one.', viewer, retryUrl);
          return;
        }
        try {
          await ops.createBranch(loaded.repo.dir, wanted, expected);
        } catch (e) {
          const message2 = e instanceof OpError ? e.message : 'Could not create that branch.';
          fail(res, e instanceof OpError ? opErrorStatus(e.kind) : 400, message2, viewer, retryUrl);
          return;
        }
        onto = wanted;
      }
      try {
        const sha = await ops.commitFiles(loaded.repo.dir, {
          branch: onto,
          files,
          message,
          author: authorFor(viewer, req),
          expectedHead: expected,
        });
        fire(loaded.repo, onto, expected, sha, viewer.auth.username);
      } catch (e) {
        await handleOpError(e, req, res, viewer, target, retryUrl);
        return;
      }
      if (onto !== branch) {
        res.redirect(`${urlOf(loaded.repo)}/compare/${encPath(branch)}...${encPath(onto)}`);
        return;
      }
      const note = renamed.length ? `?msg=${encodeURIComponent(renamed.join('; ') + '.')}` : '';
      res.redirect(`${urlOf(loaded.repo)}/tree/${encPath(onto)}${dir === '' ? '' : `/${encPath(dir)}`}${note}`);
    })
  );

  app.get(
    '/:collection/:repo/new/*',
    ah(async (req, res) => {
      const viewer = requireViewerPage(root, req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: true });
      if (!target) return;
      const ctx = await makeCtx(root, req, target.loaded, target.branch, viewer);
      const preset = target.tip === null ? { filename: 'README.md', content: `# ${target.loaded.repo.name}\n` } : {};
      res.type('html').send(forms.newFilePage(ctx, target.branch, target.filePath, target.tip, preset));
    })
  );

  app.post(
    '/:collection/:repo/new/*',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: true });
      if (!target) return;
      const { loaded, branch, filePath: dir } = target;
      const expectedField = field(req, 'expected');
      const expected = expectedField === '' ? null : expectedField;
      if (expected !== null && !isValidSha(expected)) {
        fail(res, 400, 'The form is missing its base commit; reload and try again.', viewer);
        return;
      }
      if (expected === null && target.tip !== null) {
        // The form was rendered against an empty repository, but a branch has
        // appeared since; treat it as the branch having moved.
        await handleOpError(new OpError('branch created meanwhile', 'conflict'), req, res, viewer, target, req.originalUrl);
        return;
      }
      // Rejected rather than silently de-rooted or flattened: a leading slash,
      // a backslash, or a .git component is a name the commit cannot take, and
      // rewriting it would commit a path nobody typed.
      const filename = field(req, 'filename').trim();
      const fullPath = dir === '' ? filename : `${dir}/${filename}`;
      const retryUrl = req.originalUrl;
      if (filename === '' || !isValidNewRepoPath(fullPath)) {
        fail(res, 400, 'Invalid file name.', viewer, retryUrl);
        return;
      }
      const content = normalizeContent(field(req, 'content'));
      // See the edit form: content past what the editor itself would open is
      // refused with advice rather than left to the body limit.
      if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_SIZE) {
        fail(
          res,
          413,
          'Files over 1 MB cannot be committed through the editor. Use the Upload files form, or push with git.',
          viewer,
          retryUrl
        );
        return;
      }
      // The same backstop the edit form has: see the comment there.
      if (isAgeFile(fullPath) && !looksLikeAge(Buffer.from(content, 'utf8'))) {
        fail(
          res,
          400,
          'A .age file holds an age ciphertext, and this content is not one. The form encrypts in the browser before committing; committing this text as-is would store it unencrypted under a name that promises otherwise. To write these bytes anyway, use git or the API.',
          viewer,
          retryUrl
        );
        return;
      }
      const message = commitMessage(req, `Create ${filename.split('/').pop()}`);
      let written;
      try {
        written = await ops.writeFile(loaded.repo.dir, {
          branch,
          newBranch: newBranchWanted(req),
          filePath: fullPath,
          message,
          author: authorFor(viewer, req),
          expectedHead: expected,
          action: { kind: 'create', content: Buffer.from(content, 'utf8') },
        });
      } catch (e) {
        await handleOpError(e, req, res, viewer, target, retryUrl);
        return;
      }
      const onto = written.branch;
      fire(loaded.repo, onto, expected, written.sha, viewer.auth.username);
      if (onto !== branch) {
        res.redirect(`${urlOf(loaded.repo)}/compare/${encPath(branch)}...${encPath(onto)}`);
        return;
      }
      res.redirect(`${urlOf(loaded.repo)}/blob/${encPath(onto)}/${encPath(fullPath)}`);
    })
  );

  app.get(
    '/:collection/:repo/delete/*',
    ah(async (req, res) => {
      const viewer = requireViewerPage(root, req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: false });
      if (!target) return;
      const { loaded, branch, filePath } = target;
      const type = await loaded.repo.entryType(branch, filePath);
      if (type !== 'blob') {
        send404(res, `File ${filePath} not found at ${branch}`, viewer);
        return;
      }
      const ctx = await makeCtx(root, req, loaded, branch, viewer);
      res.type('html').send(forms.deleteFilePage(ctx, filePath, target.tip!));
    })
  );

  app.post(
    '/:collection/:repo/delete/*',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const target = await loadFileTarget(req, res, viewer, { allowEmptyRepo: false });
      if (!target) return;
      const { loaded, branch, filePath } = target;
      const expected = field(req, 'expected');
      if (!isValidSha(expected)) {
        fail(res, 400, 'The form is missing its base commit; reload and try again.', viewer);
        return;
      }
      const message = commitMessage(req, `Delete ${filePath.split('/').pop()}`);
      const retryUrl = `${urlOf(loaded.repo)}/delete/${encPath(branch)}/${encPath(filePath)}`;
      try {
        const sha = await ops.commitFileChange(loaded.repo.dir, {
          branch,
          filePath,
          message,
          author: authorFor(viewer, req),
          expectedHead: expected,
          action: { kind: 'delete' },
        });
        fire(loaded.repo, branch, expected, sha, viewer.auth.username);
      } catch (e) {
        await handleOpError(e, req, res, viewer, target, retryUrl);
        return;
      }
      const parent = filePath.split('/').slice(0, -1).join('/');
      res.redirect(`${urlOf(loaded.repo)}/tree/${encPath(branch)}${parent ? `/${encPath(parent)}` : ''}`);
    })
  );

  // ---- branches and tags ----

  async function loadForRefOp(req: Request, res: Response, viewer: Viewer): Promise<LoadedRepo | null> {
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    if (!atLeast(loaded.role, 'write')) {
      fail(res, 403, `You do not have the write role on ${loaded.repo.collection}/${loaded.repo.name}.`, viewer, urlOf(loaded.repo));
      return null;
    }
    return loaded;
  }

  app.post(
    '/:collection/:repo/branches/create',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadForRefOp(req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/branches`;
      const name = field(req, 'name').trim();
      const from = field(req, 'from').trim() || loaded.defaultBranch || '';
      try {
        await ops.createBranch(loaded.repo.dir, name, from);
        const created = loaded.branches.find((b) => b.name === from);
        const tip = created?.sha ?? loaded.tags.find((t) => t.name === from)?.sha;
        if (tip) fire(loaded.repo, name, null, tip, viewer.auth.username);
      } catch (e) {
        if (e instanceof OpError) {
          fail(res, opErrorStatus(e.kind), e.message, viewer, backUrl);
          return;
        }
        throw e;
      }
      res.redirect(backUrl);
    })
  );

  app.post(
    '/:collection/:repo/branches/delete',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadForRefOp(req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/branches`;
      const name = field(req, 'name');
      if (!loaded.branches.some((b) => b.name === name)) {
        fail(res, 404, `Branch ${name} not found.`, viewer, backUrl);
        return;
      }
      if (name === loaded.defaultBranch) {
        fail(res, 400, 'The default branch cannot be deleted. Change the default branch in Settings first.', viewer, backUrl);
        return;
      }
      await ops.deleteBranch(loaded.repo.dir, name);
      res.redirect(backUrl);
    })
  );

  app.post(
    '/:collection/:repo/tags/create',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadForRefOp(req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/tags`;
      const name = field(req, 'name').trim();
      const at = field(req, 'at').trim() || loaded.defaultBranch || '';
      try {
        await ops.createTag(loaded.repo.dir, name, at);
      } catch (e) {
        if (e instanceof OpError) {
          fail(res, opErrorStatus(e.kind), e.message, viewer, backUrl);
          return;
        }
        throw e;
      }
      res.redirect(backUrl);
    })
  );

  app.post(
    '/:collection/:repo/tags/delete',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadForRefOp(req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/tags`;
      const name = field(req, 'name');
      if (!loaded.tags.some((t) => t.name === name)) {
        fail(res, 404, `Tag ${name} not found.`, viewer, backUrl);
        return;
      }
      await ops.deleteTag(loaded.repo.dir, name);
      res.redirect(backUrl);
    })
  );

  // ---- repository settings ----

  app.get(
    '/:collection/:repo/settings',
    ah(async (req, res) => {
      const viewer = requireViewerPage(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      if (!ctx.canPush && !ctx.canAdmin) {
        fail(res, 403, 'You do not have access to this repository’s settings.', viewer, urlOf(loaded.repo));
        return;
      }
      const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
      // Which box the message belongs in, so a save is confirmed where the
      // form was rather than at the top of a page the reader has been thrown
      // back to. A value naming no box reads as none, like an unknown sort.
      const inParam = typeof req.query.in === 'string' ? req.query.in : '';
      const section = forms.isSettingsSection(inParam) ? inParam : undefined;
      const access = repoAccess(loaded.repo.dir);
      const settings = siteSettings(loaded.repo.dir);
      const sitesHost = loadConfig(root).sites.host;
      // The label the site would be served under with nothing set: the whole
      // hostname minus the sites host and the dot joining them.
      const derivedHost = siteHostFor(root, sitesHost, loaded.repo.collection, loaded.repo.name);
      const alias = collectionSiteAlias(root, loaded.repo.collection);
      res.type('html').send(
        forms.settingsPage(
          ctx,
          repoDescription(loaded.repo.dir) ?? '',
          repoTopics(loaded.repo.dir),
          {
            collaborators: Object.entries(access.collaborators).map(([username, role]) => ({ username, role })),
            owners: collectionOwners(root, loaded.repo.collection),
          },
          {
            enabled: settings.enabled,
            source: settings.source,
            label: settings.label,
            domain: repoDomain(root, loaded.repo.collection, loaded.repo.name),
            sitesHost,
            derivedLabel: derivedHost ? derivedHost.slice(0, -(sitesHost.length + 1)) : null,
            collectionAlias: alias,
            dirExists: siteDir(root, loaded.repo.collection, loaded.repo.name) !== null,
          },
          msg,
          undefined,
          section
        )
      );
    })
  );

  app.post(
    '/:collection/:repo/settings',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const backUrl = settingsBack(loaded.repo, 'general');
      if (!atLeast(loaded.role, 'write')) {
        fail(res, 403, `You do not have the write role on ${loaded.repo.collection}/${loaded.repo.name}.`, viewer, backUrl);
        return;
      }
      try {
        ops.setDescription(loaded.repo.dir, field(req, 'description'));
        // Only when the form carried the field: the General form always does,
        // but treating an absent field as "no topics" would let any other
        // post to this route silently clear them.
        if ((req.body as Record<string, unknown>).topics !== undefined) {
          setTopics(loaded.repo.dir, parseTopicsInput(field(req, 'topics')));
        }
        // Same guard as topics: an absent field means an older or other form,
        // not a request to clear the upstream.
        if ((req.body as Record<string, unknown>).upstream !== undefined) {
          await ops.setUpstream(loaded.repo.dir, field(req, 'upstream').trim());
        }
      } catch (e) {
        if (e instanceof OpError) {
          fail(res, opErrorStatus(e.kind), e.message, viewer, backUrl);
          return;
        }
        throw e;
      }
      const defaultBranch = field(req, 'defaultBranch');
      if (defaultBranch !== '' && defaultBranch !== loaded.defaultBranch) {
        if (!loaded.branches.some((b) => b.name === defaultBranch)) {
          fail(res, 400, `Branch ${defaultBranch} not found.`, viewer, backUrl);
          return;
        }
        await ops.setDefaultBranch(loaded.repo.dir, defaultBranch);
      }
      res.redirect(settingsBack(loaded.repo, 'general', 'Settings saved.'));
    })
  );

  // Topics on their own, for the editor in the repository page's About panel:
  // a form that posted only topics to the route above would clear the
  // description on the way. Write role, the same as the description, since a
  // topic publishes nothing and withdraws nothing.
  app.post(
    '/:collection/:repo/settings/topics',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      // Back to where the form was: the About panel's editor says so, and
      // anything else lands on the settings page.
      const backUrl = field(req, 'next') === 'repo' ? urlOf(loaded.repo) : `${urlOf(loaded.repo)}/settings`;
      if (!atLeast(loaded.role, 'write')) {
        fail(res, 403, `You do not have the write role on ${loaded.repo.collection}/${loaded.repo.name}.`, viewer, backUrl);
        return;
      }
      try {
        setTopics(loaded.repo.dir, parseTopicsInput(field(req, 'topics')));
      } catch (e) {
        if (e instanceof OpError) {
          fail(res, opErrorStatus(e.kind), e.message, viewer, backUrl);
          return;
        }
        throw e;
      }
      const now = repoTopics(loaded.repo.dir);
      const msg = now.length === 0 ? 'Topics cleared.' : `Topics saved: ${now.join(', ')}.`;
      // Topics live in the General box, so a post from the settings page is
      // confirmed there; one from the About panel goes back to the repository
      // page, which has no box to name.
      res.redirect(
        field(req, 'next') === 'repo'
          ? `${backUrl}?msg=${encodeURIComponent(msg)}`
          : settingsBack(loaded.repo, 'general', msg)
      );
    })
  );

  // ---- visibility and collaborators ----

  // Both take the admin role: who may see or write a repository is decided by
  // the people who administer it, the same rule the JSON API applies.

  /**
   * Where a settings form sends the reader afterwards: back to the box it was
   * posted from, carrying its confirmation. The fragment is what scrolls
   * there, so a save no longer throws the reader to the top of the page, and
   * `in=` names the same box in the query because a fragment never reaches the
   * server and the page has to know which box to show the message in.
   */
  function settingsBack(repo: { collection: string; name: string }, section: string, msg?: string): string {
    const query = msg === undefined ? '' : `?msg=${encodeURIComponent(msg)}&in=${section}`;
    return `${urlOf(repo)}/settings${query}#${section}`;
  }

  async function loadForRepoAdmin(req: Request, res: Response, viewer: Viewer): Promise<LoadedRepo | null> {
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    if (!atLeast(loaded.role, 'admin')) {
      fail(
        res,
        403,
        `This takes the admin role on ${loaded.repo.collection}/${loaded.repo.name}.`,
        viewer,
        `${urlOf(loaded.repo)}/settings`
      );
      return null;
    }
    return loaded;
  }

  app.post(
    '/:collection/:repo/settings/visibility',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadForRepoAdmin(req, res, viewer);
      if (!loaded) return;
      const priv = field(req, 'private') === 'true';
      setRepoPrivate(loaded.repo.dir, priv);
      const msg = priv
        ? 'This repository is now private: visible to its collaborators, the collection’s owners, and site admins.'
        : 'This repository is now public: anyone can read it.';
      res.redirect(settingsBack(loaded.repo, 'access', msg));
    })
  );

  // The site's switch, source, hostname label, and custom domain, from the
  // Site box on the settings page. Admin, like visibility: enabling a site
  // publishes whatever the directory holds to everyone. Each field is applied
  // only when the form carried it, so the enable/disable button and the
  // config form can post to one route without clearing each other's fields.
  // The domain field is rendered only for a site admin and re-checked here,
  // since attaching a hostname is the operator's act.
  app.post(
    '/:collection/:repo/settings/site',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadForRepoAdmin(req, res, viewer);
      if (!loaded) return;
      const backUrl = settingsBack(loaded.repo, 'site');
      const body = req.body as Record<string, unknown>;
      const label = field(req, 'label').trim();
      if (body.label !== undefined && label !== '') {
        if (isReservedSiteLabel(label)) {
          fail(
            res,
            409,
            `The label ${label} is reserved for the operator of this vault: it is one of the names kept for the vault's own use under the sites host.`,
            viewer,
            backUrl
          );
          return;
        }
        if (!isUsableSiteLabel(label)) {
          fail(
            res,
            400,
            'A site label is lowercase letters, digits, and single interior hyphens, at most 63 characters.',
            viewer,
            backUrl
          );
          return;
        }
        const holder = siteLabelConflict(root, label, loaded.repo.collection, loaded.repo.name);
        if (holder) {
          fail(res, 409, `The label ${label} is already used by ${holder}.`, viewer, backUrl);
          return;
        }
      }
      const source = field(req, 'source');
      if (body.source !== undefined && source !== 'copy' && source !== 'actions') {
        fail(res, 400, 'The site source must be copied files or workflow deploys.', viewer, backUrl);
        return;
      }
      if (body.domain !== undefined) {
        if (!isSiteAdmin(viewer.auth)) {
          fail(res, 403, 'Attaching a custom domain takes a site admin.', viewer, backUrl);
          return;
        }
        const domain = field(req, 'domain').trim();
        if (domain === '') {
          clearRepoDomain(root, loaded.repo.collection, loaded.repo.name);
        } else {
          const problem = setRepoDomain(root, loaded.repo.collection, loaded.repo.name, domain);
          if (problem) {
            fail(
              res,
              problem.kind === 'conflict' ? 409 : 400,
              `The domain was refused: ${problem.message}.`,
              viewer,
              backUrl
            );
            return;
          }
        }
      }
      const changingSettings = body.enabled !== undefined || body.source !== undefined || body.label !== undefined;
      const settings = changingSettings
        ? editSiteSettings(loaded.repo.dir, (s) => {
            if (body.enabled !== undefined) s.enabled = field(req, 'enabled') === 'true';
            if (body.source !== undefined) s.source = source as 'copy' | 'actions';
            if (body.label !== undefined) s.label = label;
          })
        : siteSettings(loaded.repo.dir);
      const msg =
        body.enabled !== undefined
          ? settings.enabled
            ? 'The site is now enabled: the files in its site directory are served to everyone.'
            : 'The site is now disabled: its files stay on disk but nothing is served, and workflow deploys are refused.'
          : 'Site settings saved.';
      res.redirect(settingsBack(loaded.repo, 'site', msg));
    })
  );

  app.post(
    '/:collection/:repo/settings/collaborators',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadForRepoAdmin(req, res, viewer);
      if (!loaded) return;
      const backUrl = settingsBack(loaded.repo, 'access');
      const username = field(req, 'username').trim();
      const role = field(req, 'role');
      if (role !== 'read' && role !== 'write' && role !== 'admin') {
        fail(res, 400, 'The role must be read, write, or admin.', viewer, backUrl);
        return;
      }
      // Only a user the vault knows: an entry for a name nobody holds grants
      // nothing today and everything it says to whoever gets the name later.
      const state = loadVault(root);
      if (state.status !== 'ok' || !state.vault.users[username]) {
        fail(res, 404, `No user ${username || '(no name given)'} in this vault.`, viewer, backUrl);
        return;
      }
      setCollaborator(loaded.repo.dir, username, role);
      res.redirect(settingsBack(loaded.repo, 'access', `${username} now has the ${role} role here.`));
    })
  );

  app.post(
    '/:collection/:repo/settings/collaborators/remove',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadForRepoAdmin(req, res, viewer);
      if (!loaded) return;
      const backUrl = settingsBack(loaded.repo, 'access');
      const username = field(req, 'username').trim();
      if (repoAccess(loaded.repo.dir).collaborators[username] === undefined) {
        fail(res, 404, `${username} is not a collaborator here.`, viewer, backUrl);
        return;
      }
      removeCollaborator(loaded.repo.dir, username);
      res.redirect(settingsBack(loaded.repo, 'access', `Removed ${username}.`));
    })
  );

  // ---- forking ----

  app.get(
    '/:collection/:repo/fork',
    ah(async (req, res) => {
      const viewer = requireViewerPage(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      // A vault usually has a collection named after each user, so that is the
      // suggestion; anything the actor may push to is accepted.
      res
        .type('html')
        .send(
          forms.forkPage(ctx, viewer, listCollections(root).map((c) => c.name), {
            collection: viewer.auth.username,
            name: loaded.repo.name,
          })
        );
    })
  );

  app.post(
    '/:collection/:repo/fork',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const toCollection = field(req, 'collection').trim();
      const toName = field(req, 'name').trim() || loaded.repo.name;
      const names = listCollections(root).map((c) => c.name);
      if (!isValidName(toCollection) || !isValidName(toName) || !canCreateRepo(root, viewer.auth, toCollection, toName)) {
        res
          .status(403)
          .type('html')
          .send(
            forms.forkPage(
              ctx,
              viewer,
              names,
              { collection: toCollection, name: toName },
              `You are not allowed to create repositories in ${toCollection || '(no collection)'}.`
            )
          );
        return;
      }
      try {
        await ops.forkRepo(root, loaded.repo.collection, loaded.repo.name, toCollection, toName);
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not fork the repository.';
        res
          .status(e instanceof OpError ? opErrorStatus(e.kind) : 400)
          .type('html')
          .send(forms.forkPage(ctx, viewer, names, { collection: toCollection, name: toName }, message));
        return;
      }
      res.redirect(repoUrl({ collection: toCollection, repo: toName }));
    })
  );

  // Syncing a fork from its upstream, like importing, runs on the operator's
  // machine: the server never fetches from another host. So the Sync link in
  // the repository header leads here, and this page only hands them the
  // command, the way the import page does.
  app.get(
    '/:collection/:repo/sync',
    ah(async (req, res) => {
      const viewer = requireViewerPage(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      if (!ctx.upstream) {
        fail(
          res,
          404,
          'This repository has no upstream recorded, so there is nothing to sync from. Record one in its settings to make it a fork.',
          viewer,
          `${urlOf(loaded.repo)}/settings`
        );
        return;
      }
      res.type('html').send(forms.syncPage(ctx, `${req.protocol}://${req.get('host') ?? ''}`));
    })
  );

  app.post(
    '/:collection/:repo/settings/rename',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const from = `${loaded.repo.collection}/${loaded.repo.name}`;
      const backUrl = `${urlOf(loaded.repo)}/settings`;
      const toCollection = field(req, 'collection').trim() || loaded.repo.collection;
      const toName = field(req, 'name').trim();
      const blocker = repoRenameBlocker(root, viewer.auth, loaded.repo, toCollection, toName);
      if (blocker) {
        fail(res, 403, `Renaming or moving this repository needs ${blocker}.`, viewer, backUrl);
        return;
      }
      try {
        await ops.renameRepo(root, loaded.repo.collection, loaded.repo.name, toCollection, toName, repoCtx);
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'Could not move the repository.';
        fail(res, e instanceof OpError ? opErrorStatus(e.kind) : 400, message, viewer, backUrl);
        return;
      }
      const to = repoUrl({ collection: toCollection, repo: toName });
      res.redirect(`${to}/settings?msg=${encodeURIComponent(`Moved from ${from}.`)}`);
    })
  );

  app.post(
    '/:collection/:repo/settings/delete',
    form,
    ah(async (req, res) => {
      const viewer = requireViewerPost(root, req, res);
      if (!viewer) return;
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const backUrl = `${urlOf(loaded.repo)}/settings`;
      const target = `${loaded.repo.collection}/${loaded.repo.name}`;
      if (!atLeast(loaded.role, 'admin')) {
        fail(res, 403, `Repository deletion requires the admin role on ${target}.`, viewer, backUrl);
        return;
      }
      if (field(req, 'confirm').trim() !== target) {
        fail(res, 400, `Type ${target} exactly to confirm deletion.`, viewer, backUrl);
        return;
      }
      await ops.deleteRepo(root, loaded.repo.collection, loaded.repo.name, repoCtx);
      res.redirect(`/${encodeURIComponent(loaded.repo.collection)}`);
    })
  );

  // ---- user administration ----
  // Users are the site admin's business, mirroring the JSON API: creating
  // them, the site-admin bit, and their tokens. What a user may reach is not
  // set here; it lives with the repositories (collaborators) and collections
  // (owners) that grant it.

  function requireAdminPage(req: Request, res: Response): Viewer | null {
    const viewer = requireViewerPage(root, req, res);
    if (!viewer) return null;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Site admin access required (sessions from restricted tokens carry no admin rights).', viewer, '/');
      return null;
    }
    return viewer;
  }

  function requireAdminPost(req: Request, res: Response): Viewer | null {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return null;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Site admin access required (sessions from restricted tokens carry no admin rights).', viewer, '/');
      return null;
    }
    return viewer;
  }

  // Everything under /admin already takes a site admin; the helper survives
  // so a page for a weaker audience added later has the check to reach for.
  function canSetVaultWide(viewer: Viewer): boolean {
    return isSiteAdmin(viewer.auth);
  }

  app.get('/admin', (req, res) => {
    const viewer = requireAdminPage(req, res);
    if (!viewer) return;
    res.type('html').send(forms.adminIndexPage(viewer, canSetVaultWide(viewer)));
  });

  app.get('/admin/egress', (req, res) => {
    const viewer = requireAdminPage(req, res);
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
    const viewer = requireAdminPost(req, res);
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

  app.get('/admin/appearance', (req, res) => {
    const viewer = requireAdminPage(req, res);
    if (!viewer) return;
    if (!canSetVaultWide(viewer)) {
      fail(res, 403, 'Changing the theme takes a site admin.', viewer, '/admin');
      return;
    }
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(forms.appearancePage(viewer, THEMES, loadConfig(root).theme, msg));
  });

  app.post('/admin/appearance', form, (req, res) => {
    const viewer = requireAdminPost(req, res);
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
    const viewer = requireAdminPage(req, res);
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
    const viewer = requireAdminPost(req, res);
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
      const viewer = requireAdminPost(req, res);
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
    const viewer = requireAdminPost(req, res);
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
    const viewer = requireAdminPost(req, res);
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

  app.get('/admin/users', (req, res) => {
    const viewer = requireAdminPage(req, res);
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
    const viewer = requireAdminPost(req, res);
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
    const result = addUserToken(root, username, { siteAdmin: field(req, 'siteAdmin') === 'true' });
    res.type('html').send(forms.tokenPage(viewer, username, result.token, true));
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
    const viewer = requireAdminPage(req, res);
    if (!viewer) return;
    const found = loadUserForAdmin(req, res, viewer, '/admin/users');
    if (!found) return;
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(forms.adminUserPage(viewer, found.name, found.user, msg));
  });

  app.post('/admin/users/:name/tokens/:id/revoke', form, (req, res) => {
    const viewer = requireAdminPost(req, res);
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
    const viewer = requireAdminPost(req, res);
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
    const viewer = requireAdminPost(req, res);
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
    const viewer = requireAdminPost(req, res);
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
    if (removeUser(root, found.name)) removeUserGrants(root, found.name);
    res.redirect(`/admin/users?msg=${encodeURIComponent(`Deleted ${found.name} and revoked their tokens.`)}`);
  });

  app.post('/admin/users/:name/grant', form, (req, res) => {
    const viewer = requireAdminPost(req, res);
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
    const viewer = requireAdminPost(req, res);
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
    });
    res.type('html').send(forms.tokenPage(viewer, username, result.token, false));
  });
}
