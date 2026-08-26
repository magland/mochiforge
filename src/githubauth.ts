import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';

// Sign-in with GitHub: the OAuth code flow against github.com, and the small
// outbound calls it needs. These are the only requests this server makes to
// another host, they happen only when an administrator has configured the
// feature, and nothing GitHub returns is stored: the access token is used for
// one request -- who signed in -- and dropped, so the vault holds no GitHub
// token. Who may sign in, and the gh:<id> session binding the callback mints,
// live in src/vault.ts beside the other credentials; the routes are in
// src/webops.ts with the other sign-in flows.

/**
 * Where the OAuth App's client secret is kept: a mode-600 file beside
 * `.secret`, because config.json is ordinary vault state and the secret is
 * not. The client id, which is public, does live in config.json.
 */
export const GITHUB_SECRET_FILE = '.github-secret';

// The three places the flow talks to, overridable so the tests can stand a
// local stub in for github.com. Nothing else writes this.
let endpoints = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  api: 'https://api.github.com',
};

export function overrideGithubEndpointsForTests(next: { authorize: string; token: string; api: string }): void {
  endpoints = next;
}

export function readGithubSecret(root: string): string | null {
  try {
    const secret = fs.readFileSync(path.join(root, GITHUB_SECRET_FILE), 'utf8').trim();
    return secret === '' ? null : secret;
  } catch {
    return null;
  }
}

export function writeGithubSecret(root: string, secret: string): void {
  fs.writeFileSync(path.join(root, GITHUB_SECRET_FILE), secret.trim() + '\n', { mode: 0o600 });
}

export function clearGithubSecret(root: string): void {
  fs.rmSync(path.join(root, GITHUB_SECRET_FILE), { force: true });
}

/** Whether sign-in with GitHub can work here: a client id and a stored secret. */
export function githubConfigured(root: string): boolean {
  return loadConfig(root).auth.githubClientId !== '' && readGithubSecret(root) !== null;
}

/** Where the sign-in redirect sends the browser. No scopes are requested: the
 * callback asks /user for the id and login, which a scopeless token can read. */
export function githubAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(endpoints.authorize);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

const FETCH_TIMEOUT_MS = 10000;
// GitHub's API refuses requests that carry no User-Agent.
const USER_AGENT = 'mochi-forge';

export interface GithubUser {
  id: number;
  login: string;
}

/** Trade the callback's code for an access token. Null on any refusal or
 * network failure; the caller has one message for all of them, since the
 * person at the browser can do the same thing about each: try again. */
export async function exchangeGithubCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string | null> {
  try {
    const res = await fetch(endpoints.token, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: opts.code,
        redirect_uri: opts.redirectUri,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: unknown };
    return typeof body.access_token === 'string' && body.access_token !== '' ? body.access_token : null;
  } catch {
    return null;
  }
}

/** Who the access token belongs to. The token's only use; it is not kept. */
export async function fetchGithubUser(accessToken: string): Promise<GithubUser | null> {
  try {
    const res = await fetch(`${endpoints.api}/user`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return asGithubUser(await res.json());
  } catch {
    return null;
  }
}

/** A GitHub login: alphanumeric with interior hyphens, at most 39 characters.
 * Checked before a lookup so a stray path or an @handle is refused with a
 * message rather than sent to the API inside a URL. */
export function isPlausibleGithubLogin(login: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login);
}

/**
 * Resolve a login to its stable numeric id, over GitHub's public,
 * unauthenticated API. Called once per approval an administrator adds, which
 * sits far under that API's rate limit.
 */
export async function lookupGithubLogin(login: string): Promise<GithubUser | null> {
  try {
    const res = await fetch(`${endpoints.api}/users/${encodeURIComponent(login)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return asGithubUser(await res.json());
  } catch {
    return null;
  }
}

function asGithubUser(body: unknown): GithubUser | null {
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;
  if (typeof rec.id !== 'number' || typeof rec.login !== 'string') return null;
  return { id: Math.floor(rec.id), login: rec.login };
}
