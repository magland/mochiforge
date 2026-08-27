import { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { domainRepoFor, repoDomain } from './domains';
import { containedIn } from './ops';
import { resolveRepoRedirect } from './redirects';
import { esc } from './render';
import { findRepo, siteDir } from './scan';
import { findRepoBySiteLabel, siteSettings } from './sitesettings';
import { isUnderSitesHost, normalizeHostname, parseSiteHost, siteHostFor, siteHostLabel } from './siteshost';
import { send404, wildcard } from './web';

// Serving a repository's static site. This is the only place in mochi where
// bytes supplied by someone other than the server are returned as HTML, so it
// is also the only place that needs to think about what that HTML is allowed to
// do. Raw blob views and LFS downloads are sandboxed where they are served
// (src/browse.ts, src/lfs.ts); site files were not, and a document served from
// the forge's own origin can read the visitor's session, scrape the CSRF token
// out of any page that session can fetch, and act as them. Anyone who can write
// <repo>.site held that capability, which is every user with the write role on the
// repository and every workflow that publishes it.
//
// Two answers, and the mode says which is in force. 'sandbox' is the default and
// works anywhere: the document is placed in an opaque origin, so it has no
// access to cookies and cannot make a credentialed request. 'host' is for a site
// served from its own hostname, where the browser's own origin separation is
// doing the work and sandboxing would only take capability away from the site
// for nothing.

export type SiteMode = 'sandbox' | 'host';

/**
 * The headers a site response carries. Set immediately before the body is sent,
 * on every path that sends one, the site's own 404.html included: a response
 * that escapes this is a response running with the forge's authority.
 */
export function setSiteHeaders(res: Response, mode: SiteMode): void {
  // nosniff in both modes. A file whose declared type is wrong is not licence
  // to guess something more dangerous.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (mode === 'host') return;
  // Deliberately without allow-same-origin, which is what puts the document in
  // an opaque origin: no cookie jar, no document.cookie, no localStorage or
  // IndexedDB, no service worker registration, and every request it makes to
  // the vault is cross-origin and credential-less. Script still runs, so the
  // feature survives.
  res.setHeader(
    'Content-Security-Policy',
    'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads'
  );
  // Load-bearing, not redundant. A page in an opaque origin cannot fetch its
  // own sibling files without it, which breaks any single-page app, wasm
  // loader, or data-driven site. Those fetches still carry no credentials, so
  // nothing is returned to an attacker. Site responses only: never on a forge
  // page and never on an API route.
  res.setHeader('Access-Control-Allow-Origin', '*');
}

/**
 * How a site request refuses.
 *
 * On a site's own hostname the forge's error page is the wrong answer for the
 * same reason it is wrong for the sites host's other responses: it renders forge
 * chrome and links a stylesheet this origin does not serve, so it arrives
 * unstyled and points the visitor at a vault the site knows nothing about. A
 * repository with no site directory at all is the ordinary way to reach this,
 * so it is worth answering plainly.
 */
function sendSite404(res: Response, mode: SiteMode, message = 'Not found'): void {
  if (mode !== 'host') {
    send404(res, message);
    return;
  }
  setSiteHeaders(res, mode);
  res.status(404).type('html').send(minimalPage(404, 'Not found', esc(message)));
}

/**
 * Serve one path out of a repository's site directory.
 *
 * The site-relative path depends on the mode, because the two surfaces disagree
 * about where the site starts: under /:collection/:repo/site/ it is the
 * wildcard, and on a site's own hostname the repository is the origin root, so
 * it is the whole of req.path.
 */
export function serveSite(
  root: string,
  collection: string,
  repo: string,
  req: Request,
  res: Response,
  mode: SiteMode
): void {
  const found = findRepo(root, collection, repo);
  if (!found) {
    sendSite404(res, mode, `Repository ${collection}/${repo} not found`);
    return;
  }
  // The switch, checked before the directory: a site that is not enabled is
  // not served whatever is on disk, and the files stay where they are for the
  // day it is enabled again.
  if (!siteSettings(found.dir).enabled) {
    sendSite404(
      res,
      mode,
      `${found.collection}/${found.name} does not publish a site. A repository admin can enable one in its settings.`
    );
    return;
  }
  const dir = siteDir(root, found.collection, found.name);
  if (!dir) {
    sendSite404(
      res,
      mode,
      `No site for ${found.collection}/${found.name}. Create a ${found.name}.site directory next to the repository, with an index.html at its root.`
    );
    return;
  }
  // The real path of the site directory, which every path we serve has to
  // sit under. It is resolved once here so that a vault reached through a
  // symlinked root still compares equal.
  let dirReal: string;
  try {
    dirReal = fs.realpathSync(dir);
  } catch {
    sendSite404(res, mode);
    return;
  }
  const relative = mode === 'host' ? req.path : wildcard(req);
  const segs = relative.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..' || s.includes('\0'))) {
    sendSite404(res, mode);
    return;
  }
  // Site content is written by whatever published it, which may be a
  // workflow unpacking a tar, so it can contain symlinks. Refusing `..`
  // segments stops a traversal spelled in the URL but not a link on disk
  // pointing at /etc/passwd, at the vault's own files, or into another
  // repository's site, which has a different owner. Every path we are
  // about to read is therefore resolved and required to land strictly
  // under dirReal; containedIn refuses the directory itself as well as
  // anything outside it, so only files below the site root are servable.
  //
  // Resolving and then opening is two syscalls, so a link swapped in
  // between them would still be followed. Closing that window means
  // holding an open handle and checking what we hold, which is more
  // machinery than this is worth; the interesting case is content that
  // was already on disk when the request arrived.
  const statInside = (p: string): fs.Stats | null => {
    if (!containedIn(dirReal, p)) return null;
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  };
  const requested = path.join(dir, ...segs);
  // The site root is the directory itself, which statInside refuses; it is
  // still a directory request, and resolves to the index.html below it.
  const isDir = segs.length === 0 || statInside(requested)?.isDirectory() === true;
  let target = requested;
  if (isDir) {
    if (!req.path.endsWith('/')) {
      res.redirect(`${req.path}/`);
      return;
    }
    target = path.join(requested, 'index.html');
  }
  // A refused path answers exactly as a missing one does, so a prober
  // learns nothing about what is really there from the difference.
  const stat = statInside(target);
  if (!stat || !stat.isFile()) {
    const notFound = path.join(dir, '404.html');
    const notFoundStat = statInside(notFound);
    if (notFoundStat && notFoundStat.isFile()) {
      setSiteHeaders(res, mode);
      res.status(404).sendFile(notFound);
    } else {
      sendSite404(res, mode, 'Page not found in this site');
    }
    return;
  }
  setSiteHeaders(res, mode);
  res.sendFile(target);
}


// ---- serving a site from its own hostname ----

/**
 * A self-contained page, for the responses a sites hostname gives that are not
 * site content. views.errorPage is wrong here: it renders forge chrome and links
 * a stylesheet that is not reachable on this hostname, so it would arrive
 * unstyled and mention a vault this origin knows nothing about.
 */
function minimalPage(status: number, title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} ${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem}</style>
</head><body><h1>${status} ${title}</h1><p>${body}</p></body></html>
`;
}

/**
 * The one hostname a repository's site answers on, or null when it is served
 * on the forge host. Precedence is custom domain, then custom label on the
 * sites host, then the derived <repo>--<collection> label; every other
 * hostname that reaches the same site 301s here, so published links converge
 * on one origin the way they do for a rename.
 */
function canonicalSiteHostname(root: string, collection: string, repo: string, repoDir: string): string | null {
  const domain = repoDomain(root, collection, repo);
  if (domain) return domain;
  const sitesHost = loadConfig(root).sites.host;
  if (!sitesHost) return null;
  const label = siteSettings(repoDir).label;
  if (label) return `${label}.${sitesHost}`;
  return siteHostFor(sitesHost, collection, repo);
}

/**
 * The site's own URL for a repository, when it has an origin of its own, or null
 * when it is served on the forge host. The scheme mirrors the request, so a
 * local http vault redirects to http and stays usable. This is where the site
 * would be served, whether or not it is enabled; what gates links and
 * redirects is the enabled flag, which the callers that need it check.
 */
export function siteHostUrl(root: string, req: Request, collection: string, repo: string): string | null {
  const found = findRepo(root, collection, repo);
  const host = found
    ? canonicalSiteHostname(root, found.collection, found.name, found.dir)
    : siteHostFor(loadConfig(root).sites.host, collection, repo);
  return host ? `${req.protocol}://${host}` : null;
}

/**
 * The origin the forge-path site routes should redirect to, or null to serve
 * in place. Unlike siteHostUrl it answers only for a site that is enabled: a
 * disabled site's forge path should 404 where it is asked rather than send the
 * visitor to another origin to be told the same thing.
 */
export function siteRedirectUrl(root: string, req: Request, collection: string, repo: string): string | null {
  const found = findRepo(root, collection, repo);
  if (!found || !siteSettings(found.dir).enabled) return null;
  const host = canonicalSiteHostname(root, found.collection, found.name, found.dir);
  return host ? `${req.protocol}://${host}` : null;
}

/**
 * The site handler for requests that arrive on a sites hostname. It must run
 * before every other route, the /assets/* and /favicon.svg routes included, or
 * the forge's stylesheet would shadow a site's own assets/style.css and the
 * favicon route would shadow a site's icon.
 *
 * Host-based gating is safe in this direction. A request arriving with a forged
 * Host reaches only the less privileged surface, and forging the forge's own
 * hostname gains an attacker nothing they would not get by visiting it, because
 * the session is resolved only there and only from a cookie the browser sends to
 * the real host.
 */
export function registerSiteHost(app: Express, root: string): void {
  app.use((req, res, next) => {
    // A custom domain is checked first because it is the one site hostname
    // that is not under the sites host: one stat-cached read of domains.json,
    // the same price the config read below already pays.
    const viaDomain = domainRepoFor(root, req.hostname);
    const sitesHost = loadConfig(root).sites.host;
    if (!viaDomain && !(sitesHost && isUnderSitesHost(sitesHost, req.hostname))) return next();
    // Sites are files. Nothing on these hostnames writes anything, so nothing
    // needs a method that would.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).set('Allow', 'GET, HEAD').type('html').send(
        minimalPage(405, 'Method not allowed', 'This hostname serves static files, so it answers only GET and HEAD.')
      );
      return;
    }
    // What the hostname names: the mapped repository for a custom domain, and
    // under the sites host either a derived <repo>--<collection> label or a
    // custom label some repository claimed. The two label kinds cannot
    // collide, since a derived label always contains `--` and a custom one
    // never may.
    let named = viaDomain;
    if (!named) {
      const label = siteHostLabel(sitesHost, req.hostname);
      if (label !== null) {
        named = label.includes('--') ? parseSiteHost(sitesHost, req.hostname) : findRepoBySiteLabel(root, label);
      }
    }
    if (!named) {
      // A request to the bare sites host, to a deeper name under it, or to a
      // label nothing answers to gets a minimal 404 rather than falling
      // through to the forge, so the forge is reachable only on its own
      // hostname.
      setSiteHeaders(res, 'sandbox');
      res.status(404).type('html').send(
        minimalPage(404, 'No site here', 'This hostname does not name a repository site in this vault.')
      );
      return;
    }
    const redirect = (host: string) => {
      res
        .status(301)
        .set('Cache-Control', 'no-store')
        .set('Location', `${req.protocol}://${host}${req.originalUrl}`)
        .end();
    };
    const found = findRepo(root, named.collection, named.repo);
    if (!found) {
      // A site has a hostname of its own, built from the repository's name, so
      // a rename moves the site to a different hostname and every published
      // link to it stops resolving to anything. The redirect the forge host
      // does for paths is done here for hostnames, on the same terms: only
      // when no repository answers to the name in this one.
      const moved = resolveRepoRedirect(root, named.collection, named.repo);
      const movedRepo = moved && findRepo(root, moved.collection, moved.repo);
      const host = movedRepo && canonicalSiteHostname(root, movedRepo.collection, movedRepo.name, movedRepo.dir);
      if (host && host !== normalizeHostname(req.hostname)) {
        redirect(host);
        return;
      }
    } else {
      // A repository with a custom domain or a custom label still answers on
      // its other hostnames, by sending the visitor to the one it prefers, the
      // way a renamed repository's old hostname does. no-store for the same
      // reason: which hostname is canonical is a setting, and a cached 301
      // would outlive changing it.
      const canonical = canonicalSiteHostname(root, found.collection, found.name, found.dir);
      if (canonical && canonical !== normalizeHostname(req.hostname)) {
        redirect(canonical);
        return;
      }
    }
    serveSite(root, named.collection, named.repo, req, res, 'host');
  });
}
