import * as fs from 'fs';
import * as path from 'path';
import { ArtifactError, installSiteFromTar } from './ci/artifacts';
import { execGit, GitRepo } from './git';
import { repoPath } from './layout';
import { displayName } from './scan';
import { SiteSettings, SiteSource, siteSettings } from './sitesettings';

// Publishing a site from the repository itself: the third site source, beside
// files copied into the directory and a workflow's deploy step. With it, the
// site directory is a checkout the server maintains of the default branch (or
// a directory within it), rewritten on every push that moves that branch and
// whenever the settings that decide it change. It is what GitHub Pages calls
// deploying from a branch, and it is the mode for a repository whose site is
// plain files that need no build: the push is the deploy, and nothing else has
// to run anywhere.
//
// The tree is taken with `git archive`, so a `.gitattributes` line such as
// `secret.txt export-ignore` keeps a file out of the site, and it goes through
// the same extraction as a workflow artifact does (installSiteFromTar): into a
// scratch directory, symlinks that would escape it removed, then one rename.
// A failed publish leaves the previous site in place.

export class SitePublishError extends Error {}

/** How a site source publishes, for a message of the form "published by ...". */
export function describeSiteSource(source: SiteSource): string {
  switch (source) {
    case 'actions':
      return 'workflow deploys';
    case 'repository':
      return 'the repository itself, from its default branch';
    default:
      return 'copying files';
  }
}

/**
 * Whether a push that moved `ref` should republish this repository's site:
 * only a 'repository' site that is enabled, and only for the default branch.
 */
export async function siteFollowsRef(repo: GitRepo, ref: string, settings: SiteSettings = siteSettings(repo.dir)): Promise<boolean> {
  if (!settings.enabled || settings.source !== 'repository') return false;
  const branch = await repo.defaultBranch(await repo.listRefs('heads'));
  return branch !== null && ref === `refs/heads/${branch}`;
}

/**
 * Write the site directory from the default branch's tree, or from `path`
 * within it. Returns the number of files published, or null when the settings
 * do not ask for it (not enabled, or another source): a caller may call this
 * unconditionally after anything that might have changed what the site should
 * hold. Throws SitePublishError when the settings ask for it and it cannot be
 * done: no default branch yet, a directory the branch does not have, or a tree
 * with no files in it.
 */
export async function publishSiteFromRepository(root: string, repo: GitRepo): Promise<{ files: number } | null> {
  const settings = siteSettings(repo.dir);
  if (!settings.enabled || settings.source !== 'repository') return null;
  const branch = await repo.defaultBranch(await repo.listRefs('heads'));
  if (!branch) throw new SitePublishError('the repository has no default branch to publish the site from');
  const spec = settings.path ? `${branch}:${settings.path}` : branch;
  const what = settings.path ? `the directory ${settings.path} on ${branch}` : `the branch ${branch}`;
  const tar = `${repoPath(root, repo.collection, `${displayName(repo.name)}.site`)}.archive-${process.pid}.tar`;
  fs.rmSync(tar, { force: true });
  try {
    try {
      // `--` is not accepted by git archive between the tree-ish and the
      // paths, so the spec is kept from looking like an option by the branch
      // name rules (no leading dash) and by isUsableSitePath.
      await execGit(repo.dir, ['archive', '--format=tar', '-o', tar, spec]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not a tree object|not a valid object name|Not a valid object name|no such ref|did not match any files/i.test(msg)) {
        throw new SitePublishError(`${what} does not exist, so there is nothing to publish`);
      }
      throw new SitePublishError(`git archive failed for ${what}: ${msg}`);
    }
    try {
      return await installSiteFromTar(root, repo.collection, repo.name, tar, { unwrapPagesArtifact: false, what });
    } catch (e) {
      if (e instanceof ArtifactError) throw new SitePublishError(e.message);
      throw e;
    }
  } finally {
    fs.rmSync(tar, { force: true });
  }
}

/**
 * The publish that follows a push: republish when the moved ref is the one the
 * site follows, and otherwise do nothing. Errors are logged rather than
 * thrown, since by the time this runs the push has been accepted and the
 * pusher has gone; the settings page and the API report the same failure
 * when the site is next saved, which is where a person can act on it.
 */
export async function publishSiteAfterPush(root: string, repo: GitRepo, ref: string): Promise<void> {
  try {
    if (!(await siteFollowsRef(repo, ref))) return;
    const result = await publishSiteFromRepository(root, repo);
    if (result) console.log(`site for ${repo.collection}/${repo.name} published from ${ref}: ${result.files} file(s)`);
  } catch (e) {
    console.error(`site publish for ${repo.collection}/${repo.name} failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * The result of a publish attempted because settings changed, in the shape
 * the settings page and the PATCH route hand back: what was published, or
 * why it was not.
 */
export async function publishSiteForSettings(root: string, repo: GitRepo): Promise<{ files: number } | { error: string } | null> {
  try {
    return await publishSiteFromRepository(root, repo);
  } catch (e) {
    if (e instanceof SitePublishError) return { error: e.message };
    throw e;
  }
}

/** Whether the site directory exists, for messages that say what happened. */
export function siteDirExists(root: string, collection: string, repo: string): boolean {
  try {
    return fs.statSync(path.join(repoPath(root, collection, `${displayName(repo)}.site`))).isDirectory();
  } catch {
    return false;
  }
}
