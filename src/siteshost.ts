import { displayName } from './scan';

// The grammar of a per-site hostname, in both directions, so that the parser
// and the link builder cannot drift apart. A site served from
// <repo>--<collection>.<sitesHost> has an origin of its own, which is what gives
// it back the cookies, storage, and service workers that the sandbox on the
// forge host takes away.

/**
 * Whether a collection or repository name may appear in a site hostname. The
 * regex is the whole definition: lowercase letters, digits, and single interior
 * hyphens, which by construction rejects uppercase, '.', '_', a leading or
 * trailing hyphen, a doubled hyphen anywhere, and the empty string.
 */
export function isSiteLabelSafe(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/** The DNS limit on one label, which <repo>--<collection> has to fit inside. */
const MAX_LABEL = 63;

/**
 * The one normalization a hostname gets, wherever one is read. Exported because
 * the configured sites host and the request's own hostname are compared against
 * each other: if the two were normalized differently, a trailing dot or a
 * capital letter on one side would stop every site being found.
 */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * The full hostname for a repository's site, or null if it is not eligible.
 *
 * Repository and collection names are more permissive than a hostname label
 * (isValidName allows '.', '_', and uppercase), so not every repository is
 * eligible, and an ineligible one keeps being served on the forge host. Refusing
 * rather than mangling is deliberate: lowercasing `Webapp1` would collide with a
 * `webapp1` beside it, since hostnames are case-insensitive and both names are
 * legal on disk.
 */
export function siteHostFor(sitesHost: string, collection: string, repo: string): string | null {
  if (!sitesHost) return null;
  const name = displayName(repo);
  if (!isSiteLabelSafe(name) || !isSiteLabelSafe(collection)) return null;
  const label = `${name}--${collection}`;
  if (label.length > MAX_LABEL) return null;
  return `${label}.${sitesHost}`;
}

/**
 * The single label a hostname adds under the sites host, or null: null for a
 * hostname elsewhere, for the bare sites host, and for a deeper name such as
 * a.b.<sitesHost>, which is refused and is not covered by a single wildcard
 * certificate anyway. What the label means is the caller's question: one
 * containing `--` is a derived <repo>--<collection> name for parseSiteHost
 * below, and one without is a custom label a repository may have claimed.
 */
export function siteHostLabel(sitesHost: string, hostname: string): string | null {
  if (!sitesHost) return null;
  const host = normalizeHostname(hostname);
  const suffix = `.${sitesHost}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (label === '' || label.includes('.')) return null;
  return label;
}

/**
 * The collection and repository a request's hostname names, or null.
 *
 * The double hyphen is an unambiguous separator precisely because neither half
 * may contain one, so `a--b` in collection `c` cannot be confused with `a` in
 * collection `b--c`. It also means no label can begin `xn--`, which a browser
 * would read as punycode. No filesystem access happens here; the caller resolves
 * the names with findRepo as usual.
 */
export function parseSiteHost(sitesHost: string, hostname: string): { collection: string; repo: string } | null {
  const label = siteHostLabel(sitesHost, hostname);
  if (label === null) return null;
  const parts = label.split('--');
  if (parts.length !== 2) return null;
  const [repo, collection] = parts;
  if (!isSiteLabelSafe(repo) || !isSiteLabelSafe(collection)) return null;
  return { collection, repo };
}

/**
 * Whether a hostname belongs to the sites host at all, including the bare name
 * and names too deep to be a site. The forge must not answer on any of them, so
 * this is what the middleware checks before falling through.
 */
export function isUnderSitesHost(sitesHost: string, hostname: string): boolean {
  if (!sitesHost) return false;
  const host = normalizeHostname(hostname);
  return host === sitesHost || host.endsWith(`.${sitesHost}`);
}
