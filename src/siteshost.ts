import { displayName } from './scan';

// The grammar of a per-site hostname, in both directions, so that the parser
// and the link builder cannot drift apart. A site served from
// <repo>--<alias>.<sitesHost> has an origin of its own, which is what gives
// it back the cookies, storage, and service workers that the sandbox on the
// forge host takes away.
//
// The `alias` half is the collection's site alias rather than its name: a
// collection may be called something no hostname label can be, and resolving
// the two is a question about the vault's collections, which this file cannot
// see. Everything here is a pure function of the strings it is given, so the
// grammar stays testable and cheap; src/sitesettings.ts holds the half that
// reads the vault.

/**
 * Whether a collection or repository name may appear in a site hostname. The
 * regex is the whole definition: lowercase letters, digits, and single interior
 * hyphens, which by construction rejects uppercase, '.', '_', a leading or
 * trailing hyphen, a doubled hyphen anywhere, and the empty string.
 */
export function isSiteLabelSafe(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/** The DNS limit on one label, which <repo>--<alias> has to fit inside. */
export const MAX_SITE_LABEL = 63;

/**
 * Labels under the sites host that no repository may claim.
 *
 * The sites host is a name the operator will want to use for other things:
 * `www` for a landing page, `api` for something in front of the vault, the
 * mail and nameserver names a registrar's defaults create. A repository that
 * had claimed one of those would quietly own it, and taking it back would mean
 * finding the repository holding it. Reserving them is the cheap direction.
 *
 * The set applies only to the labels a repository claims for itself, not to a
 * collection's site alias: an alias appears in a hostname only after
 * `<repo>--`, where it can shadow nothing. Note that `xn--anything` needs no
 * reserving, since a claimed label may not contain a double hyphen at all.
 */
const RESERVED_SITE_LABELS = new Set([
  'admin',
  'api',
  'assets',
  'cdn',
  'forge',
  'git',
  'localhost',
  'mail',
  'ns1',
  'ns2',
  'sites',
  'smtp',
  'static',
  'vault',
  'www',
]);

/** Whether a label is one the operator keeps, so no repository may claim it. */
export function isReservedSiteLabel(label: string): boolean {
  return RESERVED_SITE_LABELS.has(label);
}

/** The reserved labels, sorted, for the settings page to name them. */
export function reservedSiteLabels(): string[] {
  return [...RESERVED_SITE_LABELS].sort();
}

/**
 * A name rewritten as a hostname label, or '' when nothing usable is left.
 *
 * Every run of characters a label may not contain becomes a single hyphen and
 * the ends are trimmed, so `Simulated_Instruments` becomes
 * `simulated-instruments`. Collapsing the runs is what keeps a double hyphen
 * out of the result, which the `<repo>--<alias>` grammar depends on.
 *
 * The rewrite is not injective: `a_b` and `a.b` both come out as `a-b`. It is
 * therefore only ever used as a fallback that is dropped when two collections
 * would land on the same label; see collectionSiteAliases in
 * src/sitesettings.ts.
 */
export function sanitizedSiteLabel(name: string): string {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return isSiteLabelSafe(label) && label.length <= MAX_SITE_LABEL ? label : '';
}

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
 * The full hostname for a repository's site under a collection's site alias, or
 * null if the pair is not eligible.
 *
 * Repository names are more permissive than a hostname label (isValidName
 * allows '.', '_', and uppercase), so not every repository is eligible, and an
 * ineligible one keeps being served on the forge host unless its admin claims a
 * label that is usable. Refusing rather than mangling is deliberate here:
 * lowercasing `Webapp1` would collide with a `webapp1` beside it, since
 * hostnames are case-insensitive and both names are legal on disk. A
 * collection's alias is where the mangling is done instead, because it can be
 * checked against every other collection first, which a repository name inside
 * one collection cannot be.
 */
export function derivedSiteHost(sitesHost: string, collectionAlias: string, repo: string): string | null {
  if (!sitesHost) return null;
  const name = displayName(repo);
  if (!isSiteLabelSafe(name) || !isSiteLabelSafe(collectionAlias)) return null;
  const label = `${name}--${collectionAlias}`;
  if (label.length > MAX_SITE_LABEL) return null;
  return `${label}.${sitesHost}`;
}

/**
 * The single label a hostname adds under the sites host, or null: null for a
 * hostname elsewhere, for the bare sites host, and for a deeper name such as
 * a.b.<sitesHost>, which is refused and is not covered by a single wildcard
 * certificate anyway. What the label means is the caller's question: one
 * containing `--` is a derived <repo>--<alias> name for parseSiteHost below,
 * and one without is a custom label a repository may have claimed.
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
 * The collection alias and repository a request's hostname names, or null.
 *
 * The double hyphen is an unambiguous separator precisely because neither half
 * may contain one, so `a--b` under alias `c` cannot be confused with `a` under
 * alias `b--c`. It also means no label can begin `xn--`, which a browser would
 * read as punycode. No filesystem access happens here: the alias is turned into
 * a collection by collectionForSiteAlias, and the repository resolved with
 * findRepo, as usual.
 */
export function parseSiteHost(
  sitesHost: string,
  hostname: string
): { collectionAlias: string; repo: string } | null {
  const label = siteHostLabel(sitesHost, hostname);
  if (label === null) return null;
  const parts = label.split('--');
  if (parts.length !== 2) return null;
  const [repo, collectionAlias] = parts;
  if (!isSiteLabelSafe(repo) || !isSiteLabelSafe(collectionAlias)) return null;
  return { collectionAlias, repo };
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
