import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';
import { fileCache } from './filecache';
import { collectionDir, repoPath } from './layout';
import { listCollections, listRepoDirs } from './scan';
import { AuthResult, globMatch } from './vault';

// The permission model, GitHub-shaped: roles on repositories, owners on
// collections, and one site-admin bit on a user, instead of the earlier glob
// scopes. Who may do what is decided here and nowhere else; the web, the JSON
// API, and git each ask these functions and word their own refusals.
//
// The pieces:
//
//  - A user implicitly owns the collection named exactly after them, the way a
//    GitHub account owns its own namespace. Nothing records this; it follows
//    from the name.
//  - A collection may also list explicit owners, in
//    collections/<name>/collection.json. Owners hold the admin role on every
//    repository in the collection, may create repositories in it, and manage
//    the collection itself. The file sits beside repos/, so it moves with the
//    collection when the collection is renamed.
//  - A repository may list collaborators, each with a role, in
//    <repo>.git/mochi.json, beside git's own config. The same file carries
//    the private flag. A repository with no such file is public with no
//    collaborators, which is what every repository was before this existed.
//  - A site admin (the `siteAdmin` flag in vault.json) holds the admin role
//    everywhere and manages users, runners, and the vault's settings.
//
// Roles order as read < write < admin. Every repository question reduces to
// repoRole, which answers with the strongest role the caller holds there, or
// null for no access at all: null is what a private repository looks like to
// someone who cannot see it, and the surfaces answer 404 rather than 403 so a
// private name is indistinguishable from an absent one.
//
// A token minted with a scope (globs over collection/repo) narrows what its
// holder may reach, as it always has: outside its globs the token grants
// nothing beyond what an anonymous visitor gets, and inside them it caps at
// write, so a restricted token can never administer anything. Both rules
// predate roles; they are kept because a narrowed token is how a script or a
// CI job is given one repository and nothing else.

export type Role = 'read' | 'write' | 'admin';

const RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

export function atLeast(role: Role | null, min: Role): boolean {
  return role !== null && RANK[role] >= RANK[min];
}

/** The strongest of two, where null is weakest of all. */
function stronger(a: Role | null, b: Role | null): Role | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

function isRole(v: unknown): v is Role {
  return v === 'read' || v === 'write' || v === 'admin';
}

// ---- per-repository state: <repo>.git/mochi.json ----

export interface RepoAccess {
  private: boolean;
  collaborators: Record<string, Role>;
}

export const REPO_ACCESS_FILE = 'mochi.json';

function normalizeRepoAccess(parsed: unknown): RepoAccess {
  const out: RepoAccess = { private: false, collaborators: {} };
  if (typeof parsed !== 'object' || parsed === null) return out;
  const rec = parsed as Record<string, unknown>;
  if (rec.private === true) out.private = true;
  if (typeof rec.collaborators === 'object' && rec.collaborators !== null) {
    for (const [user, role] of Object.entries(rec.collaborators as Record<string, unknown>)) {
      if (isRole(role)) out.collaborators[user] = role;
    }
  }
  return out;
}

const accessCache = fileCache<RepoAccess>({
  read: (file) => {
    try {
      return normalizeRepoAccess(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // An unreadable file grants nothing it cannot prove: the repository is
      // treated as private with no collaborators, so a corrupted access file
      // fails closed rather than publishing what it was protecting.
      return { private: true, collaborators: {} };
    }
  },
  missing: () => ({ private: false, collaborators: {} }),
});

/** The access state of the repository whose bare directory this is. */
export function repoAccess(repoDir: string): RepoAccess {
  return accessCache.get(path.join(repoDir, REPO_ACCESS_FILE));
}

export function repoIsPrivate(repoDir: string): boolean {
  return repoAccess(repoDir).private;
}

/**
 * Read-modify-write on a repository's access file, under a lock, the same
 * arrangement vault.json edits use. The cache is invalidated explicitly
 * because a write landing within the mtime granularity would otherwise be
 * invisible to it.
 */
function editRepoAccess(repoDir: string, fn: (access: RepoAccess) => void): RepoAccess {
  const file = path.join(repoDir, REPO_ACCESS_FILE);
  return withFileLock(`${file}.lock`, () => {
    let access: RepoAccess = { private: false, collaborators: {} };
    if (fs.existsSync(file)) {
      access = normalizeRepoAccess(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    fn(access);
    writeFileAtomic(file, JSON.stringify(access, null, 2) + '\n');
    accessCache.invalidate(file);
    return access;
  });
}

export function setRepoPrivate(repoDir: string, priv: boolean): RepoAccess {
  return editRepoAccess(repoDir, (a) => {
    a.private = priv;
  });
}

export function setCollaborator(repoDir: string, username: string, role: Role): RepoAccess {
  return editRepoAccess(repoDir, (a) => {
    a.collaborators[username] = role;
  });
}

export function removeCollaborator(repoDir: string, username: string): RepoAccess {
  return editRepoAccess(repoDir, (a) => {
    delete a.collaborators[username];
  });
}

// ---- per-collection state: collections/<name>/collection.json ----

export const COLLECTION_FILE = 'collection.json';

function collectionFilePath(root: string, collection: string): string {
  return path.join(collectionDir(root, collection), COLLECTION_FILE);
}

function normalizeOwners(parsed: unknown): string[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const owners = (parsed as Record<string, unknown>).owners;
  if (!Array.isArray(owners)) return [];
  return owners.filter((o): o is string => typeof o === 'string');
}

const ownersCache = fileCache<string[]>({
  read: (file) => {
    try {
      return normalizeOwners(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  },
  missing: () => [],
});

/** The explicit owners of a collection. The implicit one is not listed here. */
export function collectionOwners(root: string, collection: string): string[] {
  return ownersCache.get(collectionFilePath(root, collection));
}

/** Owner by the explicit list or by bearing the collection's own name. */
export function isCollectionOwner(root: string, collection: string, username: string): boolean {
  return username === collection || collectionOwners(root, collection).includes(username);
}

function editOwners(root: string, collection: string, fn: (owners: string[]) => string[]): string[] {
  const file = collectionFilePath(root, collection);
  // The collection directory exists whenever a collection does; a caller
  // adding an owner to a collection that is yet to exist creates it. Before
  // the lock, because the lock file lives in the same directory.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    let owners: string[] = [];
    if (fs.existsSync(file)) {
      owners = normalizeOwners(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    owners = fn(owners);
    writeFileAtomic(file, JSON.stringify({ owners }, null, 2) + '\n');
    ownersCache.invalidate(file);
    return owners;
  });
}

export function addCollectionOwner(root: string, collection: string, username: string): string[] {
  return editOwners(root, collection, (owners) => (owners.includes(username) ? owners : [...owners, username]));
}

export function removeCollectionOwner(root: string, collection: string, username: string): string[] {
  return editOwners(root, collection, (owners) => owners.filter((o) => o !== username));
}

// ---- the decisions ----

/** The repository a permission question is about: what GitRepo already carries. */
export interface RepoRef {
  collection: string;
  name: string;
  dir: string;
}

function tokenCovers(auth: AuthResult, target: string): boolean {
  return auth.token.scope === undefined || auth.token.scope.some((g) => globMatch(g, target));
}

export function tokenIsScoped(auth: AuthResult): boolean {
  return auth.token.scope !== undefined;
}

/** Site admin, acting through a token that has not been narrowed. */
export function isSiteAdmin(auth: AuthResult | null): boolean {
  return auth !== null && auth.user.siteAdmin === true && !tokenIsScoped(auth);
}

/**
 * The strongest role the caller holds on this repository, or null for none.
 * null on a private repository is "you cannot see it", and the surfaces
 * answer it with the same 404 an absent repository gets.
 */
export function repoRole(root: string, auth: AuthResult | null, repo: RepoRef): Role | null {
  const access = repoAccess(repo.dir);
  const anonymous: Role | null = access.private ? null : 'read';
  if (!auth) return anonymous;
  let role: Role | null =
    auth.user.siteAdmin === true || isCollectionOwner(root, repo.collection, auth.username)
      ? 'admin'
      : stronger(anonymous, access.collaborators[auth.username] ?? null);
  if (tokenIsScoped(auth)) {
    if (!tokenCovers(auth, `${repo.collection}/${repo.name}`)) return anonymous;
    if (role === 'admin') role = 'write';
  }
  return role;
}

export function canReadRepo(root: string, auth: AuthResult | null, repo: RepoRef): boolean {
  return atLeast(repoRole(root, auth, repo), 'read');
}

export function canWriteRepo(root: string, auth: AuthResult | null, repo: RepoRef): boolean {
  return atLeast(repoRole(root, auth, repo), 'write');
}

export function canAdminRepo(root: string, auth: AuthResult | null, repo: RepoRef): boolean {
  return atLeast(repoRole(root, auth, repo), 'admin');
}

/**
 * Whether a user may bring the repository collection/name into being, which
 * push-to-create, the new-repository form, forks, and repository moves all
 * ask. Owners create in their collections; site admins anywhere. A narrowed
 * token must additionally cover the name being created, as it always had to.
 */
export function canCreateRepo(root: string, auth: AuthResult, collection: string, name: string): boolean {
  if (!tokenCovers(auth, `${collection}/${name}`)) return false;
  return auth.user.siteAdmin === true || isCollectionOwner(root, collection, auth.username);
}

/**
 * The same question with no repository name yet: whether the user could
 * create anything at all in the collection. The import page asks this before
 * writing a push command it knows would be refused.
 */
export function canCreateSomeRepo(root: string, auth: AuthResult, collection: string): boolean {
  if (!(auth.user.siteAdmin === true || isCollectionOwner(root, collection, auth.username))) return false;
  if (auth.token.scope === undefined) return true;
  const collectionOf = (glob: string) => (glob.includes('/') ? glob.slice(0, glob.indexOf('/')) : glob);
  return auth.token.scope.some((g) => globMatch(collectionOf(g), collection));
}

/**
 * Whether a user may create the collection named. A user's own namespace is
 * theirs the way a GitHub account's is; every other name takes a site admin.
 * The empty-collection form and repository moves into a fresh collection ask
 * this; push-to-create asks canCreateRepo, which folds the same rule in
 * through ownership.
 */
export function canCreateCollection(_root: string, auth: AuthResult, collection: string): boolean {
  if (auth.user.siteAdmin === true && !tokenIsScoped(auth)) return true;
  if (auth.username !== collection) return false;
  // A narrowed token may create its holder's namespace only if some glob's
  // collection part reaches into it.
  if (auth.token.scope === undefined) return true;
  const collectionOf = (glob: string) => (glob.includes('/') ? glob.slice(0, glob.indexOf('/')) : glob);
  return auth.token.scope.some((g) => globMatch(collectionOf(g), collection));
}

/**
 * Whether a user may administer the collection as a whole: its settings, its
 * owners, its name. Owners and site admins may; a narrowed token may not
 * administer anything, as before.
 */
export function canAdminCollection(root: string, auth: AuthResult, collection: string): boolean {
  if (tokenIsScoped(auth)) return false;
  return auth.user.siteAdmin === true || isCollectionOwner(root, collection, auth.username);
}

// The composite rules below are each asked by the web interface and by the
// JSON API. They live here, once, so the two surfaces cannot drift; the
// blockers return the missing ability as a phrase rather than answering
// false, so each surface words its own refusal around the same rule.

/**
 * The ability a repository rename or move is missing, or null when none is.
 * Renaming in place is the repository's own business, so the admin role there
 * decides it; moving to another collection is also a creation over there, so
 * that half asks canCreateRepo, exactly as a transfer does on GitHub.
 */
export function repoRenameBlocker(
  root: string,
  auth: AuthResult,
  repo: RepoRef,
  toCollection: string,
  toName: string
): string | null {
  if (!canAdminRepo(root, auth, repo)) return `the admin role on ${repo.collection}/${repo.name}`;
  if (toCollection !== repo.collection && !canCreateRepo(root, auth, toCollection, toName)) {
    return `permission to create repositories in ${toCollection}`;
  }
  return null;
}

/**
 * The ability a collection rename is missing, or null when none is. Owners
 * rename their collection to any free name, and the owners file moves with
 * it; whether the destination name is free is the operation's own check, not
 * a permission.
 */
export function collectionMoveBlocker(root: string, auth: AuthResult, collection: string): string | null {
  if (!canAdminCollection(root, auth, collection)) return `ownership of ${collection}`;
  return null;
}

/**
 * Remove every grant a username holds, across the vault: its entries in
 * owners lists and its collaborator roles. Called when the user is deleted,
 * because a grant is keyed by name alone: left behind, it would belong to
 * whoever is given the name next, silently. The user's implicit namespace
 * needs no sweeping, since a future user of the same name is meant to own
 * the collection named after them.
 */
export function removeUserGrants(root: string, username: string): void {
  for (const { name: collection } of listCollections(root)) {
    if (collectionOwners(root, collection).includes(username)) {
      removeCollectionOwner(root, collection, username);
    }
    for (const dirName of listRepoDirs(root, collection)) {
      const dir = repoPath(root, collection, dirName);
      if (repoAccess(dir).collaborators[username] !== undefined) {
        removeCollaborator(dir, username);
      }
    }
  }
}

/**
 * Whether a user may administer a runner whose allow list this is. Runners
 * are vault infrastructure, so site admins always may; short of that, a
 * runner confined to collections the caller owns is the caller's to manage.
 * An allow glob whose collection part is itself a pattern reaches
 * collections nobody in particular owns, so only a site admin covers it.
 */
export function canAdminRunnerGlobs(root: string, auth: AuthResult, globs: string[]): boolean {
  if (tokenIsScoped(auth)) return false;
  if (auth.user.siteAdmin === true) return true;
  if (globs.length === 0) return false;
  const collectionOf = (glob: string) => (glob.includes('/') ? glob.slice(0, glob.indexOf('/')) : glob);
  return globs.every((g) => {
    const c = collectionOf(g);
    return !/[*?]/.test(c) && isCollectionOwner(root, c, auth.username);
  });
}
