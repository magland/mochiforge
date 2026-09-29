import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { api, apiFailed, apiTry, remoteTarget } from './cli-api';
import { mochiCredentialArgs, mochiCredentialEnv, run } from './cli/gitrun';
import { isValidName } from './scan';
import { parseSource } from './source';

// `mochi import`: bring an existing repository into a vault. This runs on
// the operator's machine and not on the server, which is the same division the
// import page has always described: their own git credentials read
// the source, their mochi token writes the vault, and push-to-create makes
// the repository. What changes here is only who types the commands. A bare
// clone into a temporary directory, a mirror push at the vault, and the
// temporary directory is removed again.

interface ImportArgs {
  src: string | null;
  collection: string | null;
  name: string | null;
  host: string | null;
  token: string | null;
  lfs: boolean;
  description: string | null;
  noDescription: boolean;
}

function parseImportArgs(args: string[], usage: () => never): ImportArgs {
  const out: ImportArgs = {
    src: null,
    collection: null,
    name: null,
    host: null,
    token: null,
    lfs: false,
    description: null,
    noDescription: false,
  };
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--host') out.host = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '--collection') out.collection = args[++i];
    else if (a === '--name') out.name = args[++i];
    else if (a === '--lfs') out.lfs = true;
    else if (a === '--description') out.description = args[++i];
    else if (a === '--no-description') out.noDescription = true;
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else if (positional === 0) {
      out.src = a;
      positional++;
    } else if (positional === 1) {
      // The destination is written the way a repository is addressed
      // everywhere else in mochi: `collection` or `collection/repo`.
      const slash = a.indexOf('/');
      if (slash === -1) out.collection = a;
      else {
        out.collection = a.slice(0, slash);
        out.name = a.slice(slash + 1);
      }
      positional++;
    } else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function git(args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return run('git', args, env);
}

function pushArgs(dir: string): string[] {
  return ['-C', dir, ...mochiCredentialArgs()];
}

/**
 * A repository's one-line description is not part of its git data, so a clone
 * and a mirror push carry everything except that. For a GitHub source we can
 * ask for it: one unauthenticated call to the REST API, which answers for a
 * public repository and declines for a private one. Nothing here is worth
 * failing an import that has already arrived, so every failure is a null and
 * the caller says so in one line.
 */
async function githubDescription(gh: { owner: string; repo: string }): Promise<string | null> {
  const url = `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`;
  try {
    const resp = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'mochi-import' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { description?: unknown };
    const description = typeof data.description === 'string' ? data.description.trim() : '';
    return description === '' ? null : description;
  } catch {
    return null;
  }
}

export async function importCmd(
  args: string[],
  usage: () => never,
  mode: { fork?: boolean } = {}
): Promise<void> {
  const a = parseImportArgs(args, usage);
  const cmd = mode.fork ? 'fork' : 'import';
  if (!a.src) {
    console.error(`Usage: mochi ${cmd} <source> <collection>[/<name>]`);
    console.error(`  e.g. mochi ${cmd} https://github.com/octocat/Hello-World mycollection`);
    process.exit(1);
  }
  const source = parseSource(a.src);
  if (mode.fork && source && path.isAbsolute(source.url)) {
    console.error('A fork records the URL it came from, and a local directory has no URL to record.');
    console.error(`Use mochi import instead: mochi import ${a.src} <collection>`);
    process.exit(1);
  }
  if (!source) {
    console.error(`Not a source we can clone: ${a.src}`);
    console.error('Give an https or ssh git URL, owner/repo for GitHub, or the path to a repository here.');
    process.exit(1);
  }
  const collection = a.collection ?? '';
  const name = a.name ?? source.name;
  if (!collection) {
    console.error(`Which collection should ${name} go into?`);
    console.error(`  mochi ${cmd} ${a.src} mycollection`);
    process.exit(1);
  }
  if (!isValidName(collection) || !isValidName(name)) {
    console.error('Collection and repository names may use letters, digits, dot, underscore, and dash,');
    console.error('and must not be reserved words.');
    process.exit(1);
  }

  const target = await remoteTarget(a);

  // Who the push will be as, and whether the token still works: worth knowing
  // before a clone that may take minutes.
  const who = await api(target, 'GET', '/api/whoami');
  const username = String(who.username ?? '');
  if (!username) {
    console.error(`${target.host} did not say who this token belongs to.`);
    process.exit(1);
  }

  // A mirror push at an existing repository would replace its refs, so an
  // existing name stops the import here rather than after the clone.
  const listing = `/api/collections/${encodeURIComponent(collection)}`;
  const existing = await apiTry(target, 'GET', listing);
  if (existing.ok && ((existing.data.repos ?? []) as string[]).includes(name)) {
    console.error(`${collection}/${name} already exists on ${target.host}.`);
    console.error('A mirror push would replace its branches and tags, so this stops here. Import');
    console.error('under another name,');
    console.error(`  mochi ${cmd} ${a.src} ${collection}/another-name`);
    console.error('or delete the existing repository first, from its settings page.');
    process.exit(1);
  }
  if (!existing.ok && existing.status !== 404) apiFailed(target, listing, existing);

  const dest = `${target.host}/${encodeURIComponent(collection)}/${encodeURIComponent(name)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-import-'));
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory is not worth failing the import over.
    }
  };
  try {
    // --bare rather than --mirror: mirroring a GitHub repository drags in
    // refs/pull/*, thousands of refs the vault has no use for. A bare clone
    // carries branches and tags, which is what the push then mirrors.
    console.log(`Cloning ${source.url}`);
    if ((await git(['clone', '--bare', '--', source.url, tmp])) !== 0) {
      throw new Error(`Could not clone ${source.url}.`);
    }
    if (a.lfs) {
      console.log('Fetching Git LFS objects');
      if ((await git(['-C', tmp, 'lfs', 'fetch', '--all'])) !== 0) {
        throw new Error('Could not fetch the LFS objects. Is git-lfs installed?');
      }
    }
    console.log(`Pushing to ${dest} as ${username}`);
    const env = mochiCredentialEnv(username, target.token);
    if ((await git([...pushArgs(tmp), 'push', '--mirror', dest], env)) !== 0) {
      throw new Error(
        `Could not push to ${dest}.\nIf it refused the token, check that you may create in ${collection}.`
      );
    }
    if (a.lfs) {
      console.log('Pushing Git LFS objects');
      if ((await git([...pushArgs(tmp), 'lfs', 'push', '--all', dest], env)) !== 0) {
        throw new Error('The repository arrived, but its LFS objects did not.');
      }
    }
  } finally {
    // Reported through an exception rather than process.exit, since exiting
    // here would skip this and leave the bare clone behind.
    cleanup();
  }
  // A fork remembers where it came from: the source URL lands in the
  // repository's config as mochi.upstream, where the repo header, `mochi
  // sync`, and `mochi pr export` read it back. Recorded after the push, since
  // the repository does not exist until the push creates it.
  let upstream: string | null = null;
  if (mode.fork) {
    const patch = await apiTry(target, 'PATCH', `/api/repos/${encodeURIComponent(collection)}/${encodeURIComponent(name)}`, {
      upstream: source.url,
    });
    if (patch.ok) upstream = source.url;
    else {
      console.error(`The repository arrived, but its upstream could not be recorded: ${patch.data.error ?? `HTTP ${patch.status}`}`);
      console.error(`  mochi repo edit ${collection}/${name} --upstream ${source.url}`);
    }
  }
  // The description too is set after the push rather than before it.
  let described: string | null = a.description?.trim() || null;
  if (!described && !a.noDescription && source.github) described = await githubDescription(source.github);
  if (described) {
    const patch = await apiTry(target, 'PATCH', `/api/repos/${encodeURIComponent(collection)}/${encodeURIComponent(name)}`, {
      description: described,
    });
    if (!patch.ok) {
      console.error(`The repository arrived, but its description could not be set: ${patch.data.error ?? `HTTP ${patch.status}`}`);
      described = null;
    }
  }

  console.log('');
  console.log(`${mode.fork ? 'Forked' : 'Imported'} ${collection}/${name}`);
  console.log(`  ${dest}`);
  if (upstream) console.log(`  forked from ${upstream}`);
  // Worth saying rather than leaving to be discovered: a mirror push carries
  // LFS pointer files, so the files look present and read as missing.
  if (described) console.log(`  ${described}`);
  else if (source.github && !a.noDescription) console.log('  (no description came across; set one in repository settings)');
  if (!a.lfs) console.log('  (Git LFS objects, if it has any, were not carried over; import again with --lfs)');
}

/** `mochi fork`: `mochi import` that records where the repository came from. */
export function forkCmd(args: string[], usage: () => never): Promise<void> {
  return importCmd(args, usage, { fork: true });
}
