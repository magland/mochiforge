import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';
import { isPlausibleHostname, loadConfig } from './config';
import { fileCache } from './filecache';
import { isValidName } from './scan';
import { isUnderSitesHost, normalizeHostname } from './siteshost';

// Custom domains for repository sites, in <vault>/domains.json beside
// config.json: a map from a hostname the operator points at the vault to the
// `<collection>/<repo>` whose site answers there.
//
// Vault state rather than repository state, deliberately. The server decides
// per request whether a Host header names a site, so the answer has to come
// from one stat-cached file the way config.json does, not from a scan of every
// repository. It also matches who may write it: attaching a hostname is the
// operator's act, since the operator is who points DNS at the vault, covers
// the name with a certificate, and answers for what the server serves under
// it. A repository admin enables the site and may pick a label on the sites
// host; a custom domain takes a site admin, through the API or the CLI, and
// the file is hand-editable like everything else in a vault.
//
// One domain maps to one repository, and each repository holds at most one
// domain: setRepoDomain replaces whatever the repository had. A domain equal
// to the sites host, or under it, is refused, since those names already have a
// meaning; nothing can check the forge's own hostname, which the server never
// knows, so mapping that is the one mistake this cannot catch and the
// documentation warns about.

export const DOMAINS_FILE = 'domains.json';

export function domainsFilePath(root: string): string {
  return path.join(root, DOMAINS_FILE);
}

function normalize(parsed: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof parsed !== 'object' || parsed === null) return out;
  const domains = (parsed as Record<string, unknown>).domains;
  if (typeof domains !== 'object' || domains === null) return out;
  for (const [rawHost, target] of Object.entries(domains as Record<string, unknown>)) {
    const host = normalizeHostname(rawHost);
    if (!isPlausibleHostname(host) || typeof target !== 'string') continue;
    const slash = target.indexOf('/');
    if (slash <= 0) continue;
    const collection = target.slice(0, slash);
    const repo = target.slice(slash + 1);
    if (!isValidName(collection) || !isValidName(repo)) continue;
    out[host] = `${collection}/${repo}`;
  }
  return out;
}

const EMPTY: Record<string, string> = {};

const cache = fileCache<Record<string, string>>({
  read: (file) => {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      // A file that cannot be read maps nothing: the custom domains stop
      // answering rather than answering wrongly, and the forge is unaffected.
      console.error(`domains.json could not be read: ${e instanceof Error ? e.message : e}`);
      return EMPTY;
    }
  },
  missing: () => EMPTY,
});

/** Every custom domain, as hostname -> `<collection>/<repo>`. */
export function loadDomains(root: string): Record<string, string> {
  return cache.get(domainsFilePath(root));
}

/** The repository whose custom domain this hostname is, or null. */
export function domainRepoFor(root: string, hostname: string): { collection: string; repo: string } | null {
  const target = loadDomains(root)[normalizeHostname(hostname)];
  if (target === undefined) return null;
  const slash = target.indexOf('/');
  return { collection: target.slice(0, slash), repo: target.slice(slash + 1) };
}

/** The custom domain a repository holds, or null. */
export function repoDomain(root: string, collection: string, repo: string): string | null {
  const full = `${collection}/${repo}`;
  for (const [host, target] of Object.entries(loadDomains(root))) {
    if (target === full) return host;
  }
  return null;
}

/**
 * Whether a request's hostname is a site rather than the forge: under the
 * sites host, or a custom domain. This is the question the session, the rate
 * exemptions, and the egress exemptions each ask, so it is one function; on a
 * hostname it answers true for, no session is resolved and no path is exempt
 * from any limit, because every path there belongs to the site being served.
 */
export function isSiteRequest(root: string, hostname: string): boolean {
  if (isUnderSitesHost(loadConfig(root).sites.host, hostname)) return true;
  return loadDomains(root)[normalizeHostname(hostname)] !== undefined;
}

function write(root: string, domains: Record<string, string>): void {
  const file = domainsFilePath(root);
  if (Object.keys(domains).length === 0) {
    // Nothing mapped, so nothing on disk, the same way redirects.json goes.
    fs.rmSync(file, { force: true });
  } else {
    writeFileAtomic(file, JSON.stringify({ domains }, null, 2) + '\n');
  }
  cache.invalidate(file);
}

function edit(root: string, fn: (domains: Record<string, string>) => void): void {
  const file = domainsFilePath(root);
  withFileLock(`${file}.lock`, () => {
    cache.invalidate(file);
    const domains = { ...loadDomains(root) };
    fn(domains);
    write(root, domains);
  });
}

/**
 * Attach a domain to a repository, replacing any domain the repository already
 * held. Returns the problem, or null on success; the kind tells a surface
 * whether the caller's value was wrong or merely taken, so each words its own
 * refusal with the right status.
 */
export function setRepoDomain(
  root: string,
  collection: string,
  repo: string,
  domain: string
): { kind: 'invalid' | 'conflict'; message: string } | null {
  const host = normalizeHostname(domain);
  if (!isPlausibleHostname(host)) {
    return { kind: 'invalid', message: 'a domain is a hostname of at least two labels, like docs.example.org' };
  }
  const sitesHost = loadConfig(root).sites.host;
  if (sitesHost && (host === sitesHost || host.endsWith(`.${sitesHost}`))) {
    return {
      kind: 'invalid',
      message: `a name under the sites host ${sitesHost} already has a meaning; use the repository's site label instead`,
    };
  }
  const full = `${collection}/${repo}`;
  let conflict: string | null = null;
  edit(root, (domains) => {
    const holder = domains[host];
    if (holder !== undefined && holder !== full) {
      conflict = holder;
      return;
    }
    for (const [h, target] of Object.entries(domains)) {
      if (target === full) delete domains[h];
    }
    domains[host] = full;
  });
  return conflict ? { kind: 'conflict', message: `${host} already serves the site of ${conflict}` } : null;
}

/** Detach whatever domain a repository holds; holding none is fine. */
export function clearRepoDomain(root: string, collection: string, repo: string): void {
  const full = `${collection}/${repo}`;
  if (repoDomain(root, collection, repo) === null) return;
  edit(root, (domains) => {
    for (const [host, target] of Object.entries(domains)) {
      if (target === full) delete domains[host];
    }
  });
}

/** A repository moved; its domain, if any, follows it. Called by renameRepo. */
export function moveRepoDomains(root: string, collection: string, repo: string, toCollection: string, toName: string): void {
  const from = `${collection}/${repo}`;
  if (repoDomain(root, collection, repo) === null) return;
  edit(root, (domains) => {
    for (const [host, target] of Object.entries(domains)) {
      if (target === from) domains[host] = `${toCollection}/${toName}`;
    }
  });
}

/** A collection moved; every domain into it follows. Called by renameCollection. */
export function moveCollectionDomains(root: string, collection: string, toName: string): void {
  const prefix = `${collection}/`;
  const map = loadDomains(root);
  if (!Object.values(map).some((t) => t.startsWith(prefix))) return;
  edit(root, (domains) => {
    for (const [host, target] of Object.entries(domains)) {
      if (target.startsWith(prefix)) domains[host] = `${toName}/${target.slice(prefix.length)}`;
    }
  });
}

/**
 * A repository or collection is gone; its domains go with it, so a repository
 * created later under the name does not inherit a hostname somebody attached
 * to what was deleted. Called by deleteRepo and deleteCollection.
 */
export function dropRepoDomains(root: string, collection: string, repo: string): void {
  clearRepoDomain(root, collection, repo);
}

export function dropCollectionDomains(root: string, collection: string): void {
  const prefix = `${collection}/`;
  const map = loadDomains(root);
  if (!Object.values(map).some((t) => t.startsWith(prefix))) return;
  edit(root, (domains) => {
    for (const [host, target] of Object.entries(domains)) {
      if (target.startsWith(prefix)) delete domains[host];
    }
  });
}
