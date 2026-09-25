import { Request, Response } from 'express';
import { GitRepo } from '../git';
import { AuthLimiter } from '../limit';
import { naming } from '../naming';
import { OpError, opErrorStatus } from '../ops';
import { canAdminRepo, canReadRepo, canWriteRepo } from '../perms';
import { findRepo } from '../scan';
import { AuthResult, authenticateToken, loadVault } from '../vault';

// Authorization for the JSON API, in one place because there is more than one
// file of routes behind it. Only bearer tokens are accepted: session cookies
// never authorize an API call, and git's Basic auth never does either.
//
// Anonymous reads are deliberately not offered. The web is where anonymous
// reading lives, and requiring a token on /api keeps one rule for the whole
// surface.
//
// Two transports over one domain layer is two places to forget a role check, so
// the shape here is not a helper a handler may neglect to call. requireRepo and
// requirePush are what produce the repository a domain function needs, and they
// load the repository and the scope together: a handler that skips the check has
// nothing to pass to the domain function.

export function apiError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/**
 * The caller's identity, or null having already answered with the refusal. A
 * handler that ignores the null is a handler that runs unauthenticated, so the
 * shape to write is `const auth = requireApiAuth(...); if (!auth) return;`.
 */
export function requireApiAuth(
  root: string,
  limiter: AuthLimiter,
  req: Request,
  res: Response
): AuthResult | null {
  const state = loadVault(root);
  if (state.status === 'missing') {
    apiError(res, 401, `no ${naming.stateFile} in this ${naming.rootNoun}; restart the server to initialize one`);
    return null;
  }
  if (state.status === 'error') {
    apiError(res, 500, `${naming.stateFile} could not be read: ${state.message}`);
    return null;
  }
  const m = (req.get('authorization') ?? '').match(/^bearer\s+(.+)$/i);
  // A missing Authorization header is not a failed attempt and is not charged: a
  // browser wandering onto an API path with no header would otherwise consume a
  // real client's budget.
  if (!m) {
    apiError(res, 401, 'missing bearer token: send Authorization: Bearer <token>');
    return null;
  }
  // Bearer tokens carry no username, so only the coarse per-address window
  // really applies to them. Checking a credential is a loadVault and a hash, so
  // the cheapest request an attacker can send is one of the more expensive ones
  // this server can answer.
  const allowed = limiter.allow(req, null);
  if (!allowed.ok) {
    res.setHeader('Retry-After', String(allowed.retryAfter));
    apiError(res, 429, 'too many failed authentication attempts; try again later');
    return null;
  }
  const auth = authenticateToken(state.vault, m[1].trim());
  if (!auth) {
    limiter.fail(req, null);
    apiError(res, 401, 'invalid token');
    return null;
  }
  return auth;
}

/** Whom a write is attributed to. The two transports build their own; nothing else differs. */
export interface Actor {
  username: string;
  email: string;
}

export interface ReadContext {
  auth: AuthResult;
  repo: GitRepo;
}

export interface WriteContext extends ReadContext {
  actor: Actor;
}

// The address a commit made over the API is attributed to. The host is the
// vault's own, as it is for a commit made in the browser, so that the two
// interfaces do not attribute the same person differently.
function actorFor(req: Request, auth: AuthResult): Actor {
  const host = (req.get('host') ?? 'localhost').replace(/:\d+$/, '');
  return { username: auth.username, email: `${auth.username}@noreply.${host}` };
}

/**
 * The repository named by :collection and :repo, for a caller allowed to read
 * it. `:repo` is accepted with or without the .git suffix, as findRepo already
 * allows everywhere else. A private repository the caller has no role on gets
 * the same 404 an absent one gets, so a private name proves nothing by
 * existing.
 */
export function requireRepo(
  root: string,
  limiter: AuthLimiter,
  req: Request,
  res: Response
): ReadContext | null {
  const auth = requireApiAuth(root, limiter, req, res);
  if (!auth) return null;
  const collection = req.params.collection;
  const repo = findRepo(root, collection, req.params.repo);
  if (!repo || !canReadRepo(root, auth, repo)) {
    apiError(res, 404, `no repository ${collection}/${req.params.repo} in this vault`);
    return null;
  }
  return { auth, repo };
}

/** The same, for a caller who may also push to it. */
export function requirePush(
  root: string,
  limiter: AuthLimiter,
  req: Request,
  res: Response
): WriteContext | null {
  const found = requireRepo(root, limiter, req, res);
  if (!found) return null;
  if (!canWriteRepo(root, found.auth, found.repo)) {
    apiError(res, 403, `you do not have the write role on ${found.repo.collection}/${found.repo.name}`);
    return null;
  }
  return { ...found, actor: actorFor(req, found.auth) };
}

/** The same, for an operation that needs the admin role on the repository. */
export function requireRepoAdmin(
  root: string,
  limiter: AuthLimiter,
  req: Request,
  res: Response
): WriteContext | null {
  const found = requireRepo(root, limiter, req, res);
  if (!found) return null;
  if (!canAdminRepo(root, found.auth, found.repo)) {
    apiError(res, 403, `you do not have the admin role on ${found.repo.collection}/${found.repo.name}`);
    return null;
  }
  return { ...found, actor: actorFor(req, found.auth) };
}

/**
 * Turn a domain failure into a response, once, rather than per route.
 *
 * OpError already carries the distinction the caller needs, and mapping it here
 * is what keeps a validation failure from being reported as a 500. `nochange` is
 * a success: the caller asked for a state the vault is already in.
 */
export function sendOpError(res: Response, e: unknown, fallback = 'the operation failed'): void {
  if (!(e instanceof OpError)) {
    console.error(e);
    apiError(res, 500, fallback);
    return;
  }
  if (e.kind === 'nochange') {
    res.json({ changed: false, message: e.message });
    return;
  }
  apiError(res, opErrorStatus(e.kind), e.message);
}

/** A route body, with the shape checked far enough to read fields off it. */
export function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** A required string field. */
export function stringField(body: Record<string, unknown>, name: string): string | null {
  const v = body[name];
  return typeof v === 'string' ? v : null;
}

/** An optional list-of-strings field: undefined when absent, null when malformed. */
export function stringsField(body: Record<string, unknown>, name: string): string[] | null | undefined {
  const v = body[name];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return null;
}

/** A positive integer from a query parameter, within a cap. */
export function limitParam(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}
