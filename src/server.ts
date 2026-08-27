import compression from 'compression';
import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { registerApi } from './api';
import { registerBrowse } from './browse';
import { registerCiApi } from './ci/api';
import { CiEngine } from './ci/engine';
import { startWakeDispatcher } from './ci/wake';
import { registerCiWeb } from './ci/web';
import { loadConfig } from './config';
import { createEgress, egressMessage } from './egress';
import { clientKey, createAuthLimiter, createGates, createLimiter } from './limit';
import { registerCompare } from './compare';
import { registerFind, registerSearch } from './find';
import { registerIssues } from './issueweb';
import { registerGitHttp } from './githttp';
import { registerLfs } from './lfs';
import { registerPulls } from './pullweb';
import { registerReleases } from './releases';
import { createLfsStore } from './lfsstore';
import { COLLECTIONS_DIR, REPOS_DIR, repoPath } from './layout';
import { faviconSvg } from './logo';
import { startMaintenance } from './maintenance';
import { migrateLayout, migratePermissions, migratePushPolicy } from './migrate';
import { repoRole } from './perms';
import { registerRedirects } from './redirects';
import { displayName, listCollections, listRepoDirs } from './scan';
import { repoTopics } from './topics';
import { getViewer, renewSession } from './session';
import { registerSiteHost } from './site';
import { isSiteRequest } from './domains';
import { styleSheet } from './assets';
import { pageScript } from './pagescript';
import { ageScript } from './agescript';
import { activeTheme, findTheme, setActiveTheme } from './themes';
import * as views from './views';
import { registerWebOps } from './webops';

// Exempt from the coarse ceiling, checked before anything is charged.
//
// /api/runner/* because the runner's long poll and its log posts are
// legitimately high-volume from one address, and a runner sharing an address
// with a person must not throttle either. The assets because they are served
// from memory or a package directory and are cheaper to answer than to count.
//
// The asset prefixes are exempt on the forge's own hostname only: on a sites
// hostname those paths belong to the site being served, and are ordinary traffic.
// Responses that must reach the client exactly as written, so compression is
// not offered on them.
//
// The git wire protocol and LFS carry their own compression -- a packfile is
// already deflated -- and both stream, so wrapping them costs CPU to make the
// body no smaller and delays the first bytes of a clone. The backup stream is
// the same bargain over a much bigger body.
//
// Everything else is HTML, CSS, JSON or plain text, where the saving is large:
// a repository page goes from 133 KB to 11 KB.
const UNCOMPRESSED = /^\/[^/]+\/[^/]+\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/)|^\/api\/backup\//;

function isCompressible(req: Request, res: Response): boolean {
  if (UNCOMPRESSED.test(req.path)) return false;
  return compression.filter(req, res);
}

/**
 * What a forge page may load, and from where.
 *
 * The interface serves untrusted content from its own origin -- a repository's
 * files, an issue somebody wrote, a rendered README -- so escaping and
 * sanitizing are not the only line worth having. This one is the browser's:
 * even a page that somehow carried injected markup could not run it.
 *
 * script-src 'self' is the directive that does the work, and it is why the
 * pages carry no inline script at all: the one script they load is
 * /assets/page.js, and everything page-specific reaches it through a data
 * attribute (see src/pagescript.ts). A policy that allowed inline script would
 * allow an injected one too, since the browser cannot tell them apart.
 *
 * Two directives are looser than the rest, both deliberately:
 *
 *   style-src allows inline style, because the interface paints with values it
 *   computes -- a language bar's widths, a theme swatch's palette, an egress
 *   meter's fill. An inline style cannot execute anything, so this buys much
 *   less than script-src and costs nothing to keep.
 *
 *   img-src allows any host, because markdown may already reference an
 *   external image and does today; narrowing it would silently stop READMEs
 *   rendering and needs an image proxy first, which is what GitHub built for
 *   the same reason.
 *
 * frame-ancestors keeps the forge's own pages out of somebody else's frame: a
 * CSRF token and the Origin check in src/session.ts refuse a request forged
 * from elsewhere, but neither refuses a real click on a real page inside a
 * frame, which is what would let a merge, a close, or a branch deletion be
 * obtained from a signed-in reader who thought they were clicking something of
 * the framing page's. base-uri and form-action close the two ways injected
 * markup could redirect a relative URL or a form post without running script.
 *
 * form-action names github.com beside 'self' because browsers apply the
 * directive to a redirect that follows a form submission, not only to the
 * form's own target: the account page's "Link a GitHub account" form posts to
 * this vault, whose answer is a redirect to GitHub's authorize page (see
 * src/webops.ts), and without the entry the browser blocks that redirect. An
 * injected form is not helped by it: posting to github.com carries nothing of
 * the vault's, and the sign-in cookie in particular never leaves 'self'.
 */
const FORGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data:',
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self' https://github.com",
  "frame-ancestors 'self'",
].join('; ');

function isRateExempt(root: string, req: Request): boolean {
  if (req.path.startsWith('/api/runner/')) return true;
  if (isSiteRequest(root, req.hostname)) return false;
  return req.path.startsWith('/assets/') || req.path === '/favicon.svg' || req.path === '/favicon.ico';
}

export function createApp(root: string) {
  // Before anything is served: a vault written under the older layout, with
  // its collections directly in the root, is moved to the current one. Renames
  // only, and a no-op on a vault already laid out this way. A vault that could
  // not be migrated is not served, since serving it would show an empty vault
  // to someone whose repositories are all still there.
  const migration = migrateLayout(root);
  if (migration) {
    console.log(
      `Migrated ${migration.collections.length} collection(s) to ${COLLECTIONS_DIR}/<collection>/${REPOS_DIR}/: ${migration.collections.join(', ')}`
    );
  }
  // Likewise a vault.json from before roles: its glob scopes become owners,
  // collaborators, and the site-admin bit, and each rounding is said aloud.
  const permNotes = migratePermissions(root);
  if (permNotes) {
    for (const note of permNotes) console.log(`permissions: ${note}`);
  }
  // And a vault from before force pushes were allowed, whose repositories
  // would otherwise go on refusing them while every new one accepted them.
  const unfrozen = migratePushPolicy(root);
  if (unfrozen.length > 0) {
    console.log(`push policy: force pushes now allowed on ${unfrozen.join(', ')}`);
  }

  const app = express();
  app.disable('x-powered-by');
  const config = loadConfig(root);
  // Behind a TLS proxy (Caddy, Fly, etc.) X-Forwarded-Proto/Host must win, or
  // clone URLs and Secure cookies would use the internal address. On a vault
  // exposed directly they must not: req.ip would then be read from a
  // client-supplied X-Forwarded-For, which defeats every per-address limit and
  // makes the limiter's own key space unbounded.
  //
  // Read once at startup rather than per request, unlike the theme and the CI
  // settings. Express resolves 'trust proxy' when the Request prototype is
  // built, so it is not a per-request decision to make, and changing whether the
  // internet is trusted is a restart-worthy event in a way that changing a
  // colour scheme is not. The same goes for the limits below, which hold live
  // counts that cannot be rebuilt per request without discarding them.
  app.set('trust proxy', config.network.trustProxy);

  // Outgoing bytes, counted per repository and capped per day. The cap is read
  // through loadConfig on every call rather than captured here, unlike the rest
  // of the limits block: it is the one limit whose value an operator needs to
  // change while the vault is refusing to answer.
  const egress = createEgress(root, () => loadConfig(root).limits.egressGbPerDay);

  // First of all, because it has to attach its listeners before anything can
  // end the response. What it counts is what reaches the socket, so it is
  // indifferent to what wraps the body after this point: whatever answers the
  // request, and in whatever encoding, those bytes are charged to somebody.
  app.use((req, res, next) => {
    egress.watch(req, res);
    next();
  });

  // Ahead of every route and every other middleware, because it works by
  // wrapping the response: anything mounted earlier would answer uncompressed.
  // That includes the sites served from this process and the error pages.
  app.use(compression({ filter: isCompressible }));

  const gates = createGates(config.limits);
  const authLimiter = createAuthLimiter(config.limits.authFailures);
  const requestLimiter = createLimiter({
    limit: config.limits.requestsPerMinute,
    windowMs: 60000,
    maxKeys: 20000,
  });

  // The theme is vault state, so it is re-read (stat-cached) per request:
  // hand-editing config.json takes effect without a restart.
  app.use((_req, _res, next) => {
    setActiveTheme(loadConfig(root).theme);
    next();
  });

  // The bluntest of the three limits: a ceiling on ordinary traffic, so that one
  // misbehaving crawler cannot saturate the process with cheap page renders. It
  // is high on purpose. One page load of a static site can be dozens of requests,
  // and a limit that makes a site feel broken will be turned off and take the
  // useful limits with it.
  //
  // Registered before the sites middleware, so that traffic to a site's own
  // hostname is counted too, which is exactly where a burst of requests per page
  // comes from.
  app.use((req, res, next) => {
    if (isRateExempt(root, req)) return next();
    const decision = requestLimiter.hit(clientKey(req));
    if (decision.ok) return next();
    res.status(429).setHeader('Retry-After', String(decision.retryAfter));
    res
      .type('html')
      .send(views.errorPage(429, 'Too many requests from this address. Try again in a moment.', { viewer: null }));
  });

  // The daily egress budget, checked before any route can produce a body.
  //
  // Registered after the counter and before the sites middleware, for the same
  // reason the request limiter is: a site's own hostname is where the bytes
  // mostly go, so it has to be inside the budget rather than in front of it.
  //
  // The refusal is HTML for every client, as the 429 above is. A git client
  // shows the body it did not expect, which reads worse than a plain line but
  // says the same thing, and one shape of refusal is one place to change it.
  app.use((req, res, next) => {
    const decision = egress.allow(req);
    if (!decision) return next();
    res.status(503).setHeader('Retry-After', String(decision.retryAfter));
    res.type('html').send(views.errorPage(503, egressMessage(decision), { viewer: null }));
  });

  // Sites served from their own hostname are answered before every other route,
  // the asset routes included: otherwise /assets/style.css would give a site the
  // forge's stylesheet instead of its own, and /favicon.svg the forge's icon.
  // Nothing here runs unless a sites host is configured or a custom domain is
  // mapped in domains.json.
  registerSiteHost(app, root);

  // The forge's own pages may only be framed by the forge. A CSRF token and the
  // Origin check in src/session.ts refuse a request forged from somewhere else,
  // but neither refuses a real click on a real page inside somebody else's
  // frame, which is what would let a merge, a close, or a branch deletion be
  // obtained from a signed-in reader who thought they were clicking something
  // of the framing page's. Registered after the sites middleware, so a request
  // on a sites hostname never reaches it.
  //
  // A Content-Security-Policy and not X-Frame-Options: site content served on
  // the forge host replaces this header with its own sandbox policy (see
  // setSiteHeaders in src/site.ts), and an X-Frame-Options it could not
  // replace would stop a published site being embedded anywhere, which is
  // ordinary for a static site and no business of the forge's.
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', FORGE_CSP);
    // On every response, not only the raw file routes that already carried it:
    // nothing the forge serves relies on type sniffing, so there is no reason
    // to leave any response open to it.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The browser's own default, stated explicitly so a link out of a private
    // vault never carries a path in its referrer whatever the browser's
    // settings say.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Then, before any route that resolves a name: an address a rename left
  // behind is sent to where that name went. Only ever a name nothing answers
  // to, so nothing that exists is affected; see src/redirects.ts. After the
  // sites middleware, because a path on a sites hostname is a path inside a
  // site and means nothing to the forge's own routes.
  registerRedirects(app, root);

  // ---- static assets ----

  const hlCache = new Map<string, string>();
  app.get('/assets/style.css', (req, res) => {
    const sheet = styleSheet(activeTheme());
    // A request that names the body it wants may keep it forever, because a
    // different body would be a different tag and so a different URL. One that
    // does not -- an old page still in a tab, or someone typing the path --
    // gets the current sheet and no licence to hold on to it.
    const fresh = String(req.query.v ?? '') === sheet.tag;
    res
      .type('text/css')
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(sheet.body);
  });
  // The page script, on the same terms as the stylesheet above: a request that
  // names the body it wants may keep it forever, since a different body would
  // be a different tag and so a different URL.
  app.get('/assets/page.js', (req, res) => {
    const script = pageScript();
    const fresh = String(req.query.v ?? '') === script.tag;
    res
      .type('text/javascript')
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .set('X-Content-Type-Options', 'nosniff')
      .send(script.body);
  });
  // The encrypted-file script, on the same terms again. It is ~300 KB of
  // vendored cryptography plus its glue, which is why only the pages that
  // need it link it (see PageOpts.ageScript) and why the immutable caching
  // matters more here than anywhere.
  app.get('/assets/age.js', (req, res) => {
    const script = ageScript();
    const fresh = String(req.query.v ?? '') === script.tag;
    res
      .type('text/javascript')
      .set('Cache-Control', fresh ? 'public, max-age=31536000, immutable' : 'no-cache')
      .set('X-Content-Type-Options', 'nosniff')
      .send(script.body);
  });
  app.get('/assets/hl.css', (req, res) => {
    // Code colours are a whole stylesheet rather than a set of tokens, so the
    // reader's theme picks a file instead of an attribute. The name still
    // comes from the theme table and never from the request: ?t= selects a
    // theme by name, and an unknown one falls back to the vault's.
    const name = (findTheme(String(req.query.t ?? '')) ?? activeTheme()).hljs;
    let css = hlCache.get(name);
    if (css === undefined) {
      try {
        css = fs.readFileSync(require.resolve(`highlight.js/styles/${name}.css`), 'utf8');
      } catch {
        css = '';
      }
      hlCache.set(name, css);
    }
    res.type('text/css').set('Cache-Control', 'public, max-age=86400').send(css);
  });
  // Every repository the interface would show this viewer anyway, as names
  // and topics, for the jump box to search without a round trip per
  // keystroke. It says no more than the front page already does to the same
  // eyes: a private repository is listed only for a viewer with a role there,
  // which is also why the answer is marked private to shared caches. It is
  // not /api/repos, which is the authenticated interface for programs and
  // carries much more per repository. Topics ride along only where a
  // repository has them, so the common entry stays one name.
  app.get('/assets/repos.json', (req, res) => {
    const viewer = getViewer(req, root);
    const repos: { name: string; topics?: string[] }[] = [];
    for (const c of listCollections(root)) {
      for (const d of listRepoDirs(root, c.name)) {
        const name = displayName(d);
        const dir = repoPath(root, c.name, d);
        if (repoRole(root, viewer?.auth ?? null, { collection: c.name, name, dir }) === null) {
          continue;
        }
        const topics = repoTopics(dir);
        repos.push(topics.length ? { name: `${c.name}/${name}`, topics } : { name: `${c.name}/${name}` });
      }
    }
    res.set('Cache-Control', 'private, no-cache').json(repos);
  });
  // KaTeX ships the stylesheet and fonts its output needs; serving them from
  // the installed package keeps rendered math working with no external
  // requests, which matters for vaults on closed networks.
  const katexDir = path.dirname(require.resolve('katex/dist/katex.min.css'));
  let katexCss: string | null = null;
  app.get('/assets/katex/katex.css', (_req, res) => {
    if (katexCss === null) katexCss = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8');
    res.type('text/css').set('Cache-Control', 'public, max-age=86400').send(katexCss);
  });
  app.get('/assets/katex/fonts/:file', (req, res) => {
    // The request never reaches the filesystem unless it names a KaTeX font.
    if (!/^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2|woff|ttf)$/.test(req.params.file)) {
      res.status(404).end();
      return;
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(katexDir, 'fonts', req.params.file));
  });
  // The favicon is the logo mark on a tile coloured from the active theme, so
  // it changes with the vault's appearance. Browsers that will not take an SVG
  // icon fall back to /favicon.ico, which stays empty.
  app.get('/favicon.svg', (_req, res) => {
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(faviconSvg());
  });
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // The LFS store is built from the environment once at startup; a partial
  // bucket configuration throws here, which the CLI turns into a non-zero
  // exit naming the missing variables.
  const lfs = createLfsStore(root);
  console.log(`Git LFS storage backend: ${lfs.label}`);

  // The CI engine plans and schedules workflow runs; jobs execute on runners
  // elsewhere (mochi runner run), never in this process.
  const engine = new CiEngine(root, () => loadConfig(root).ci);
  // Unreachable objects, from a force push or a branch deleted or a history
  // rewritten, are collected on a slow timer with a generous grace period. See
  // src/maintenance.ts for why it is safe to run beside live traffic.
  startMaintenance(root);

  // A runner that stops when it has nothing to do cannot be told that it has
  // something to do, so the vault starts it: this watches for a queued job
  // whose runner is not connected and pokes that runner's wake address.
  // Runners without one are unaffected, which is all of them by default.
  startWakeDispatcher(root, engine);

  // Sliding sessions: a session cookie seen in the second half of its life is
  // re-issued with a fresh expiry, so regular use never runs into a sign-out.
  // Registered after the asset routes above on purpose -- several of them are
  // publicly cacheable, and a Set-Cookie must never ride on a response a
  // shared cache may store and replay to someone else.
  app.use((req, res, next) => {
    renewSession(req, res, root);
    next();
  });

  // Registration order matters: the API and the UI-owned top-level paths
  // (/login, /new, /admin, ...) come before the generic /:collection and /:collection/:repo
  // browse routes, and more-specific wildcard routes before their prefixes.
  // LFS registers before git HTTP so its /info/lfs/* routes are matched ahead
  // of any /info/refs handling.
  registerApi(app, root, authLimiter, gates, lfs, engine, egress);
  registerCiApi(app, root, engine, authLimiter);
  registerLfs(app, root, lfs, authLimiter);
  registerGitHttp(app, root, gates, authLimiter, engine);
  registerCiWeb(app, root, engine);
  registerWebOps(app, root, authLimiter, lfs, engine, egress);
  registerCompare(app, root);
  registerIssues(app, root);
  registerPulls(app, root, engine);
  registerReleases(app, root);
  registerFind(app, root, gates);
  registerSearch(app, root, gates);
  registerBrowse(app, root, gates, lfs);

  app.use((req, res) => {
    res.status(404).type('html').send(views.errorPage(404, 'Page not found', { viewer: getViewer(req, root) }));
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      console.error(err);
      res.end();
      return;
    }
    let viewer = null;
    try {
      viewer = getViewer(req, root);
    } catch {
      viewer = null;
    }
    // The body parsers throw typed errors carrying the status they deserve --
    // a body over the route's limit, a malformed encoding, an aborted upload.
    // Those are refusals of the request, not failures of the server, so they
    // get their status and a sentence a person can act on rather than the bare
    // 500 below.
    const status = (err as Error & { statusCode?: unknown; status?: unknown }).statusCode ?? (err as Error & { status?: unknown }).status;
    const type = (err as Error & { type?: unknown }).type;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message =
        type === 'entity.too.large'
          ? 'What you submitted is larger than this form accepts. Files this size can go through the Upload files form, or a git push.'
          : 'The request could not be read; go back and try again.';
      res.status(status).type('html').send(views.errorPage(status, message, { viewer }));
      return;
    }
    console.error(err);
    res.status(500).type('html').send(views.errorPage(500, 'Internal server error', { viewer }));
  });

  return app;
}
