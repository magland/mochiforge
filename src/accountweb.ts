import express, { Express, Request, Response } from 'express';
import { loadConfig } from './config';
import * as forms from './forms';
import {
  exchangeGithubCode,
  fetchGithubUser,
  githubAuthorizeUrl,
  githubConfigured,
  readGithubSecret,
} from './githubauth';
import { AuthLimiter } from './limit';
import { HANDOFF_TTL_MS, mintHandoff, peekLoginLink, takeHandoff, takeLoginLink } from './logincodes';
import { naming } from './naming';
import { createOneTimeStore } from './onetime';
import { Viewer, clearSessionCookie, csrfMatches, getViewer, originOk, setSessionCookie } from './session';
import {
  addPasskey,
  authForBinding,
  authenticate,
  findPasskey,
  githubBinding,
  linkGithub,
  loadVault,
  passkeyBinding,
  removePasskey,
  resolveGithubSignIn,
  setPasskeyCounter,
  setUserProfile,
  unlinkGithub,
} from './vault';
import { SUPPORTED_ALGS, WebAuthnError, claimedChallenge, fromB64url, verifyAssertion, verifyRegistration } from './webauthn';
import { ah, fail, field, requireViewerPage, requireViewerPost, urlencodedForm } from './web';

// The routes about a person rather than about a repository: signing in and
// out (by token, passkey, a code carried from another browser, a one-time
// link, or GitHub), the account page, and the profile a user's page shows.
//
// They were part of registerWebOps and are registered from it still, at the
// same point in the order, so mochi serves exactly what it did. They live
// apart so that a sibling application built on these modules (see
// src/naming.ts) can register the same sign-in and account pages without the
// forge's repository routes coming along.

const form = urlencodedForm('3mb');

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
export function safeNext(v: string): string {
  if (!v.startsWith('/')) return '/';
  if (v[1] === '/' || v[1] === '\\') return '/';
  if (/[\x00-\x1f\x7f]/.test(v)) return '/';
  return v;
}

/** Where GitHub sends a sign-in back to; the admin page shows it for registering the OAuth app. */
export function githubCallbackUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}/login/github/callback`;
}

export function registerAccountWeb(app: Express, root: string, authLimiter: AuthLimiter): void {
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
      rp: { id: rpIdOf(req), name: `${naming.displayName} (${rpIdOf(req)})` },
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
}
