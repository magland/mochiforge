import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Request, Response } from 'express';
import { loadConfig } from './config';
import { fileCache } from './filecache';
import { isUnderSitesHost } from './siteshost';
import { isSiteAdmin } from './perms';
import { AuthResult, authForBinding, loadVault } from './vault';

// Stateless signed-cookie sessions on top of the token model. The payload is
// base64url JSON plus an HMAC keyed by <vault>/.secret. There is no server-side
// session store: permissions are re-derived from live vault.json on every
// request, so deleting a user's tokens cuts them off, and rotating .secret
// invalidates every session at once.
//
// A session is bound to the single credential it was minted from, by
// recording that token's SHA-256 hash (the same value vault.json stores, so
// no new secret is put in the cookie, and the hash is useless as a
// credential) or, for a passkey sign-in, the passkey's binding string (see
// authForBinding in src/vault.ts). Resolving a session looks that credential
// up in live vault.json, so deleting one token or passkey ends the sessions
// it started and leaves the user's other sessions alone. The token record
// found this way is the real one, which is why the session carries no copy of
// the token's scope: the role checks in src/perms.ts read it from the vault.

// Cookies are not scoped by origin, so any document on any host under a shared
// parent domain can set a cookie named mochi_session with
// Domain=<parent>, which the browser then also sends here. With several vaults
// on sibling subdomains of one domain, that lets one of them shadow another's
// session. Browsers refuse a __Host--prefixed cookie that carries a Domain
// attribute at all, which closes it.
//
// The prefix also requires Secure and Path=/, so the name is conditional on
// exactly when the prefix is legal: setSessionCookie already sets path '/' and
// sets secure from req.protocol, and a plain-http vault keeps the bare name.
const HOST_COOKIE_NAME = '__Host-mochi_session';
const COOKIE_NAME = 'mochi_session';
const cookieName = (req: Request) => (req.protocol === 'https' ? HOST_COOKIE_NAME : COOKIE_NAME);
// Effectively an idle limit rather than a hard one: renewSession below
// re-issues a cookie seen in the second half of its life, so only a session
// unused for this long actually expires.
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  u: string;
  exp: number;
  csrf: string;
  t: string;
}

/** Write a fresh signing key where one is missing or unusable. */
function mintSecret(file: string): Buffer {
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// Stat-cached rather than held forever, so that rotating the file does what
// the documentation says it does -- ends every session at once -- on the
// running server, not on the next restart. The stat per check is the same
// price every other state file pays.
const secretCache = fileCache<Buffer>({
  read: (file) => {
    try {
      const secret = fs.readFileSync(file);
      if (secret.length >= 32) return secret;
    } catch {
      // unreadable; replaced below
    }
    return mintSecret(file);
  },
  missing: (file) => mintSecret(file),
});

export function getSecret(root: string): Buffer {
  return secretCache.get(path.join(root, '.secret'));
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(root: string, data: string): string {
  return b64url(crypto.createHmac('sha256', getSecret(root)).update(data).digest());
}

/**
 * Whether this request arrived on a hostname that serves sites. No session is
 * resolved and none is minted there. The sites middleware never asks for a
 * viewer, so this is defence in depth: it makes structurally true what would
 * otherwise be true only by inspection.
 */
function onSitesHost(req: Request, root: string): boolean {
  return isUnderSitesHost(loadConfig(root).sites.host, req.hostname);
}

function writeSessionCookie(req: Request, res: Response, root: string, payload: SessionPayload): void {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  res.cookie(cookieName(req), `${body}.${sign(root, body)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: SESSION_MS,
    path: '/',
  });
}

export function setSessionCookie(req: Request, res: Response, root: string, auth: AuthResult): void {
  if (onSitesHost(req, root)) return;
  writeSessionCookie(req, res, root, {
    u: auth.username,
    exp: Date.now() + SESSION_MS,
    csrf: crypto.randomBytes(16).toString('hex'),
    t: auth.token.hash,
  });
}

/**
 * A session in use is kept alive. A request arriving in the second half of the
 * cookie's life gets a fresh cookie carrying the same identity, credential
 * binding, and csrf value (so a form already open in another tab still
 * submits), with the expiry pushed out to a full SESSION_MS again. An account
 * visited more often than every SESSION_MS therefore never sees a sign-out,
 * while a session left idle still dies on schedule. The renewal re-resolves
 * the credential against live vault.json first: a session whose token or
 * passkey has been revoked is not given a fresh cookie on its way out.
 */
export function renewSession(req: Request, res: Response, root: string): void {
  if (onSitesHost(req, root)) return;
  const session = readSession(req, root);
  if (!session) return;
  if (session.exp - Date.now() > SESSION_MS / 2) return;
  const state = loadVault(root);
  if (state.status !== 'ok') return;
  if (!authForBinding(state.vault, session.u, session.t)) return;
  writeSessionCookie(req, res, root, { ...session, exp: Date.now() + SESSION_MS });
}

// Both names, since a session minted before the prefix existed, or over http
// on a vault that has since gained TLS, is still a session to clear. The
// prefix rules apply to the deletion Set-Cookie too: without Secure the
// browser discards it and the session survives, so sign-out would silently do
// nothing on an https vault.
export function clearSessionCookie(res: Response): void {
  res.clearCookie(HOST_COOKIE_NAME, { path: '/', secure: true });
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed cookie value; skip
    }
  }
  return out;
}

function readSession(req: Request, root: string): SessionPayload | null {
  // The prefixed name first, then the bare one, so a session minted before this
  // existed survives. A sibling subdomain can still set the bare name, which is
  // why the prefixed one wins when both arrive.
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[HOST_COOKIE_NAME] ?? cookies[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(root, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.u !== 'string' || typeof p.exp !== 'number' || typeof p.csrf !== 'string') return null;
  if (p.exp < Date.now()) return null;
  // A cookie from before sessions were bound to a token has no `t`, and is
  // rejected rather than accepted unbound: the holder is simply signed out and
  // signs in again, which is a smaller cost than leaving unrevocable sessions
  // alive for the rest of their thirty days.
  if (typeof p.t !== 'string' || p.t === '') return null;
  return { u: p.u, exp: p.exp, csrf: p.csrf, t: p.t };
}

// A Viewer is a signed-in browser session resolved against live vault.json.
// Its auth is the AuthResult that the session's own token would produce now, so
// the role checks apply unchanged; a session minted from a restricted token
// resolves to that restricted token record and therefore has no admin rights.
export interface Viewer {
  auth: AuthResult;
  csrf: string;
}

export function getViewer(req: Request, root: string): Viewer | null {
  if (onSitesHost(req, root)) return null;
  const session = readSession(req, root);
  if (!session) return null;
  const state = loadVault(root);
  if (state.status !== 'ok') return null;
  // `t` is the token hash the session was minted from, or a passkey binding;
  // either way it resolves against live vault.json, so revoking the token or
  // removing the passkey ends the session on the next request.
  const auth = authForBinding(state.vault, session.u, session.t);
  if (!auth) return null;
  return { auth, csrf: session.csrf };
}

export function viewerIsAdmin(viewer: Viewer | null): boolean {
  return viewer !== null && isSiteAdmin(viewer.auth);
}

export function checkCsrf(req: Request, viewer: Viewer): boolean {
  const presented = (req.body as Record<string, unknown> | undefined)?.csrf;
  return typeof presented === 'string' && csrfMatches(req, presented, viewer);
}

/**
 * A state-changing request whose Origin names somewhere else is refused. This
 * does nothing against same-origin script, which is what the site sandbox in
 * src/site.ts closes; it is a few lines that catch a misconfigured proxy, and it
 * belongs next to the CSRF check so the two are read together. An absent Origin
 * is not a failure: plenty of legitimate clients send none.
 */
function originOk(req: Request): boolean {
  const origin = req.get('origin');
  // Absent is allowed. Literal "null" is not: that is an opaque origin, which
  // is what a sandboxed document has, and nothing in the forge's own interface
  // sends it.
  if (!origin) return true;
  if (origin === 'null') return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  // The hostname only, and not the scheme or the port. req.hostname honours
  // X-Forwarded-Host, so it is the name the browser used; req.protocol is
  // http on a vault behind a TLS proxy that is not trusted, and comparing it
  // would then refuse every legitimate form on a merely misconfigured vault.
  // An attacker who can answer for our hostname over plain http is already
  // between the browser and the server.
  return u.hostname.toLowerCase() === req.hostname.toLowerCase();
}

/**
 * The comparison behind checkCsrf, for a handler that has the value in hand
 * rather than in req.body - a multipart form, which express does not parse.
 */
export function csrfMatches(req: Request, presented: string, viewer: Viewer): boolean {
  if (!originOk(req)) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(viewer.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
