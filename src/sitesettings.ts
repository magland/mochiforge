import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';
import { fileCache } from './filecache';
import { collectionDir, repoPath } from './layout';
import { displayName, isValidName, listCollections, listRepoDirs } from './scan';
import {
  MAX_SITE_LABEL,
  derivedSiteHost,
  isReservedSiteLabel,
  isSiteLabelSafe,
  parseSiteHost,
  sanitizedSiteLabel,
  siteHostLabel,
} from './siteshost';

// Per-repository site settings, in <repo>.git/site.json beside git's own
// config, the way topics and the description each have a file of their own.
// Not in mochi.json: the access file is read and written through a normalizer
// that keeps only what it knows, so a second feature stored there would be
// silently dropped by the first one's writes.
//
// The settings are the switch, not the content. The content stays where it has
// always been, in the <repo>.site sibling directory; what this file decides is
// whether that directory is served and how it may be written:
//
//  - `enabled` gates serving. A repository with no site.json, or with
//    enabled anything but true, publishes nothing: the site routes 404, the
//    Site tab does not appear, and the deploy endpoint refuses. The directory
//    itself is left alone, so disabling a site keeps its files and re-enabling
//    brings them straight back.
//  - `source` says how the site is published, the way GitHub Pages
//    distinguishes deploying from a workflow from deploying from a branch.
//    'copy' means files copied into the directory by whatever can write the
//    vault; 'actions' additionally allows a workflow's deploy-pages step to
//    publish through the runner API. Serving cannot tell how bytes landed on
//    disk, so the source gates only that endpoint.
//  - `label` replaces the derived `<repo>--<alias>` label on the vault's
//    sites host, for a repository that wants a shorter or different hostname.
//    Empty means the derived one. A label never contains `--`, which is what
//    keeps it from colliding with any derived label.
//
// Everything here fails closed: a site.json that cannot be read is a site that
// is not enabled, since the file exists to grant and an unreadable grant
// grants nothing.
//
// The second half of the file is the collection side of the same question: the
// site alias that stands in for a collection's name in a derived hostname, and
// the naming built on top of both halves.

export type SiteSource = 'copy' | 'actions';

export interface SiteSettings {
  enabled: boolean;
  source: SiteSource;
  /** Custom label on the sites host; '' means the derived <repo>--<alias>. */
  label: string;
}

export const SITE_SETTINGS_FILE = 'site.json';

/**
 * Whether a string may be stored as a custom site label: a single DNS label,
 * never with a double hyphen, and not one of the names the operator keeps. The
 * reserved check is here rather than in the grammar because it is a question
 * about who may claim a name, not about what a hostname may look like: a
 * request arriving for `www.<sites host>` is parsed as usual and then answers
 * to nothing, which is what makes the name free for the operator to point
 * elsewhere.
 */
export function isUsableSiteLabel(label: string): boolean {
  return (
    isSiteLabelSafe(label) &&
    !label.includes('--') &&
    label.length <= MAX_SITE_LABEL &&
    !isReservedSiteLabel(label)
  );
}

function defaults(): SiteSettings {
  return { enabled: false, source: 'copy', label: '' };
}

function normalizeSiteSettings(parsed: unknown): SiteSettings {
  const out = defaults();
  if (typeof parsed !== 'object' || parsed === null) return out;
  const rec = parsed as Record<string, unknown>;
  if (rec.enabled === true) out.enabled = true;
  if (rec.source === 'actions') out.source = 'actions';
  if (typeof rec.label === 'string' && isUsableSiteLabel(rec.label)) out.label = rec.label;
  return out;
}

const settingsCache = fileCache<SiteSettings>({
  read: (file) => {
    try {
      return normalizeSiteSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return defaults();
    }
  },
  missing: () => defaults(),
});

/** The site settings of the repository whose bare directory this is. */
export function siteSettings(repoDir: string): SiteSettings {
  return settingsCache.get(path.join(repoDir, SITE_SETTINGS_FILE));
}

/**
 * Read-modify-write on a repository's site settings, under a lock, the same
 * arrangement mochi.json edits use in src/perms.ts. The cache is invalidated
 * explicitly because a write landing within the mtime granularity would
 * otherwise be invisible to it.
 */
export function editSiteSettings(repoDir: string, fn: (settings: SiteSettings) => void): SiteSettings {
  const file = path.join(repoDir, SITE_SETTINGS_FILE);
  return withFileLock(`${file}.lock`, () => {
    let settings = defaults();
    if (fs.existsSync(file)) {
      try {
        settings = normalizeSiteSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        // An unreadable file is edited as the defaults it already reads as.
      }
    }
    fn(settings);
    writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n');
    settingsCache.invalidate(file);
    return settings;
  });
}

/**
 * The repository whose custom label this is, or null. A scan rather than an
 * index, like every other lookup over a vault's repositories: the answer is a
 * stat-cached read per repository, and it is only asked for a hostname that is
 * under the sites host but is not a derived <repo>--<alias> name.
 */
export function findRepoBySiteLabel(root: string, label: string): { collection: string; repo: string } | null {
  if (!isUsableSiteLabel(label)) return null;
  for (const { name: collection } of listCollections(root)) {
    for (const dirName of listRepoDirs(root, collection)) {
      if (siteSettings(repoPath(root, collection, dirName)).label === label) {
        return { collection, repo: displayName(dirName) };
      }
    }
  }
  return null;
}

/**
 * The `<collection>/<repo>` already using a label, or null when the label is
 * free. Asked where a label is being set; the repository setting it does not
 * conflict with itself. A label cannot collide with any derived label, since a
 * derived label always contains `--` and a custom one never may.
 */
export function siteLabelConflict(root: string, label: string, collection: string, repo: string): string | null {
  const holder = findRepoBySiteLabel(root, label);
  if (!holder) return null;
  if (holder.collection === collection && holder.repo === repo) return null;
  return `${holder.collection}/${holder.repo}`;
}

/**
 * Every custom label in the vault, with the repository holding it, sorted by
 * label. The same scan findRepoBySiteLabel does, kept apart from it because
 * this one answers a different question: what is already taken. Nothing on a
 * request path asks it; the vault settings page does, so that the flat
 * namespace of claimed labels can be read rather than discovered one 409 at a
 * time.
 */
export function listSiteLabels(root: string): { label: string; collection: string; repo: string }[] {
  const out: { label: string; collection: string; repo: string }[] = [];
  for (const { name: collection } of listCollections(root)) {
    for (const dirName of listRepoDirs(root, collection)) {
      const label = siteSettings(repoPath(root, collection, dirName)).label;
      if (label) out.push({ label, collection, repo: displayName(dirName) });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ---- the collection half: collections/<name>/site.json ----
//
// A derived site hostname is `<repo>--<alias>`, and the alias is not always the
// collection's name. Collection names are as permissive as repository names, so
// a collection called `simulated_instruments` has no name a hostname label may
// carry, and every repository in it would have been left with no derived
// hostname at all: the tier that exists precisely to be the guaranteed one.
// Claiming a custom label was the only way out, which put the guaranteed name
// behind a first-come namespace.
//
// So each collection has a site alias, decided in three tiers:
//
//  1. the alias stored in collections/<name>/site.json, when one is set. It is
//     checked against every other collection where it is written, so it is
//     unique by construction.
//  2. otherwise the collection's own name, when that name is already a usable
//     label. This tier can never be taken away by anything: a vault serving
//     `webapp--alice` keeps serving it whatever else is created.
//  3. otherwise the name rewritten as a label (`simulated-instruments`), and
//     only when no other collection holds that label at any tier. The rewrite
//     is not injective, so `a_b` and `a.b` would both want `a-b`; neither gets
//     it, symmetrically, rather than one silently winning. An owner breaks the
//     tie by storing an alias at tier 1.
//
// A separate file rather than a key in collection.json: that file is written
// through a normalizer that keeps only the owners it knows, so an alias stored
// there would be dropped by the next owner change. It is the same reason the
// per-repository settings above are not in mochi.json.

export const COLLECTION_SITE_FILE = 'site.json';

/** Whether a string may be stored as a collection's site alias. */
export function isUsableCollectionAlias(alias: string): boolean {
  return isSiteLabelSafe(alias) && !alias.includes('--') && alias.length <= MAX_SITE_LABEL;
}

function collectionSiteFile(root: string, collection: string): string {
  return path.join(collectionDir(root, collection), COLLECTION_SITE_FILE);
}

function normalizeCollectionSite(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) return '';
  const alias = (parsed as Record<string, unknown>).alias;
  return typeof alias === 'string' && isUsableCollectionAlias(alias) ? alias : '';
}

const aliasCache = fileCache<string>({
  read: (file) => {
    try {
      return normalizeCollectionSite(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // An unreadable file stores no alias, which leaves the collection on the
      // tiers below rather than taking its derived hostnames away.
      return '';
    }
  },
  missing: () => '',
});

/** The alias stored for a collection, or '' when it is on a lower tier. */
export function storedCollectionAlias(root: string, collection: string): string {
  return aliasCache.get(collectionSiteFile(root, collection));
}

/**
 * Store a collection's site alias, or clear it with ''. Under a lock and with
 * the cache invalidated, on the same terms as editSiteSettings above; the file
 * is removed rather than left holding an empty alias, so a collection that has
 * never had one and one that had it cleared look the same on disk. The caller
 * checks collectionAliasConflict first: this writes what it is given.
 */
export function setCollectionAlias(root: string, collection: string, alias: string): void {
  const file = collectionSiteFile(root, collection);
  withFileLock(`${file}.lock`, () => {
    if (alias === '') fs.rmSync(file, { force: true });
    else writeFileAtomic(file, JSON.stringify({ alias }, null, 2) + '\n');
    aliasCache.invalidate(file);
  });
}

export interface CollectionAlias {
  collection: string;
  /** The label standing in for the name, or null when the collection has none. */
  alias: string | null;
  /** Whether it was stored (tier 1) rather than derived from the name. */
  stored: boolean;
  /**
   * The label a tier-3 rewrite wanted but could not have, because another
   * collection holds it; '' otherwise. The settings page says so, since the
   * repair is to store an alias.
   */
  taken: string;
}

/**
 * Every collection's site alias, resolved together because the tiers are
 * decided against each other. Sorted by collection name, as listCollections
 * returns them.
 */
export function collectionSiteAliases(root: string): CollectionAlias[] {
  const rows: CollectionAlias[] = [];
  // Tiers 1 and 2 first: both are unambiguous on their own, and they are what
  // tier 3 has to give way to.
  const claimed = new Map<string, string>();
  const pending = new Map<string, string>();
  for (const { name } of listCollections(root)) {
    const stored = storedCollectionAlias(root, name);
    if (stored) {
      rows.push({ collection: name, alias: stored, stored: true, taken: '' });
      if (!claimed.has(stored)) claimed.set(stored, name);
    } else if (isSiteLabelSafe(name)) {
      rows.push({ collection: name, alias: name, stored: false, taken: '' });
      if (!claimed.has(name)) claimed.set(name, name);
    } else {
      rows.push({ collection: name, alias: null, stored: false, taken: '' });
      const wanted = sanitizedSiteLabel(name);
      if (wanted) pending.set(name, wanted);
    }
  }
  // Then tier 3, refused where the label is claimed above or wanted twice.
  const wantedTwice = new Set<string>();
  const seen = new Set<string>();
  for (const wanted of pending.values()) {
    if (seen.has(wanted)) wantedTwice.add(wanted);
    seen.add(wanted);
  }
  for (const row of rows) {
    const wanted = pending.get(row.collection);
    if (!wanted) continue;
    if (claimed.has(wanted) || wantedTwice.has(wanted)) row.taken = wanted;
    else row.alias = wanted;
  }
  return rows;
}

/**
 * One collection's site alias, or null when it has none and its repositories
 * therefore have no derived hostname.
 *
 * The two common cases answer without listing the vault's collections at all,
 * since tiers 1 and 2 are decided by the collection alone; only a name that
 * needs rewriting pays for the full resolution.
 */
export function collectionSiteAlias(root: string, collection: string): string | null {
  const stored = storedCollectionAlias(root, collection);
  if (stored) return stored;
  if (isSiteLabelSafe(collection)) return collection;
  return collectionSiteAliases(root).find((r) => r.collection === collection)?.alias ?? null;
}

/**
 * The collection a derived hostname's alias names, or null when no collection
 * answers to it. The fast path is the same shortcut collectionSiteAlias takes:
 * a collection named exactly the alias, with nothing stored, holds it at tier 2
 * and nothing can have taken it.
 */
export function collectionForSiteAlias(root: string, alias: string): string | null {
  if (!isUsableCollectionAlias(alias)) return null;
  if (isValidName(alias) && isCollectionDir(root, alias) && storedCollectionAlias(root, alias) === '') return alias;
  return collectionSiteAliases(root).find((r) => r.alias === alias)?.collection ?? null;
}

function isCollectionDir(root: string, collection: string): boolean {
  try {
    return fs.statSync(collectionDir(root, collection)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The collection already holding an alias, or null when it is free. Asked where
 * an alias is being stored; the collection storing it does not conflict with
 * itself. Every tier is checked, so storing an alias can neither shadow a
 * collection that is reached by its own name nor take a rewritten label from
 * the collection using it.
 */
export function collectionAliasConflict(root: string, alias: string, collection: string): string | null {
  const holder = collectionSiteAliases(root).find((r) => r.alias === alias && r.collection !== collection);
  return holder ? holder.collection : null;
}

/**
 * The full hostname a repository's site would be derived to, or null when the
 * pair has no derived hostname: the naming rule and the vault's collections in
 * one call, which is what every caller outside this file wants.
 */
export function siteHostFor(root: string, sitesHost: string, collection: string, repo: string): string | null {
  if (!sitesHost) return null;
  const alias = collectionSiteAlias(root, collection);
  return alias === null ? null : derivedSiteHost(sitesHost, alias, repo);
}

/**
 * The collection and repository a hostname under the sites host names, or
 * null: the same question in the other direction, and the one both request
 * paths that see such a hostname ask (serving the site, and counting its
 * bytes).
 *
 * A label with a doubled hyphen is a derived name, and one without is a label
 * some repository claimed; the two cannot collide, since a claimed label may
 * never contain the separator. The names are returned as the hostname carries
 * them, resolved to a repository that exists by the caller, as usual: an alias
 * naming no collection is read as a collection name instead, which is what
 * keeps a renamed collection's published hostnames redirecting rather than
 * answering nothing.
 */
export function findRepoBySiteHostname(
  root: string,
  sitesHost: string,
  hostname: string
): { collection: string; repo: string } | null {
  const label = siteHostLabel(sitesHost, hostname);
  if (label === null) return null;
  if (!label.includes('--')) return findRepoBySiteLabel(root, label);
  const parsed = parseSiteHost(sitesHost, hostname);
  if (!parsed) return null;
  return {
    collection: collectionForSiteAlias(root, parsed.collectionAlias) ?? parsed.collectionAlias,
    repo: parsed.repo,
  };
}
