import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from './atomic';
import {
  GitRepo,
  execGit,
  execGitStatus,
  isValidNewRefName,
  isValidNewRepoPath,
  isValidRefName,
  isValidRepoPath,
  isValidSha,
} from './git';
import type { LfsStore } from './lfsstore';
import { COLLECTION_FILE, addCollectionOwner, repoIsPrivate, setRepoPrivate } from './perms';
import { COLLECTION_SITE_FILE } from './sitesettings';
import { loadVault } from './vault';
import { looksLikePointer } from './pointer';
import { parseUpstream } from './source';
import { dropCollectionDomains, dropRepoDomains, moveCollectionDomains, moveRepoDomains } from './domains';
import { forgetCollectionRedirects, forgetRepoRedirects, recordCollectionRename, recordRepoRename } from './redirects';
import { REPOS_DIR, collectionDir, repoPath, reposDir } from './layout';
import {
  MAX_NAME_LENGTH,
  collectionCaseClash,
  displayName,
  findRepo,
  isDotName,
  isValidName,
  listRepoDirs,
  repoCaseClash,
  repoSiblingSuffixes,
  reservedRepoSuffix,
} from './scan';

// The shared write-operations layer. Every function takes explicit arguments
// and enforces no authorization: the route layer knows the actor and decides.
// The HTML handlers call these today; the JSON API can expose the same
// operations later without duplicating logic.

export type OpErrorKind = 'invalid' | 'notfound' | 'exists' | 'conflict' | 'nochange';

export class OpError extends Error {
  constructor(message: string, public kind: OpErrorKind = 'invalid') {
    super(message);
  }
}

/**
 * The HTTP status a failed operation deserves.
 *
 * Both transports were deciding this inline, and the spellings had drifted from
 * each other: several read `kind === 'exists' ? 409 : 400`, which is right about
 * a name already taken and wrong about a `conflict`, so a branch that moved
 * under an edit came back as a malformed request. Since the whole point of the
 * kind is to tell a caller whether retrying could help, that distinction is
 * worth keeping in one place.
 *
 * `nochange` is 400 here because a caller that asked for a state the vault is
 * already in has changed nothing. The JSON API answers it as a success instead,
 * since it can say `changed: false` in the body where a rendered page cannot;
 * `sendOpError` settles that case before consulting this.
 */
export function opErrorStatus(kind: OpErrorKind): number {
  switch (kind) {
    case 'notfound':
      return 404;
    case 'exists':
    case 'conflict':
      return 409;
    default:
      return 400;
  }
}

export interface CommitAuthor {
  name: string;
  email: string;
}

/**
 * The largest single file a commit made through the server may carry. Both
 * transports use it, so that what the browser refuses to edit is what the API
 * refuses to write.
 */
export const MAX_EDIT_SIZE = 1024 * 1024;

/**
 * What one upload or one multi-file commit may carry in total. Big enough for
 * the images and fixtures people add through a browser, small enough that the
 * body can be held whole while it is parsed; anything larger belongs in a push,
 * or in Git LFS.
 */
export const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

function authorEnv(author: CommitAuthor): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

function tmpFile(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(8).toString('hex')}`);
}

/**
 * Create an empty collection: a directory in the vault with no repositories in
 * it yet. Pushing to a new path creates its collection on the way (see
 * createRepo), so this exists for the other order, where a collection is made
 * first and filled afterwards, by an import or a push.
 */
export function createCollection(root: string, name: string): string {
  if (!isValidName(name) || isDotName(name)) throw new OpError('invalid collection name');
  checkNewName('collection', name);
  const dir = collectionDir(root, name);
  if (fs.existsSync(dir)) throw new OpError(`collection ${name} already exists`, 'exists');
  checkCollectionCase(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, REPOS_DIR));
  return dir;
}

/**
 * The checks every route a collection or repository name comes into being
 * through shares, beyond the character rules isValidName applies. Only asked
 * at creation and rename: reading stays permissive, so a vault that already
 * holds such a name keeps serving it.
 *
 * The length cap keeps the on-disk form (`<name>.git`, `<name>.issues`) well
 * clear of the 255-byte filename limit, which a longer name would otherwise
 * hit inside the filesystem and surface as a bare failure. A trailing dot is
 * refused because `name..git` cannot exist on Windows and reads like a typo
 * everywhere else.
 */
function checkNewName(kind: 'collection' | 'repository', name: string): void {
  if (name.length > MAX_NAME_LENGTH) {
    throw new OpError(`a ${kind} name may be at most ${MAX_NAME_LENGTH} characters (this one is ${name.length})`);
  }
  if (name.endsWith('.')) throw new OpError(`a ${kind} name may not end with a dot`);
}

/**
 * Refuse a name that would place a new repository on top of the directories
 * another repository keeps beside it. Creation is the only place this is
 * asked: a repository that already carries such a name goes on working.
 */
function checkNewRepoName(name: string): void {
  checkNewName('repository', name);
  const suffix = reservedRepoSuffix(name);
  if (suffix) {
    throw new OpError(
      `a repository may not be named to end in ${suffix}, which is reserved for the directories a repository keeps beside it`
    );
  }
}

/**
 * Refuse a collection or repository name that matches an existing one apart
 * from letter case. Two names telling apart only by case are confusing side by
 * side in every listing, and a vault holding both would not survive a copy to
 * a case-insensitive filesystem (macOS, Windows) or backup target.
 * `allowSelf`, on a rename, is the name being moved away from, so a rename
 * that only changes case is not refused as a collision with itself.
 */
function checkCollectionCase(root: string, name: string, allowSelf?: string): void {
  const clash = collectionCaseClash(root, name);
  if (clash && clash !== allowSelf) {
    throw new OpError(`collection ${clash} already exists; names may not differ only in letter case`, 'exists');
  }
}

function checkRepoCase(root: string, collection: string, name: string, allowSelf?: string): void {
  const clash = repoCaseClash(root, collection, name);
  if (clash && clash !== allowSelf) {
    throw new OpError(
      `${collection}/${clash} already exists; names may not differ only in letter case`,
      'exists'
    );
  }
}

/**
 * Refuse a dot-prefixed collection. A repository's collection is created on
 * the way when it does not exist, here and in fork and move alike, so the
 * three of them are where a collection can come into being under a name
 * nobody typed into the new-collection form. Only a repository may carry a
 * leading dot; see isDotName in src/scan.ts.
 */
function checkNewCollectionName(collection: string): void {
  if (isDotName(collection)) throw new OpError('a collection name may not begin with a dot');
}

export async function createRepo(
  root: string,
  collection: string,
  name: string,
  opts: { private?: boolean } = {}
): Promise<GitRepo> {
  if (!isValidName(collection) || !isValidName(name)) throw new OpError('invalid collection or repository name');
  checkNewCollectionName(collection);
  checkNewName('collection', collection);
  checkNewRepoName(name);
  if (findRepo(root, collection, name)) throw new OpError(`${collection}/${name} already exists`, 'exists');
  // The case check on the collection only matters when this create would bring
  // the collection into being: a collection that already exists under exactly
  // this name is simply being added to, whatever else the vault holds.
  if (!fs.existsSync(collectionDir(root, collection))) checkCollectionCase(root, collection);
  checkRepoCase(root, collection, name);
  fs.mkdirSync(reposDir(root, collection), { recursive: true });
  const dir = repoPath(root, collection, `${name}.git`);
  await execGit(root, ['init', '--bare', '--initial-branch=main', dir]);
  // Deletes are refused on push and force pushes are not, which is GitHub's
  // arrangement for a branch nothing protects: rewriting a branch is how a
  // history is corrected, and what it abandons is collected by the sweep in
  // src/maintenance.ts, while deleting one is done through the web or the API,
  // where it is confirmed. A vault upgraded from before this ran with
  // receive.denyNonFastForwards set; migratePushPolicy unsets it.
  await execGit(dir, ['config', 'receive.denyDeletes', 'true']);
  await execGit(dir, ['config', 'receive.maxInputSize', String(2 * 1024 * 1024 * 1024)]);
  // Written before the repository is announced anywhere, so a repository asked
  // for as private is never public for even a moment.
  if (opts.private) setRepoPrivate(dir, true);
  return new GitRepo(dir, collection, name);
}

/**
 * Fork a repository inside the vault: a bare clone of one repository into
 * another collection, with the parent recorded so both ends can say where the
 * fork came from.
 *
 * A local clone hardlinks its objects, so a fork of a large repository costs
 * almost nothing on disk until one side or the other gains new objects. The
 * `origin` remote git writes points at a filesystem path, which means nothing
 * to anyone reading the fork, so it is removed and replaced by a `mochi
 * .forkedFrom` entry naming `<collection>/<repo>`. Nothing else comes across:
 * issues, releases, runs, and the site belong to the repository that has
 * them, and a fork starts with none.
 */
export async function forkRepo(
  root: string,
  collection: string,
  name: string,
  toCollection: string,
  toName: string
): Promise<GitRepo> {
  const source = findRepo(root, collection, name);
  if (!source) throw new OpError(`repository ${collection}/${name} not found`, 'notfound');
  if (!isValidName(toCollection) || !isValidName(toName)) {
    throw new OpError('invalid collection or repository name');
  }
  checkNewCollectionName(toCollection);
  checkNewName('collection', toCollection);
  checkNewRepoName(toName);
  if (toCollection === collection && toName === name) {
    throw new OpError('a repository cannot be forked onto itself');
  }
  if (findRepo(root, toCollection, toName)) {
    throw new OpError(`${toCollection}/${toName} already exists`, 'exists');
  }
  if (!fs.existsSync(collectionDir(root, toCollection))) checkCollectionCase(root, toCollection);
  checkRepoCase(root, toCollection, toName);
  fs.mkdirSync(reposDir(root, toCollection), { recursive: true });
  const dir = repoPath(root, toCollection, `${toName}.git`);
  await execGit(root, ['clone', '--bare', source.dir, dir]);
  await execGit(dir, ['remote', 'remove', 'origin']).catch(() => undefined);
  await execGit(dir, ['config', 'mochi.forkedFrom', `${collection}/${name}`]);
  // As createRepo: deletes refused on push, force pushes allowed.
  await execGit(dir, ['config', 'receive.denyDeletes', 'true']);
  await execGit(dir, ['config', 'receive.maxInputSize', String(2 * 1024 * 1024 * 1024)]);
  const description = fs.existsSync(path.join(source.dir, 'description'))
    ? fs.readFileSync(path.join(source.dir, 'description'), 'utf8')
    : '';
  if (description.trim() !== '' && !description.startsWith('Unnamed repository')) {
    writeFileAtomic(path.join(dir, 'description'), description);
  }
  // A fork of a private repository starts private, so forking is never a way
  // to publish what its parent was protecting. Collaborators do not come
  // across: they belong to the parent, and the forker administers the fork.
  if (repoIsPrivate(source.dir)) setRepoPrivate(dir, true);
  return new GitRepo(dir, toCollection, toName);
}

async function refTip(repoDir: string, ref: string): Promise<string | null> {
  try {
    return (await execGit(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

async function entryExists(repoDir: string, commit: string, filePath: string): Promise<boolean> {
  try {
    await execGit(repoDir, ['cat-file', '-e', `${commit}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

async function entryMode(repoDir: string, commit: string, filePath: string): Promise<string> {
  const out = (await execGit(repoDir, ['ls-tree', commit, '--', filePath])).toString('utf8');
  const m = out.match(/^(\d{6}) blob /);
  if (!m) throw new OpError(`${filePath} is not a file at this commit`, 'notfound');
  return m[1];
}

/** What a single-file commit does to the path. */
export type FileAction =
  | { kind: 'create'; content: Buffer }
  // toPath renames the file in the same commit: the old path is removed and
  // the content written at the new one, so a rename is one commit and not a
  // delete followed by a create.
  | { kind: 'edit'; content: Buffer; toPath?: string }
  | { kind: 'delete' };

interface FileCommitArgs {
  branch: string;
  filePath: string;
  message: string;
  author: CommitAuthor;
  // The commit sha the actor last saw at the branch tip, or null when
  // creating the branch itself (first commit in an empty repository). Gives
  // optimistic concurrency: if the branch has moved, the update fails with a
  // 'conflict' OpError instead of clobbering.
  expectedHead: string | null;
  action: FileAction;
}

export interface UploadedFile {
  path: string;
  content: Buffer;
}

/**
 * Commit several files at once, which is what an upload is. Same index dance
 * as commitFileChange and the same optimistic guard on the branch tip; the
 * difference is only that a batch of paths goes in before the tree is
 * written, so an upload of twenty files is one commit and not twenty.
 *
 * A path that already exists is replaced and keeps its mode, so re-uploading
 * a script does not quietly drop its executable bit.
 */
export async function commitFiles(
  repoDir: string,
  args: {
    branch: string;
    files: UploadedFile[];
    message: string;
    author: CommitAuthor;
    expectedHead: string | null;
    /**
     * Paths to remove in the same commit. An upload never has any; a caller
     * changing three files as one logical edit may well be deleting a fourth,
     * and splitting that into two commits would record a state nobody chose.
     */
    removals?: string[];
  }
): Promise<string> {
  const { branch, files, message, author, expectedHead } = args;
  const removals = args.removals ?? [];
  if (!isValidRefName(branch) || branch.startsWith('-')) throw new OpError('invalid branch name');
  // A first commit is also the branch coming into being, so the name takes
  // the same rules explicit branch creation applies.
  if (expectedHead === null) checkNewRefName('branch', branch);
  if (files.length === 0 && removals.length === 0) throw new OpError('no files to commit');
  for (const file of files) {
    // The stricter write-side rule: paths only being removed stay on the
    // permissive one, so whatever the repository already holds can go.
    if (!isValidNewRepoPath(file.path) || file.path === '') throw new OpError(`invalid file path: ${file.path}`);
  }
  for (const target of removals) {
    if (!isValidRepoPath(target) || target === '') throw new OpError(`invalid file path: ${target}`);
  }
  if (removals.length && expectedHead === null) {
    throw new OpError('cannot delete a file on a branch that does not exist yet');
  }
  if (expectedHead !== null && !isValidSha(expectedHead)) throw new OpError('invalid expected commit');

  const indexFile = tmpFile('mochi-index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    let baseTree: string | null = null;
    if (expectedHead !== null) {
      baseTree = (await execGit(repoDir, ['rev-parse', `${expectedHead}^{tree}`])).toString('utf8').trim();
      await execGit(repoDir, ['read-tree', expectedHead], { env });
    } else {
      await execGit(repoDir, ['read-tree', '--empty'], { env });
    }

    for (const file of files) {
      const mode =
        expectedHead !== null && (await entryExists(repoDir, expectedHead, file.path))
          ? await entryMode(repoDir, expectedHead, file.path)
          : '100644';
      const contentFile = tmpFile('mochi-blob');
      let blobSha: string;
      try {
        fs.writeFileSync(contentFile, file.content, { mode: 0o600 });
        blobSha = (await execGit(repoDir, ['hash-object', '-w', '--', contentFile])).toString('utf8').trim();
      } finally {
        fs.rmSync(contentFile, { force: true });
      }
      await execGit(repoDir, ['update-index', '--add', '--cacheinfo', `${mode},${blobSha},${file.path}`], { env });
    }

    for (const target of removals) {
      if (!(await entryExists(repoDir, expectedHead!, target))) {
        throw new OpError(`${target} does not exist on ${branch}`, 'notfound');
      }
      // update-index --force-remove insists on a work tree; a zero-mode entry
      // fed to --index-info removes a path without one.
      await execGit(repoDir, ['update-index', '--index-info'], {
        env,
        input: `0 ${'0'.repeat(40)}\t${target}\n`,
      });
    }

    const newTree = (await execGit(repoDir, ['write-tree'], { env })).toString('utf8').trim();
    if (newTree === baseTree) throw new OpError('those files are already in the repository, unchanged', 'nochange');
    const commitArgs = ['commit-tree', newTree, '-m', message];
    if (expectedHead !== null) commitArgs.push('-p', expectedHead);
    const newCommit = (await execGit(repoDir, commitArgs, { env: authorEnv(author) })).toString('utf8').trim();
    try {
      await execGit(repoDir, ['update-ref', `refs/heads/${branch}`, newCommit, expectedHead ?? '']);
    } catch (e) {
      const tip = await refTip(repoDir, `refs/heads/${branch}`);
      if (tip !== expectedHead) {
        throw new OpError(`branch ${branch} has moved since you loaded this page`, 'conflict');
      }
      throw e;
    }
    return newCommit;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

export async function commitFileChange(repoDir: string, args: FileCommitArgs): Promise<string> {
  const { branch, filePath, message, author, expectedHead, action } = args;
  if (!isValidRefName(branch) || branch.startsWith('-')) throw new OpError('invalid branch name');
  // A first commit is also the branch coming into being; see commitFiles.
  if (expectedHead === null) checkNewRefName('branch', branch);
  // A path being created takes the stricter write-side rule; a path that is
  // only being edited in place or deleted stays on the permissive one, so a
  // file the repository already holds under an awkward name can still go.
  const pathCheck = action.kind === 'create' ? isValidNewRepoPath : isValidRepoPath;
  if (!pathCheck(filePath) || filePath === '') throw new OpError('invalid file path');
  if (expectedHead !== null && !isValidSha(expectedHead)) throw new OpError('invalid expected commit');

  const toPath = action.kind === 'edit' && action.toPath && action.toPath !== filePath ? action.toPath : null;
  if (toPath !== null && !isValidNewRepoPath(toPath)) throw new OpError('invalid file path');

  if (expectedHead !== null) {
    if (action.kind === 'create') {
      if (await entryExists(repoDir, expectedHead, filePath)) {
        throw new OpError(`${filePath} already exists on ${branch}`, 'exists');
      }
    } else if (!(await entryExists(repoDir, expectedHead, filePath))) {
      throw new OpError(`${filePath} does not exist on ${branch}`, 'notfound');
    }
    if (toPath !== null && (await entryExists(repoDir, expectedHead, toPath))) {
      throw new OpError(`${toPath} already exists on ${branch}`, 'exists');
    }
  } else if (action.kind !== 'create') {
    throw new OpError('cannot edit or delete a file on a branch that does not exist');
  }

  const indexFile = tmpFile('mochi-index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    let baseTree: string | null = null;
    if (expectedHead !== null) {
      baseTree = (await execGit(repoDir, ['rev-parse', `${expectedHead}^{tree}`])).toString('utf8').trim();
      await execGit(repoDir, ['read-tree', expectedHead], { env });
    } else {
      await execGit(repoDir, ['read-tree', '--empty'], { env });
    }

    // update-index --force-remove insists on a work tree; feeding a zero-mode
    // entry to --index-info removes a path without one.
    const removePath = async (target: string) => {
      await execGit(repoDir, ['update-index', '--index-info'], {
        env,
        input: `0 ${'0'.repeat(40)}\t${target}\n`,
      });
    };
    if (action.kind === 'delete') {
      await removePath(filePath);
    } else {
      if (toPath !== null) await removePath(filePath);
      const mode =
        action.kind === 'edit' && expectedHead !== null
          ? await entryMode(repoDir, expectedHead, filePath)
          : '100644';
      const contentFile = tmpFile('mochi-blob');
      let blobSha: string;
      try {
        fs.writeFileSync(contentFile, action.content, { mode: 0o600 });
        blobSha = (await execGit(repoDir, ['hash-object', '-w', '--', contentFile])).toString('utf8').trim();
      } finally {
        fs.rmSync(contentFile, { force: true });
      }
      await execGit(repoDir, ['update-index', '--add', '--cacheinfo', `${mode},${blobSha},${toPath ?? filePath}`], {
        env,
      });
    }

    const newTree = (await execGit(repoDir, ['write-tree'], { env })).toString('utf8').trim();
    if (newTree === baseTree) throw new OpError('no changes to commit', 'nochange');

    const commitArgs = ['commit-tree', newTree, '-m', message];
    if (expectedHead !== null) commitArgs.push('-p', expectedHead);
    const newCommit = (await execGit(repoDir, commitArgs, { env: authorEnv(author) })).toString('utf8').trim();

    try {
      await execGit(repoDir, ['update-ref', `refs/heads/${branch}`, newCommit, expectedHead ?? '']);
    } catch (e) {
      const tip = await refTip(repoDir, `refs/heads/${branch}`);
      if (tip !== expectedHead) {
        throw new OpError(`branch ${branch} has moved since you loaded this page`, 'conflict');
      }
      throw e;
    }
    return newCommit;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

/**
 * What merging a head into a base did, or why it could not.
 * `before` is the base tip the merge was made against, which the caller needs
 * to report the push to anything watching the branch.
 */
export type MergeOutcome =
  | { status: 'merged'; sha: string; before: string; fastForward: boolean }
  | { status: 'up-to-date' }
  | { status: 'conflict'; paths: string[] };

/** How a merge is recorded: both parents, or one commit on the base. */
export type MergeMethod = 'merge' | 'squash';

/** What a merge would do, without doing it. */
export type MergePreview =
  | { status: 'clean'; fastForward: boolean; base: string; head: string }
  | { status: 'up-to-date' }
  | { status: 'conflict'; paths: string[] };

/**
 * Work out what merging `head` into branch `base` would come to, in a bare
 * repository and without a work tree.
 *
 * `git merge-tree --write-tree` computes the merged tree in the object
 * database and names the paths that conflict. The tree it writes when the
 * merge is clean is not thrown away: the caller commits exactly that tree, so
 * the merge a reader was shown is the merge that happens. An unreferenced
 * tree left behind by a preview is ordinary garbage that git collects.
 */
async function planMerge(
  repoDir: string,
  base: string,
  head: string
): Promise<
  | { status: 'up-to-date' }
  | { status: 'conflict'; paths: string[] }
  | { status: 'clean'; tree: string | null; fastForward: boolean; baseSha: string; headSha: string }
> {
  if (!isValidRefName(base) || base.startsWith('-')) throw new OpError('invalid base branch');
  if (!isValidRefName(head) || head.startsWith('-')) throw new OpError('invalid head ref');
  const baseSha = await refTip(repoDir, `refs/heads/${base}`);
  if (!baseSha) throw new OpError(`branch ${base} not found`, 'notfound');
  const headSha = await refTip(repoDir, head);
  if (!headSha) throw new OpError(`ref ${head} not found`, 'notfound');

  // Nothing to merge: the head is already in the base's history.
  if ((await execGitStatus(repoDir, ['merge-base', '--is-ancestor', headSha, baseSha])).code === 0) {
    return { status: 'up-to-date' };
  }
  // The base has not moved since the head left it, so the merged tree is the
  // head's own. A merge commit is still made rather than fast-forwarding:
  // that commit is the record of the merge, and a history where a proposal
  // simply appears says nothing about why it was taken. This is what GitHub's
  // merge button does too.
  if ((await execGitStatus(repoDir, ['merge-base', '--is-ancestor', baseSha, headSha])).code === 0) {
    const tree = (await execGit(repoDir, ['rev-parse', `${headSha}^{tree}`])).toString('utf8').trim();
    return { status: 'clean', tree, fastForward: true, baseSha, headSha };
  }

  const merged = await execGitStatus(repoDir, ['merge-tree', '--write-tree', '--name-only', baseSha, headSha]);
  const lines = merged.stdout.split('\n');
  const tree = (lines[0] ?? '').trim();
  if (merged.code === 1 && isValidSha(tree)) {
    // The conflicting paths follow the tree, one per line, and a blank line
    // ends them before git's own narration of the merge.
    const paths: string[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim() === '') break;
      paths.push(line);
    }
    return { status: 'conflict', paths };
  }
  if (merged.code !== 0 || !isValidSha(tree)) {
    throw new OpError(merged.stderr.trim() || 'the merge could not be computed');
  }
  return { status: 'clean', tree, fastForward: false, baseSha, headSha };
}

/** Whether a merge would apply cleanly, without changing anything. */
export async function previewMerge(repoDir: string, base: string, head: string): Promise<MergePreview> {
  const plan = await planMerge(repoDir, base, head);
  if (plan.status === 'clean') {
    return { status: 'clean', fastForward: plan.fastForward, base: plan.baseSha, head: plan.headSha };
  }
  return plan;
}

/**
 * Merge one ref into a branch and move the branch to the result.
 *
 * The branch moves with a guarded update-ref, so a branch that moved while
 * the reader was deciding fails rather than losing the commit that moved it.
 * Conflicts are reported, never committed: resolving them needs a work tree
 * and a person, and the vault has neither.
 */
export async function mergeBranch(
  repoDir: string,
  base: string,
  head: string,
  message: string,
  author: CommitAuthor,
  method: MergeMethod = 'merge'
): Promise<MergeOutcome> {
  const plan = await planMerge(repoDir, base, head);
  if (plan.status !== 'clean') return plan;
  // A squash keeps the merged tree and drops the branch's shape: one commit
  // on the base, with the base as its only parent, which is what makes the
  // head's history disappear from the base and the head branch look unmerged
  // afterwards. A merge keeps both parents, and with them the record of where
  // the work came from.
  const parents = method === 'squash' ? ['-p', plan.baseSha] : ['-p', plan.baseSha, '-p', plan.headSha];
  const sha = (
    await execGit(repoDir, ['commit-tree', plan.tree!, ...parents, '-m', message], {
      env: authorEnv(author),
    })
  )
    .toString('utf8')
    .trim();
  await moveBranch(repoDir, base, sha, plan.baseSha);
  return { status: 'merged', sha, before: plan.baseSha, fastForward: plan.fastForward };
}

/** Move a branch, refusing if it is no longer where the caller last saw it. */
async function moveBranch(repoDir: string, branch: string, to: string, from: string): Promise<void> {
  try {
    await execGit(repoDir, ['update-ref', `refs/heads/${branch}`, to, from]);
  } catch {
    throw new OpError(`branch ${branch} has moved since this page was loaded`, 'conflict');
  }
}

/**
 * Refuse a name no new branch or tag may carry, saying which rule it broke.
 * The rules themselves live in isValidNewRefName (src/git.ts); this spells
 * each refusal out, because "invalid branch name" helps nobody whose name was
 * refused for being a pseudo-ref or for carrying a pasted refs/ prefix.
 */
function checkNewRefName(kind: 'branch' | 'tag', name: string): void {
  if (isValidNewRefName(name)) return;
  if (name === 'HEAD' || /^[A-Z_]+_HEAD$/.test(name)) {
    throw new OpError(`${name} is reserved by git; a ${kind} of that name would be ambiguous on every clone`);
  }
  if (name === 'refs' || name.startsWith('refs/')) {
    throw new OpError(`name the ${kind} without the refs/ prefix`);
  }
  if (name.length > 200) {
    throw new OpError(`a ${kind} name may be at most 200 characters (this one is ${name.length})`);
  }
  throw new OpError(`invalid ${kind} name`);
}

/**
 * Why creating `refs/<space>/<name>` failed, as an OpError a person can act
 * on. update-ref fails the same way whether the ref exists or its name
 * collides with the file/directory shape of another ref (creating `feat` when
 * `feat/sub` exists, or the reverse), so the two are told apart here rather
 * than both reported as "already exists".
 */
async function refCreateError(
  repoDir: string,
  kind: 'branch' | 'tag',
  space: string,
  name: string,
  fallback: unknown
): Promise<OpError> {
  if (await refTip(repoDir, `${space}/${name}`)) {
    return new OpError(`${kind} ${name} already exists`, 'exists');
  }
  try {
    const under = (await execGit(repoDir, ['for-each-ref', '--count=1', '--format=%(refname)', `${space}/${name}/`]))
      .toString('utf8')
      .trim();
    if (under !== '') {
      const other = under.slice(space.length + 1);
      return new OpError(
        `${kind} ${name} conflicts with existing ${kind} ${other}; a ${kind} cannot also name a prefix of another`,
        'conflict'
      );
    }
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (await refTip(repoDir, `${space}/${prefix}`)) {
        return new OpError(
          `${kind} ${name} conflicts with existing ${kind} ${prefix}; a ${kind} cannot also name a prefix of another`,
          'conflict'
        );
      }
    }
  } catch {
    // Diagnosis is best-effort; the fallback below still names the failure.
  }
  return new OpError(`could not create ${kind} ${name}: ${fallback instanceof Error ? fallback.message : fallback}`);
}

export async function createBranch(repoDir: string, name: string, fromRef: string): Promise<void> {
  checkNewRefName('branch', name);
  if (!isValidRefName(fromRef) || fromRef.startsWith('-')) throw new OpError('invalid source ref');
  await execGit(repoDir, ['check-ref-format', `refs/heads/${name}`]);
  const sha = await refTip(repoDir, fromRef);
  if (!sha) throw new OpError(`ref ${fromRef} not found`, 'notfound');
  try {
    await execGit(repoDir, ['update-ref', `refs/heads/${name}`, sha, '']);
  } catch (e) {
    throw await refCreateError(repoDir, 'branch', 'refs/heads', name, e);
  }
}

/**
 * What the object store holds, as `git count-objects` reports it: loose objects
 * and packed ones together, with their size in kilobytes.
 */
export interface ObjectStats {
  objects: number;
  kilobytes: number;
}

async function objectStats(repoDir: string): Promise<ObjectStats> {
  const out = (await execGit(repoDir, ['count-objects', '-v'])).toString('utf8');
  const field = (name: string): number => {
    const line = out.split('\n').find((l) => l.startsWith(`${name}: `));
    const value = line ? Number(line.slice(name.length + 2).trim()) : 0;
    return Number.isFinite(value) ? value : 0;
  };
  return {
    objects: field('count') + field('in-pack'),
    kilobytes: field('size') + field('size-pack'),
  };
}

/**
 * How recent an unreachable object has to be to survive an on-demand
 * collection.
 *
 * Not `now`, deliberately. A push uploads its objects before it moves the
 * branch that will make them reachable, so during those seconds its objects are
 * unreachable in exactly the way abandoned ones are, and a collection sparing
 * nothing could delete a push in flight. Five minutes is far longer than that
 * window and short enough that anything a person is asking to be rid of, which
 * is by definition something already pushed and then rewritten away, is gone.
 * The periodic sweep in src/maintenance.ts is far more generous, because it runs
 * unattended and nobody is watching it.
 */
const ON_DEMAND_PRUNE = '5.minutes.ago';

/** A collection this slow is one the caller should not be waiting on. */
const GC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Collect one repository now: drop every object no ref can reach, and repack
 * what is left.
 *
 * This is the answer to "I pushed something I should not have, rewrote it out of
 * the history, and want it gone", which the periodic sweep cannot be: that one
 * spares anything unreachable but recent, so it does not promise promptness.
 * Reflogs are expired first, since a vault configured to keep them would
 * otherwise hold a reference to exactly the commits being disowned.
 */
export async function collectRepo(repoDir: string): Promise<{ before: ObjectStats; after: ObjectStats }> {
  const before = await objectStats(repoDir);
  await execGit(repoDir, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']).catch(
    () => undefined
  );
  try {
    await execGit(repoDir, ['gc', '--quiet', `--prune=${ON_DEMAND_PRUNE}`], { timeoutMs: GC_TIMEOUT_MS });
  } catch (e) {
    // The commonest failure is another gc holding the repository's gc.pid lock,
    // which is a conflict rather than a fault: the work is already happening.
    const message = e instanceof Error ? e.message : String(e);
    if (/gc is already running|gc\.pid/i.test(message)) {
      throw new OpError('a collection is already running on this repository', 'conflict');
    }
    throw new OpError(`could not collect the repository: ${message}`);
  }
  return { before, after: await objectStats(repoDir) };
}

export async function deleteBranch(repoDir: string, name: string): Promise<void> {
  if (!isValidRefName(name) || name.startsWith('-')) throw new OpError('invalid branch name');
  // update-ref -d bypasses receive.denyDeletes, deliberately: the receive
  // config guards against accidental `push --delete`, while deletion here is
  // explicit, confirmed intent.
  await execGit(repoDir, ['update-ref', '-d', `refs/heads/${name}`]);
}

export async function createTag(repoDir: string, name: string, atRef: string): Promise<void> {
  checkNewRefName('tag', name);
  if (!isValidRefName(atRef) || atRef.startsWith('-')) throw new OpError('invalid target ref');
  await execGit(repoDir, ['check-ref-format', `refs/tags/${name}`]);
  const sha = await refTip(repoDir, atRef);
  if (!sha) throw new OpError(`ref ${atRef} not found`, 'notfound');
  try {
    await execGit(repoDir, ['update-ref', `refs/tags/${name}`, sha, '']);
  } catch (e) {
    throw await refCreateError(repoDir, 'tag', 'refs/tags', name, e);
  }
}

export async function deleteTag(repoDir: string, name: string): Promise<void> {
  if (!isValidRefName(name) || name.startsWith('-')) throw new OpError('invalid tag name');
  await execGit(repoDir, ['update-ref', '-d', `refs/tags/${name}`]);
}

export async function setDefaultBranch(repoDir: string, branch: string): Promise<void> {
  if (!isValidRefName(branch) || branch.startsWith('-')) throw new OpError('invalid branch name');
  const sha = await refTip(repoDir, `refs/heads/${branch}`);
  if (!sha) throw new OpError(`branch ${branch} not found`, 'notfound');
  await execGit(repoDir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
}

/**
 * Record (or clear, with '') the URL outside this vault the repository was
 * forked from, as `mochi.upstream`. Only the two URL shapes `mochi fork`
 * clones from are accepted, so what upstreamOf later reads back always parses.
 */
export async function setUpstream(repoDir: string, url: string): Promise<void> {
  if (url === '') {
    await execGit(repoDir, ['config', '--unset', 'mochi.upstream']).catch(() => undefined);
    return;
  }
  if (!parseUpstream(url)) throw new OpError('the upstream must be an https or ssh git URL');
  await execGit(repoDir, ['config', 'mochi.upstream', url]);
}

/**
 * The longest description a repository may carry. Descriptions are rendered on
 * the listing pages, so an unbounded one is a one-field way to swell every
 * page that names the repository; a few hundred characters is room for a
 * sentence or two, which is what the field is for.
 */
export const MAX_DESCRIPTION_LENGTH = 500;

export function setDescription(repoDir: string, text: string): void {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length > MAX_DESCRIPTION_LENGTH) {
    throw new OpError(
      `the description may be at most ${MAX_DESCRIPTION_LENGTH} characters (this one is ${line.length}); longer prose belongs in the README`
    );
  }
  writeFileAtomic(path.join(repoDir, 'description'), line === '' ? '' : line + '\n');
}

export function containedIn(rootReal: string, target: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return false;
  }
  return real.startsWith(rootReal + path.sep);
}

function siblingDir(root: string, collection: string, name: string, suffix: string): string {
  return repoPath(root, collection, `${displayName(name)}${suffix}`);
}

/**
 * The state a repository has outside its own directory, for the two
 * operations that move or remove one.
 *
 * Both parts are optional because both are optional in a vault: LFS objects
 * sit in the repository's own `.lfs` directory unless a bucket is configured,
 * and the CI engine exists only on a server that runs workflows. Neither is
 * something a caller should have to remember, which is the point of collecting
 * them here: renameRepo and deleteRepo took the store as an argument and left
 * the engine to the six call sites, so the engine was a step each new route
 * had to know to perform, and one that a rename which then failed had already
 * performed for nothing.
 *
 * The run index is named by its shape rather than by importing CiEngine, so
 * this file stays unaware of the CI layer that imports it.
 */
export interface RepoContext {
  /** Where LFS objects are kept, when they are not kept beside the repository. */
  lfs?: LfsStore | null;
  /** The live run index, which must stop dispatching for a repository before its files move. */
  runs?: { forgetRepo(collection: string, repo: string): void } | null;
}

/**
 * Rename a repository, or move it to another collection - the two are one
 * operation, since both are a directory rename.
 *
 * Everything that belongs to the repository moves with it: the bare
 * repository, its static site, its workflow runs, its issues, its pull
 * requests, its releases, and its LFS objects. Leaving any of them behind
 * would strand state that only that repository can reach, and worse, a
 * repository later created under the old name would inherit it.
 *
 * The move is a sequence of renames rather than one atomic act, which is the
 * honest limit of a filesystem-backed store. The repository itself moves
 * first: if a later sibling fails, what is left behind is a directory beside
 * the old name rather than a repository nobody can find.
 */
export async function renameRepo(
  root: string,
  collection: string,
  name: string,
  toCollection: string,
  toName: string,
  ctx: RepoContext = {}
): Promise<void> {
  const repo = findRepo(root, collection, name);
  if (!repo) throw new OpError(`repository ${collection}/${name} not found`, 'notfound');
  if (!isValidName(toCollection) || !isValidName(toName)) {
    throw new OpError('invalid collection or repository name');
  }
  checkNewCollectionName(toCollection);
  checkNewName('collection', toCollection);
  checkNewRepoName(toName);
  if (toCollection === collection && toName === name) throw new OpError('that is already its name', 'nochange');
  if (findRepo(root, toCollection, toName)) {
    throw new OpError(`${toCollection}/${toName} already exists`, 'exists');
  }
  if (!fs.existsSync(collectionDir(root, toCollection))) checkCollectionCase(root, toCollection);
  // A rename that only changes the name's case is the repository colliding
  // with itself, which is allowed; anything else that matches apart from case
  // is refused.
  checkRepoCase(root, toCollection, toName, toCollection === collection ? name : undefined);
  const rootReal = fs.realpathSync(root);
  if (!containedIn(rootReal, repo.dir)) {
    throw new OpError('repository directory is outside the vault; refusing to move it');
  }
  // The .git suffix is optional on disk and is kept as it was found, so a
  // move never changes how git-lfs derives its endpoint for this repository.
  const suffix = path.basename(repo.dir).endsWith('.git') ? '.git' : '';
  const destRepos = reposDir(root, toCollection);
  fs.mkdirSync(destRepos, { recursive: true });
  const destRepo = path.join(destRepos, `${toName}${suffix}`);
  if (fs.existsSync(destRepo)) throw new OpError(`${toCollection}/${toName} already exists`, 'exists');
  // Every check has passed, so from here the move is going to happen: the run
  // index is told to forget the old identity before the directories move out
  // from under it. After the checks rather than before, so that a rename
  // refused for a name that is taken leaves a running job's index entry alone.
  ctx.runs?.forgetRepo(collection, name);
  fs.renameSync(repo.dir, destRepo);

  // The siblings, each moved only if it is there and inside the vault.
  // containedIn resolves the path first, so a sibling that was never created
  // fails the same check as one pointing out of the vault, and is skipped.
  const move = (from: string, to: string) => {
    if (!containedIn(rootReal, from)) return;
    if (fs.existsSync(to)) {
      throw new OpError(`${path.basename(to)} already exists next to ${toCollection}/${toName}`, 'exists');
    }
    fs.renameSync(from, to);
  };
  for (const suffix of repoSiblingSuffixes) {
    move(siblingDir(root, collection, name, suffix), path.join(destRepos, `${toName}${suffix}`));
  }
  // LFS objects carry the repository in their key or their path, so the store
  // moves them itself. Unlike deletion this is not best-effort: an object left
  // behind is one a clone of the moved repository cannot fetch.
  if (ctx.lfs) await ctx.lfs.renameRepo(collection, name, toCollection, toName);
  // Last, and only once everything has arrived: the old address is remembered,
  // so a clone or a link that still names it is redirected here rather than
  // 404ing. Recorded after the moves for a reason - a redirect written first
  // and a move that then failed would point at a repository that is not there.
  // See src/redirects.ts for what the redirect does and does not survive.
  recordRepoRename(root, collection, name, toCollection, toName);
  // A custom domain maps to the repository by name, so the mapping is
  // re-pointed with the rename; the domain itself does not change, which is
  // the point of having one.
  moveRepoDomains(root, collection, name, toCollection, toName);
}

/**
 * Rename a collection.
 *
 * A collection holds everything of its own inside its directory, so unlike a
 * repository move this is a single rename and not a sequence of them: the
 * repositories, the directories each of them keeps beside it, and locally
 * stored LFS objects all sit under the directory being moved and arrive at
 * the new name together. Only objects in a bucket have to be dealt with
 * separately, since their keys name the collection rather than living in it,
 * and the store is asked to move each repository's for that reason.
 *
 * One thing a rename does not carry with it, and the interface says so before
 * it is done: token scopes in vault.json still name the old collection. The
 * old address itself is remembered, so requests for it are redirected here;
 * see src/redirects.ts.
 */
export async function renameCollection(
  root: string,
  name: string,
  toName: string,
  ctx: RepoContext = {}
): Promise<void> {
  if (!isValidName(name) || !isValidName(toName) || isDotName(toName)) {
    throw new OpError('invalid collection name');
  }
  checkNewName('collection', toName);
  const dir = collectionDir(root, name);
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new OpError(`collection ${name} not found`, 'notfound');
  if (toName === name) throw new OpError('that is already its name', 'nochange');
  const dest = collectionDir(root, toName);
  if (fs.existsSync(dest)) throw new OpError(`collection ${toName} already exists`, 'exists');
  // A rename that only changes the case of this collection's own name is
  // allowed; a case-variant of any other collection is refused.
  checkCollectionCase(root, toName, name);
  const rootReal = fs.realpathSync(root);
  if (!containedIn(rootReal, dir)) {
    throw new OpError('collection directory is outside the vault; refusing to move it');
  }
  // Read the repositories before the move, since afterwards they are only
  // findable under the new name and the store still has to be told the old
  // one.
  const repos = listRepoDirs(root, name).map(displayName);
  // As in renameRepo, and for every repository the collection holds: after the
  // checks, before the directory moves.
  for (const repo of repos) ctx.runs?.forgetRepo(name, repo);
  fs.renameSync(dir, dest);
  // Objects in a bucket, as for a repository move: not best-effort, since an
  // object left behind is one a clone of the moved repository cannot fetch.
  // The local backend finds nothing to move, its directories having travelled
  // with the collection already.
  if (ctx.lfs) {
    for (const repo of repos) await ctx.lfs.renameRepo(name, repo, toName, repo);
  }
  // Implicit ownership follows from the collection's name, so a rename severs
  // it: a user who renamed the collection named after them would be locked out
  // of what is still theirs. The implicit owner, when there is such a user, is
  // therefore written into the explicit owners the file carries across. Only
  // ever added, never removed: the reverse rename leaves them listed, which is
  // redundant beside the name and costs nothing.
  const state = loadVault(root);
  if (state.status === 'ok' && state.vault.users[name] && name !== toName) {
    addCollectionOwner(root, toName, name);
  }
  // As for a repository: the old name is remembered, so every address under it
  // - the collection page and every repository in it - is redirected to the new
  // one until something else is created under that name.
  recordCollectionRename(root, name, toName);
  // And every custom domain into the collection follows it, as the repository
  // hook above does for one.
  moveCollectionDomains(root, name, toName);
}

/**
 * Delete a collection, and only an empty one: deletion is for a name that is
 * no longer wanted, not a way to remove many repositories at once, so a
 * collection holding any repository - or anything a repository keeps beside
 * it - is refused rather than emptied. The collection's own metadata
 * (collection.json, the owners file, and site.json, its site alias) does not
 * count against emptiness: it describes the collection and goes with it, as a
 * repository's issues go with the repository. A file this layer does not
 * recognize is refused rather than deleted, since it is not the collection's
 * to lose.
 */
export function deleteCollection(root: string, name: string): void {
  if (!isValidName(name)) throw new OpError('invalid collection name');
  const dir = collectionDir(root, name);
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new OpError(`collection ${name} not found`, 'notfound');
  const rootReal = fs.realpathSync(root);
  if (!containedIn(rootReal, dir)) {
    throw new OpError('collection directory is outside the vault; refusing to delete it');
  }
  const repos = reposDir(root, name);
  const inRepos = fs.existsSync(repos) ? fs.readdirSync(repos) : [];
  if (inRepos.length > 0) throw new OpError(`collection ${name} is not empty`, 'conflict');
  const own = fs
    .readdirSync(dir)
    .filter((n) => n !== REPOS_DIR && n !== COLLECTION_FILE && n !== COLLECTION_SITE_FILE);
  if (own.length > 0) {
    throw new OpError(`collection ${name} holds ${own[0]}, which this server did not put there; refusing to delete it`, 'conflict');
  }
  fs.rmSync(dir, { recursive: true });
  // Any redirect that led here goes with it. A collection created later under
  // this name would otherwise inherit the traffic a former name of this one
  // still sends.
  forgetCollectionRedirects(root, name);
  dropCollectionDomains(root, name);
}

/**
 * Delete a repository and everything it accumulated: the bare repository, its
 * static site, its workflow runs, its issues, its pull requests, its
 * releases, and its LFS objects.
 */
export async function deleteRepo(
  root: string,
  collection: string,
  name: string,
  ctx: RepoContext = {}
): Promise<void> {
  const repo = findRepo(root, collection, name);
  if (!repo) throw new OpError(`repository ${collection}/${name} not found`, 'notfound');
  const rootReal = fs.realpathSync(root);
  if (!containedIn(rootReal, repo.dir)) {
    throw new OpError('repository directory is outside the vault; refusing to delete');
  }
  // As in renameRepo: after the checks, before the files go, so that nothing
  // is dispatched for a repository that is about to stop existing.
  ctx.runs?.forgetRepo(collection, name);
  fs.rmSync(repo.dir, { recursive: true, force: true });
  // The siblings go too: the site, the workflow runs, the issues, the pull
  // requests, and the releases. Leaving any of them would orphan a history
  // nothing can reach, and worse, a repository later created under the same
  // name would inherit it, with run, issue, and pull numbers continuing from
  // someone else's.
  for (const suffix of repoSiblingSuffixes) {
    const dir = siblingDir(root, collection, name, suffix);
    if (containedIn(rootReal, dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // Stored LFS objects go too, best-effort: by this point the repository is
  // gone and the objects are unreachable garbage, so a storage failure is
  // logged rather than allowed to fail the deletion.
  if (ctx.lfs) {
    try {
      await ctx.lfs.deleteRepo(collection, name);
    } catch (e) {
      console.error(
        `LFS cleanup for ${collection}/${name} failed: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  // And any redirect that led here. A redirect pointing at a repository that
  // no longer exists is inert, but one left pointing at a name that is later
  // re-created would send traffic meant for the deleted repository to whatever
  // took its place. A custom domain is dropped on exactly the same reasoning.
  forgetRepoRedirects(root, collection, name);
  dropRepoDomains(root, collection, name);
}


// ---- the sequence a transport performs to change a file ----
//
// Committing a file is not one call: the caller may want the commit on a new
// branch, a file stored with Git LFS must be refused rather than replaced with
// the text of its own pointer, and the branch must not have moved since the
// caller last looked. That sequence lived inside the editor's POST handler, which
// made the browser the only place it could be done correctly.

export interface WriteRequest {
  /** The branch the caller was looking at. */
  branch: string;
  /**
   * Create this branch at expectedHead and commit there instead, which is what
   * the editor's "commit to a new branch" box does and what the API's newBranch
   * field asks for.
   */
  newBranch?: string | null;
  filePath: string;
  message: string;
  author: CommitAuthor;
  /**
   * The commit the caller last saw at the branch tip, or null when there is no
   * branch yet. Absent, the write is unconditional; present, a branch that has
   * moved is a conflict rather than a silent overwrite.
   */
  expectedHead: string | null;
  action: FileAction;
}

/**
 * A write that failed before it began, because the branch it was to go on could
 * not be made. Distinct from the write's own failures because it means something
 * different to a caller: a name already taken is somebody else's branch, not a
 * file that is already there.
 */
export class NewBranchError extends OpError {}

export interface WriteResult {
  /** The branch actually committed to, which is newBranch when one was asked for. */
  branch: string;
  sha: string;
  before: string | null;
}

/** Whether a path holds a Git LFS pointer rather than the file itself. */
async function isPointerAt(repoDir: string, commit: string, filePath: string): Promise<boolean> {
  try {
    const buf = await execGit(repoDir, ['cat-file', 'blob', `${commit}:${filePath}`]);
    return looksLikePointer(buf);
  } catch {
    return false;
  }
}

export async function writeFile(repoDir: string, request: WriteRequest): Promise<WriteResult> {
  let branch = request.branch;
  if (request.newBranch) {
    if (request.expectedHead === null) {
      throw new NewBranchError('There is nothing to branch from yet; commit to this branch first.');
    }
    try {
      await createBranch(repoDir, request.newBranch, request.expectedHead);
    } catch (e) {
      if (e instanceof OpError) throw new NewBranchError(e.message, e.kind);
      throw new NewBranchError('Could not create that branch.');
    }
    branch = request.newBranch;
  }
  // The repository holds a pointer, not the file, so replacing it with text
  // would replace the pointer and leave the object orphaned. Refused rather than
  // done, in both transports, and checked here so that neither can skip it.
  if (
    request.expectedHead !== null &&
    request.action.kind !== 'create' &&
    (await isPointerAt(repoDir, request.expectedHead, request.filePath))
  ) {
    throw new OpError(
      `${request.filePath} is stored with Git LFS; the repository holds only a pointer to it. Change it with a git client instead.`
    );
  }
  const sha = await commitFileChange(repoDir, {
    branch,
    filePath: request.filePath,
    message: request.message,
    author: request.author,
    expectedHead: request.expectedHead,
    action: request.action,
  });
  return { branch, sha, before: request.expectedHead };
}

/**
 * Create a repository and, when asked, put a first commit in it. The README is
 * what makes a new repository browsable rather than a page of instructions, and
 * both transports offer it.
 *
 * The caller fires the push event, since it holds the CI engine.
 */
export async function createRepoWithReadme(
  root: string,
  collection: string,
  name: string,
  opts: { description?: string; readme?: boolean; private?: boolean; author: CommitAuthor }
): Promise<{ repo: GitRepo; sha: string | null }> {
  const description = (opts.description ?? '').replace(/\s+/g, ' ').trim();
  // Checked before the repository exists, so a refused description does not
  // leave a created repository behind the error page.
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new OpError(
      `the description may be at most ${MAX_DESCRIPTION_LENGTH} characters (this one is ${description.length}); longer prose belongs in the README`
    );
  }
  const repo = await createRepo(root, collection, name, { private: opts.private });
  if (description) setDescription(repo.dir, description);
  if (!opts.readme) return { repo, sha: null };
  const sha = await commitFileChange(repo.dir, {
    branch: 'main',
    filePath: 'README.md',
    message: 'Initial commit',
    author: opts.author,
    expectedHead: null,
    action: { kind: 'create', content: Buffer.from(`# ${name}\n${description ? `\n${description}\n` : ''}`) },
  });
  return { repo, sha };
}
