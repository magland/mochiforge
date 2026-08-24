import * as fs from 'fs';
import * as path from 'path';
import { GitRepo } from './git';
import { collectionsDir, repoPath, reposDir } from './layout';
import { Upstream, parseUpstream } from './source';

// Names the UI owns as top-level path segments. None of these may ever be a
// collection or repo name, since a collection is reached at /<collection> and
// a repository at /<collection>/<repo>. The vault's own files are not among
// them: they sit beside `collections/` rather than in it, so no file of the
// vault's can collide with a name a user chose.
const RESERVED_NAMES = new Set([
  'about',
  'api',
  'assets',
  'favicon.ico',
  'favicon.svg',
  'login',
  'logout',
  'new',
  'import',
  'admin',
  'settings',
  'topics',
]);

export function isValidName(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return false;
  return /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

/**
 * Whether a name is dot-prefixed. A single leading dot is allowed so that a
 * repository can carry a name the interface reads rather than a name a project
 * chose: `.mochi` holds a collection's profile README (see
 * src/profile.ts), and the shape is left open for whatever else the forge
 * later wants to read out of a collection.
 *
 * Only a repository may carry such a name. A collection or a user named with a
 * leading dot would be a hidden directory in the vault and a hidden address in
 * the interface, with nothing gained, so both are refused where they are
 * created. Reading stays permissive: isValidName above accepts the dot for
 * every kind of name, since a route that is asked for one only has to resolve
 * it, and a vault that somehow holds one should still serve what it holds.
 */
export function isDotName(name: string): boolean {
  return name.startsWith('.');
}

/**
 * A username. A name being looked up is checked with isValidName, which
 * accepts a leading dot; this is the stricter rule applied where a user is
 * created, since only a repository may carry one.
 */
export function isValidUserName(name: string): boolean {
  return isValidName(name) && !isDotName(name) && name.length <= MAX_NAME_LENGTH;
}

/**
 * The longest name a collection, repository, or user may be created under.
 * Far below any filesystem limit on purpose: the interface has to render
 * these, and the on-disk form carries suffixes (`<name>.git`, `<name>.issues`)
 * that a name near the 255-byte filename limit would push over it. Enforced
 * only where a name comes into being; reading stays permissive, so a vault
 * that somehow holds a longer one still serves it.
 */
export const MAX_NAME_LENGTH = 100;

/**
 * The existing collection whose name matches `name` apart from letter case, or
 * null when none does (an exact match does not count). Creation refuses such a
 * near-duplicate: two collections telling apart only by case are confusing in
 * every listing and cannot coexist on a case-insensitive filesystem, which is
 * where a vault copied to macOS or Windows would find itself.
 */
export function collectionCaseClash(root: string, name: string): string | null {
  const lower = name.toLowerCase();
  for (const c of listCollections(root)) {
    if (c.name !== name && c.name.toLowerCase() === lower) return c.name;
  }
  return null;
}

/** As collectionCaseClash, for a repository name within one collection. */
export function repoCaseClash(root: string, collection: string, name: string): string | null {
  const lower = name.toLowerCase();
  for (const d of listRepoDirs(root, collection)) {
    const existing = displayName(d);
    if (existing !== name && existing.toLowerCase() === lower) return existing;
  }
  return null;
}

// The directories a repository accumulates beside its bare repository, by the
// suffix each one carries. Every feature has its own helper for the directory
// it owns (siteDir, runsDir, issuesDir, pullsDir, releasesDir), but rename and
// delete are the two places that need the whole set, and a set spelled out in
// two places is a set one of them falls behind on. The list therefore lives
// here, beside the rest of what may and may not be a name, so a sibling added
// later is added once and is refused as a new repository's name for free.
//
// LFS objects are not in the list. Without a bucket they do sit in a sibling
// <repo>.lfs, but with one they do not sit on disk at all, so the store is
// asked to move or drop them rather than having its path assumed.
export const repoSiblingSuffixes = ['.site', '.runs', '.issues', '.pulls', '.releases'];

// Suffixes a repository may not be created under. A repository named
// webapp.site would land on exactly the path the repository webapp keeps its
// site in, so without this a user with the write role could shadow another
// repository's site, or have their own issues served as that repository's.
// The list is the siblings plus two the siblings do not name: .lfs, which is
// where LFS objects sit when no bucket is configured, and .git, the ordinary
// on-disk spelling of a bare repository, since displayName would resolve a
// new webapp.git back to webapp. Compared case-insensitively, because a
// case-insensitive filesystem would collide where a case-sensitive one would
// not, and the refusal should not depend on which one is underneath.
const reservedRepoSuffixes = [...repoSiblingSuffixes, '.lfs', '.git'];

/**
 * The reserved suffix a proposed repository name ends in, or null if it ends
 * in none. Callers report the suffix, since a name is much easier to fix when
 * the refusal says which part of it is the problem. Asked only where a
 * repository comes into being: reading stays more permissive, so a repository
 * created before this check existed keeps working.
 */
export function reservedRepoSuffix(name: string): string | null {
  const lower = name.toLowerCase();
  return reservedRepoSuffixes.find((s) => lower.endsWith(s)) ?? null;
}

export function isBareRepo(dir: string): boolean {
  try {
    return (
      fs.statSync(path.join(dir, 'HEAD')).isFile() &&
      fs.statSync(path.join(dir, 'objects')).isDirectory() &&
      fs.statSync(path.join(dir, 'refs')).isDirectory()
    );
  } catch {
    return false;
  }
}

export function displayName(dirName: string): string {
  return dirName.replace(/\.git$/, '');
}

export function listRepoDirs(root: string, collection: string): string[] {
  const dir = reposDir(root, collection);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isValidName(e.name) && isBareRepo(path.join(dir, e.name)))
    .map((e) => e.name)
    .sort();
}

export function listCollections(root: string): { name: string; repoCount: number }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(collectionsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isValidName(e.name) && !isDotName(e.name))
    .map((e) => ({ name: e.name, repoCount: listRepoDirs(root, e.name).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findRepo(root: string, collection: string, repoName: string): GitRepo | null {
  if (!isValidName(collection) || !isValidName(repoName)) return null;
  const base = displayName(repoName);
  for (const cand of [base, base + '.git']) {
    const dir = repoPath(root, collection, cand);
    if (isBareRepo(dir)) return new GitRepo(dir, collection, base);
  }
  return null;
}

// A repository's static site lives in a sibling directory, `<repo>.site`.
export function siteDir(root: string, collection: string, repoName: string): string | null {
  if (!isValidName(collection) || !isValidName(repoName)) return null;
  const dir = repoPath(root, collection, `${displayName(repoName)}.site`);
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {
    // no site directory
  }
  return null;
}

/**
 * The repository this one was forked from, as `<collection>/<repo>`, or null
 * if it was not. Read out of the bare repository's own config file rather
 * than through git, since this is asked on page renders.
 */
export function forkParent(dir: string): { collection: string; repo: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'config'), 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/^\s*forkedFrom\s*=\s*(\S+)\s*$/m);
  if (!m) return null;
  const [collection, repo] = m[1].split('/');
  if (!collection || !repo || !isValidName(collection) || !isValidName(repo)) return null;
  return { collection, repo };
}

/**
 * The URL outside this vault the repository was forked from, or null. Written
 * by `mochi fork` as `mochi.upstream` and read the same way forkParent is:
 * out of the config file directly, since this too is asked on page renders.
 * A stored value that parseUpstream rejects reads as no upstream.
 */
export function upstreamOf(dir: string): Upstream | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'config'), 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/^\s*upstream\s*=\s*(\S+)\s*$/m);
  return m ? parseUpstream(m[1]) : null;
}

export function repoDescription(dir: string): string | null {
  try {
    const t = fs.readFileSync(path.join(dir, 'description'), 'utf8').trim();
    if (!t || t.startsWith('Unnamed repository')) return null;
    return t;
  } catch {
    return null;
  }
}
