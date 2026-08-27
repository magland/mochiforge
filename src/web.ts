import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import { hasCiState } from './ci/present';
import * as forms from './forms';
import { GitRepo, RefInfo } from './git';
import { issueCounts } from './issues';
import { BUSY_RETRY_SECONDS } from './limit';
import { pullCounts } from './pulls';
import { releaseTags } from './releases';
import { Role, atLeast, repoIsPrivate, repoRole } from './perms';
import { findRepo, forkParent, siteDir, upstreamOf } from './scan';
import { Viewer, checkCsrf, getViewer } from './session';
import { siteSettings } from './sitesettings';
import { siteHostUrl } from './site';
import { accountForEmail, loadVault } from './vault';
import { RepoCtx } from './views';
import * as views from './views';

// Helpers shared by the HTML route modules.

export function ah(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function wildcard(req: Request): string {
  return (req.params as Record<string, string>)['0'] ?? '';
}

export function send404(res: Response, message = 'Not found', viewer: Viewer | null = null) {
  res.status(404).type('html').send(views.errorPage(404, message, { viewer }));
}

/**
 * How a web route refuses when a concurrency gate is full. 503 rather than 429:
 * the condition is server capacity rather than a client quota, and nothing about
 * this request was wrong.
 */
export function sendBusy(res: Response, viewer: Viewer | null = null) {
  res.status(503).setHeader('Retry-After', String(BUSY_RETRY_SECONDS));
  res
    .type('html')
    .send(views.errorPage(503, 'The server is busy with other git work. Try again in a moment.', { viewer }));
}

// Form posts are read as urlencoded bodies with express's simple parser: the
// forms here are flat, so the extended syntax would only widen what a body may
// say. The limit is left to the caller, because what one page may reasonably
// carry (a file being edited) is not what another should (a release note).
export function urlencodedForm(limit: string): RequestHandler {
  return express.urlencoded({ extended: false, limit });
}

// A form field as a string. Anything the parser did not give us as a string
// (a missing field, or a repeated one arriving as an array) reads as empty
// rather than being passed on as something a handler did not expect.
export function field(req: Request, name: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
}

// How an operation refuses. backUrl, when given, is where the page offers to
// send the reader back to, which is usually the form they came from.
export function fail(
  res: Response,
  status: number,
  message: string,
  viewer: Viewer | null,
  backUrl?: string
): void {
  res.status(status).type('html').send(forms.opErrorPage(message, { viewer, backUrl }));
}

// For GET form pages: an anonymous visitor is sent to sign in and come back.
export function requireViewerPage(root: string, req: Request, res: Response): Viewer | null {
  const viewer = getViewer(req, root);
  if (!viewer) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  return viewer;
}

// For POSTs: a missing session or a bad CSRF value is a hard 403.
export function requireViewerPost(root: string, req: Request, res: Response): Viewer | null {
  const viewer = getViewer(req, root);
  if (!viewer) {
    fail(res, 403, 'You must be signed in to do that.', null, '/login');
    return null;
  }
  if (!checkCsrf(req, viewer)) {
    fail(res, 403, 'The form has expired; go back, reload the page, and try again.', viewer);
    return null;
  }
  return viewer;
}

export interface LoadedRepo {
  repo: GitRepo;
  branches: RefInfo[];
  tags: RefInfo[];
  defaultBranch: string | null;
  refNames: string[];
  /** The viewer's role here; at least 'read', or loadRepo would have 404ed. */
  role: Role;
}

/**
 * The repository named by the route, for a viewer allowed to read it. Every
 * HTML page about a repository is loaded through here, so this is where a
 * private repository disappears: a viewer with no role gets the same 404 an
 * absent repository gets, and a private name proves nothing by existing.
 */
export async function loadRepo(
  root: string,
  req: Request,
  res: Response,
  viewer: Viewer | null
): Promise<LoadedRepo | null> {
  const repo = findRepo(root, req.params.collection, req.params.repo);
  const role = repo ? repoRole(root, viewer?.auth ?? null, repo) : null;
  if (!repo || role === null) {
    send404(res, `Repository ${req.params.collection}/${req.params.repo} not found`, viewer);
    return null;
  }
  const [branches, tags] = await Promise.all([repo.listRefs('heads'), repo.listRefs('tags')]);
  const defaultBranch = await repo.defaultBranch(branches);
  return {
    repo,
    branches,
    tags,
    defaultBranch,
    refNames: [...branches.map((b) => b.name), ...tags.map((t) => t.name)],
    role,
  };
}

export async function makeCtx(
  root: string,
  req: Request,
  loaded: LoadedRepo,
  ref: string,
  viewer: Viewer | null
): Promise<RepoCtx> {
  const cloneUrl = `${req.protocol}://${req.get('host')}/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(
    loaded.repo.name
  )}`;
  // Where the Site tab points. A site with an origin of its own is linked there
  // directly rather than through the forge path that would only redirect.
  const siteOrigin = siteHostUrl(root, req, loaded.repo.collection, loaded.repo.name);
  // Ties names on the page back to vault users: commit author emails resolve
  // to accounts, and @mentions resolve to profile links. The vault is read
  // once per page; a vault that failed to load just resolves nobody.
  const state = loadVault(root);
  const vault = state.status === 'ok' ? state.vault : null;
  return {
    collection: loaded.repo.collection,
    repo: loaded.repo.name,
    ref,
    refIsBranch: loaded.branches.some((b) => b.name === ref),
    defaultBranch: loaded.defaultBranch ?? '',
    branches: loaded.branches,
    tags: loaded.tags,
    cloneUrl,
    hasSite: siteSettings(loaded.repo.dir).enabled && siteDir(root, loaded.repo.collection, loaded.repo.name) !== null,
    siteUrl: siteOrigin
      ? `${siteOrigin}/`
      : `/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(loaded.repo.name)}/site/`,
    releases: releaseTags(root, loaded.repo.collection, loaded.repo.name),
    hasCi: await hasCiState(root, loaded.repo, loaded.defaultBranch, loaded.branches),
    openIssues: issueCounts(root, loaded.repo.collection, loaded.repo.name).open,
    openPulls: pullCounts(root, loaded.repo.collection, loaded.repo.name).open,
    forkedFrom: forkParent(loaded.repo.dir),
    upstream: upstreamOf(loaded.repo.dir),
    viewer,
    isPrivate: repoIsPrivate(loaded.repo.dir),
    canPush: atLeast(loaded.role, 'write'),
    canAdmin: atLeast(loaded.role, 'admin'),
    accountFor: (email) => (vault ? accountForEmail(vault, email) : null),
    hasUser: (name) => (vault ? Object.prototype.hasOwnProperty.call(vault.users, name) : false),
  };
}

export function baseUrlOf(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}
