import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { repoPath } from '../layout';
import { displayName, isValidName } from '../scan';
import { runsDir } from './runs';

// Workflow artifacts. An artifact is a tar stream a job uploads under a name,
// stored inside the run's directory so that it is pruned with the run and
// copied with a vault backup like everything else:
//
//   <vault>/collections/<collection>/repos/<repo>.runs/12/artifacts/github-pages.tar
//
// mochi does not implement GitHub's artifact wire protocol. The
// upload-artifact and download-artifact actions are substituted by mochi's
// own (see the runner's overrides), which speak the small API in ci/api.ts;
// this module is only the storage underneath it.

export class ArtifactError extends Error {}

// Artifact names come from workflow files. They become filenames, so they are
// constrained the same way job ids are, and for the same reason.
export function isValidArtifactName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,110}$/.test(name) && !name.includes('..');
}

export function artifactsDir(root: string, collection: string, repo: string, n: number): string | null {
  const base = runsDir(root, collection, repo);
  if (!base) return null;
  return path.join(base, String(n), 'artifacts');
}

export function artifactPath(
  root: string,
  collection: string,
  repo: string,
  n: number,
  name: string
): string | null {
  if (!isValidArtifactName(name)) return null;
  const dir = artifactsDir(root, collection, repo, n);
  if (!dir) return null;
  return path.join(dir, `${name}.tar`);
}

export interface ArtifactInfo {
  name: string;
  size: number;
  createdAt: string;
}

export function listArtifacts(root: string, collection: string, repo: string, n: number): ArtifactInfo[] {
  const dir = artifactsDir(root, collection, repo, n);
  if (!dir) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ArtifactInfo[] = [];
  for (const e of entries) {
    if (!e.endsWith('.tar')) continue;
    const name = e.slice(0, -4);
    if (!isValidArtifactName(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, e));
      out.push({ name, size: st.size, createdAt: st.mtime.toISOString() });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new ArtifactError((stderr || err.message).toString().trim()));
      else resolve(stdout.toString());
    });
  });
}

// Deploy an artifact as the repository's site.
//
// The bytes arrive from a runner, so extraction is treated as untrusted: tar
// runs into a scratch directory outside the published one, every resulting
// path is checked to be inside it, and only then does the new site replace
// the old one by rename. A half-extracted archive therefore never becomes the
// live site, and a crafted archive cannot write outside the vault.
export async function deploySite(
  root: string,
  collection: string,
  repo: string,
  n: number,
  artifactName: string
): Promise<{ files: number }> {
  if (!isValidName(collection) || !isValidName(repo)) throw new ArtifactError('invalid repository');
  const tar = artifactPath(root, collection, repo, n, artifactName);
  if (!tar || !fs.existsSync(tar)) {
    throw new ArtifactError(`no artifact named ${artifactName} in run #${n}`);
  }
  return installSiteFromTar(root, collection, repo, tar, { unwrapPagesArtifact: true, what: `artifact ${artifactName}` });
}

/**
 * Replace a repository's site directory with the contents of a tar archive:
 * extracted into a scratch directory beside the site, checked for symlinks
 * that would escape it, and swapped into place in one rename with the
 * previous site kept until the swap has succeeded. The same path publishes a
 * workflow's artifact (above) and a 'repository' site's tree
 * (src/sitepublish.ts); the archive is untrusted in both cases.
 */
export async function installSiteFromTar(
  root: string,
  collection: string,
  repo: string,
  tar: string,
  opts: { unwrapPagesArtifact: boolean; what: string }
): Promise<{ files: number }> {
  if (!isValidName(collection) || !isValidName(repo)) throw new ArtifactError('invalid repository');
  const dir = repoPath(root, collection, `${displayName(repo)}.site`);
  const scratch = `${dir}.incoming-${process.pid}`;
  const previous = `${dir}.previous-${process.pid}`;
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  try {
    // Containment during extraction is tar's own: GNU tar and libarchive both
    // strip a leading `/` and a `..` from member names, and both refuse to
    // write through a symlink a member of the same archive created, which is
    // what stops `link -> /etc` followed by `link/passwd`. The walk below runs
    // after the bytes are on disk, so it removes an escaping link rather than
    // preventing a write through one; that division is load-bearing, and a tar
    // without those two behaviours would not be safe to point at this.
    await run('tar', ['-xf', tar, '-C', scratch, '--no-same-owner', '--no-same-permissions']);

    // upload-pages-artifact wraps the site in a tar of its own, so an
    // artifact holding exactly one artifact.tar is unwrapped once more. This
    // is what makes the real actions/upload-pages-artifact work unchanged.
    const entries = fs.readdirSync(scratch);
    if (opts.unwrapPagesArtifact && entries.length === 1 && entries[0] === 'artifact.tar') {
      const inner = path.join(scratch, 'artifact.tar');
      const unwrapped = `${scratch}.inner`;
      fs.rmSync(unwrapped, { recursive: true, force: true });
      fs.mkdirSync(unwrapped);
      await run('tar', ['-xf', inner, '-C', unwrapped, '--no-same-owner', '--no-same-permissions']);
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.renameSync(unwrapped, scratch);
    }

    const scratchReal = fs.realpathSync(scratch);
    let files = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // A symlink pointing outside the site would publish arbitrary files
        // from the vault's disk, so links are removed rather than followed.
        if (entry.isSymbolicLink()) {
          const target = path.resolve(dir, fs.readlinkSync(full));
          if (target !== scratchReal && !target.startsWith(scratchReal + path.sep)) {
            fs.rmSync(full, { force: true });
            continue;
          }
        }
        if (entry.isDirectory()) walk(full);
        else files++;
      }
    };
    walk(scratch);
    if (files === 0) throw new ArtifactError(`${opts.what} contains no files`);

    fs.rmSync(previous, { recursive: true, force: true });
    const had = fs.existsSync(dir);
    if (had) fs.renameSync(dir, previous);
    try {
      fs.renameSync(scratch, dir);
    } catch (e) {
      if (had) fs.renameSync(previous, dir);
      throw e;
    }
    fs.rmSync(previous, { recursive: true, force: true });
    return { files };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(`${scratch}.inner`, { recursive: true, force: true });
  }
}
