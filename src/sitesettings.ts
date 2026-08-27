import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';
import { fileCache } from './filecache';
import { repoPath } from './layout';
import { displayName, listCollections, listRepoDirs } from './scan';
import { isSiteLabelSafe } from './siteshost';

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
//  - `label` replaces the derived `<repo>--<collection>` label on the vault's
//    sites host, for a repository that wants a shorter or different hostname.
//    Empty means the derived one. A label never contains `--`, which is what
//    keeps it from colliding with any derived label.
//
// Everything here fails closed: a site.json that cannot be read is a site that
// is not enabled, since the file exists to grant and an unreadable grant
// grants nothing.

export type SiteSource = 'copy' | 'actions';

export interface SiteSettings {
  enabled: boolean;
  source: SiteSource;
  /** Custom label on the sites host; '' means the derived <repo>--<collection>. */
  label: string;
}

export const SITE_SETTINGS_FILE = 'site.json';

/** The DNS limit on one label, the same bound the derived label lives under. */
const MAX_LABEL = 63;

/** Whether a string may be stored as a custom site label. */
export function isUsableSiteLabel(label: string): boolean {
  return isSiteLabelSafe(label) && !label.includes('--') && label.length <= MAX_LABEL;
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
 * under the sites host but is not a derived <repo>--<collection> name.
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
