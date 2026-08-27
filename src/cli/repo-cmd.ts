import { spawn } from 'child_process';
import { api, request } from '../cli-api';
import { CliError, EXIT_FAIL, EXIT_USAGE, exitCodeForStatus } from './exit';
import { readFileArg } from './input';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, OptionSpec } from './parse';
import { REPO_OPTION, repoPath, resolveRepo } from './repo';
import { TARGET_OPTIONS, targetFrom } from './target';

// Reading a repository from the command line: what is in it, what one file says,
// what changed, and where something appears. Between them these are what let a
// caller work on a repository without cloning it.

const COMMON: OptionSpec[] = [REPO_OPTION, ...TARGET_OPTIONS];
const REF_OPTION: OptionSpec = {
  name: 'ref',
  type: 'string',
  value: '<r>',
  summary: 'Branch, tag, or commit; the default branch otherwise',
};

// Every destructive command takes --yes and refuses without it, rather than
// prompting. A prompt is no use to a caller that is not a person, and a command
// that prompts is a command that hangs in a container.
const YES_OPTION: OptionSpec = {
  name: 'yes',
  type: 'boolean',
  summary: 'Required: confirm that this cannot be undone',
};

function requireYes(inv: { bool(name: string): boolean }, what: string): void {
  if (!inv.bool('yes')) throw new CliError(`${what} cannot be undone. Pass --yes to go ahead.`, EXIT_USAGE);
}

function refQuery(ref: string | null, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (ref !== null) q.set('ref', ref);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const repoCommands: Command[] = [
  {
    path: ['repo', 'list'],
    summary: 'List the repositories in the vault',
    args: [{ name: 'collection' }],
    options: [
      { name: 'topic', type: 'string', value: '<t>', summary: 'Only repositories carrying this topic' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const topic = inv.str('topic');
      const data = await api(target, 'GET', `/api/repos${topic !== null ? `?topic=${encodeURIComponent(topic)}` : ''}`);
      const only = inv.args[0] ?? null;
      const repos = ((data.repos ?? []) as Record<string, unknown>[]).filter(
        (r) => only === null || r.collection === only
      );
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ repos: pickFields(repos, json.fields) });
        return;
      }
      if (repos.length === 0) {
        console.log(only ? `No repositories in ${only}` : `No repositories on ${target.host}`);
        return;
      }
      printTable(
        repos.map((r) => [
          `${r.collection}/${r.name}${(r as { private?: boolean }).private ? ' (private)' : ''}`,
          String(r.description ?? ''),
        ])
      );
    },
  },
  {
    path: ['repo', 'view'],
    summary: 'Show one repository: its default branch, counts, and whether it has a site',
    args: [{ name: 'repo' }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target, inv.args[0] ?? null);
      const data = await api(target, 'GET', repoPath(ref));
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${data.collection}/${data.name}`);
      if (data.description) console.log(String(data.description));
      if (data.forkedFrom) {
        const from = data.forkedFrom as { collection: string; repo: string };
        console.log(`forked from ${from.collection}/${from.repo}`);
      }
      if (data.upstream) console.log(`forked from ${data.upstream}`);
      const topics = (data.topics ?? []) as string[];
      printTable([
        ['visibility', data.private ? 'private' : 'public'],
        ...(topics.length ? [['topics', topics.join(', ')]] : []),
        ['default branch', String(data.defaultBranch ?? '(none)')],
        ['last updated', shortDate(data.updated)],
        ['branches', String(data.branches)],
        ['tags', String(data.tags)],
        ['releases', String(data.releases)],
        ['open issues', String(data.openIssues)],
        ['open pull requests', String(data.openPulls)],
        ['site', data.hasSite ? 'yes' : 'no'],
      ]);
    },
  },
  {
    path: ['repo', 'create'],
    summary: 'Create an empty repository, or one with a README in it',
    args: [{ name: 'collection/name', required: true }],
    options: [
      { name: 'description', type: 'string', value: '<d>', summary: 'One-line description' },
      { name: 'readme', type: 'boolean', summary: 'Add a first commit with a README.md' },
      { name: 'private', type: 'boolean', summary: 'Visible only to collaborators, owners, and site admins' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const parts = inv.args[0].split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new CliError('name the repository as <collection>/<name>', EXIT_USAGE);
      }
      const target = await targetFrom(inv);
      const data = await api(target, 'POST', '/api/repos', {
        collection: parts[0],
        name: parts[1],
        description: inv.str('description') ?? undefined,
        initReadme: inv.bool('readme'),
        private: inv.bool('private') || undefined,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${target.host}/${data.collection}/${data.name}`);
    },
  },
  {
    path: ['repo', 'fork'],
    summary: 'Copy a repository into another collection',
    args: [
      { name: 'repo', required: true },
      { name: 'collection[/name]', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const source = await resolveRepo(inv, target, inv.args[0]);
      const parts = inv.args[1].split('/');
      const data = await api(target, 'POST', `${repoPath(source)}/fork`, {
        collection: parts[0],
        name: parts[1] ?? undefined,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${target.host}/${data.collection}/${data.name}`);
    },
  },
  {
    path: ['repo', 'edit'],
    summary: 'Change a repository description, topics, default branch, or visibility',
    description: `--topic replaces the whole set, which is what the API does; --add-topic and
--remove-topic keep what is there and change it, which means reading the
repository first. A topic is lowercase letters, digits, and hyphens.`,
    args: [{ name: 'repo' }],
    options: [
      { name: 'description', type: 'string', value: '<d>', summary: 'New description' },
      { name: 'topic', type: 'string[]', value: '<t>', summary: 'Replace the topics with these' },
      { name: 'add-topic', type: 'string[]', value: '<t>', summary: 'Keep the existing topics and add these' },
      { name: 'remove-topic', type: 'string[]', value: '<t>', summary: 'Keep the existing topics apart from these' },
      { name: 'clear-topics', type: 'boolean', summary: 'Remove every topic' },
      { name: 'default-branch', type: 'string', value: '<b>', summary: 'New default branch' },
      { name: 'upstream', type: 'string', value: '<url>', summary: "URL this was forked from; '' clears it" },
      { name: 'private', type: 'boolean', summary: 'Make the repository private (takes the admin role)' },
      { name: 'public', type: 'boolean', summary: 'Make the repository public' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const description = inv.str('description');
      const defaultBranch = inv.str('default-branch');
      const upstream = inv.str('upstream');
      if (inv.bool('private') && inv.bool('public')) {
        throw new CliError('Pass --private or --public, not both.', EXIT_USAGE);
      }
      const priv = inv.bool('private') ? true : inv.bool('public') ? false : undefined;
      const set = inv.list('topic');
      const add = inv.list('add-topic');
      const remove = inv.list('remove-topic');
      const clear = inv.bool('clear-topics');
      // --topic and --clear-topics each name the whole set, so they combine
      // with nothing; --add-topic and --remove-topic edit it and may combine.
      if ((set.length !== 0 ? 1 : 0) + (clear ? 1 : 0) + (add.length !== 0 || remove.length !== 0 ? 1 : 0) > 1) {
        throw new CliError('Pass --topic or --clear-topics on their own, or --add-topic/--remove-topic together.', EXIT_USAGE);
      }
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target, inv.args[0] ?? null);
      let topics: string[] | undefined = clear ? [] : set.length ? set : undefined;
      if (add.length || remove.length) {
        const current = (await api(target, 'GET', repoPath(repo))).topics as string[] | undefined;
        topics = [...new Set([...(current ?? []), ...add])].filter((t) => !remove.includes(t));
      }
      if (description === null && defaultBranch === null && upstream === null && topics === undefined && priv === undefined) {
        throw new CliError(
          'Nothing to change. Pass --description, --topic, --add-topic, --remove-topic, --clear-topics, --default-branch, --upstream, --private, or --public.',
          EXIT_USAGE
        );
      }
      const data = await api(target, 'PATCH', repoPath(repo), {
        description: description ?? undefined,
        topics,
        defaultBranch: defaultBranch ?? undefined,
        upstream: upstream ?? undefined,
        private: priv,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Updated ${data.collection}/${data.name}`);
    },
  },
  {
    path: ['repo', 'rename'],
    summary: 'Rename a repository, or move it to another collection',
    description: `A repository is a bare repository plus the directories it keeps beside it, for
its issues, pull requests, releases, site, and run history. All of them move
together.`,
    args: [
      { name: 'repo', required: true },
      { name: 'new-name', required: true },
    ],
    options: [
      { name: 'collection', type: 'string', value: '<c>', summary: 'Move it to this collection as well' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target, inv.args[0]);
      const data = await api(target, 'POST', `${repoPath(repo)}/rename`, {
        name: inv.args[1],
        collection: inv.str('collection') ?? undefined,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      // As for a collection: asking for the name it already has is answered as
      // changed:false, and printing "Now undefined/undefined" for it would be
      // a report of something that did not happen.
      if (data.changed === false) {
        console.log(String(data.message ?? 'Nothing changed.'));
        return;
      }
      console.log(`Now ${data.collection}/${data.name}`);
    },
  },
  {
    path: ['repo', 'delete'],
    summary: 'Delete a repository and everything beside it',
    args: [{ name: 'repo', required: true }],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      requireYes(inv, 'Deleting a repository');
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target, inv.args[0]);
      const full = `${repo.collection}/${repo.repo}`;
      const data = await api(target, 'DELETE', `${repoPath(repo)}?confirm=${encodeURIComponent(full)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Deleted ${full}`);
    },
  },
  {
    path: ['repo', 'gc'],
    summary: 'Drop every object no branch or tag can reach',
    description: `Git adds objects and never removes them, so a force push, a deleted branch, or a
rewritten history leaves what it abandoned in the repository: unreachable from
any ref, still readable by anyone who knows the hash, and still counted against
the disk. This drops all of it now.

The vault collects each repository on its own every few hours, sparing anything
unreachable but newer than two days so that a push in flight is never pruned.
This command is for when that is not soon enough: a file rewritten out of a
history is unreachable at once, but until it is collected it can still be
fetched by naming its commit. Objects younger than five minutes are still
spared, which is the same in-flight push the sweep protects.

Takes the admin role on the repository. What it removes cannot be recovered.`,
    args: [{ name: 'repo' }],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      requireYes(inv, 'Dropping unreachable objects');
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target, inv.args[0]);
      const full = `${repo.collection}/${repo.repo}`;
      const data = await api(target, 'POST', `${repoPath(repo)}/gc?confirm=${encodeURIComponent(full)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      const removed = Number(data.removed ?? 0);
      const freed = Number(data.kilobytesFreed ?? 0);
      console.log(
        removed === 0
          ? `Collected ${full}; nothing was unreachable.`
          : `Collected ${full}: ${removed} object${removed === 1 ? '' : 's'} dropped, ${
              freed >= 1024 ? `${(freed / 1024).toFixed(1)} MB` : `${freed} KB`
            } freed.`
      );
    },
  },
  {
    path: ['repo', 'clone'],
    summary: 'git clone, with the vault URL filled in',
    description: `A thin wrapper over git clone. The URL is otherwise assembled by hand from the
login, and the credential arrangement is already in place, so this saves the
assembling and nothing else.`,
    args: [{ name: 'repo', required: true }, { name: 'directory' }],
    options: [...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target, inv.args[0]);
      const url = `${target.host}/${repo.collection}/${repo.repo}`;
      const args = ['clone', url, ...(inv.args[1] ? [inv.args[1]] : [])];
      const code = await new Promise<number>((resolve) => {
        const child = spawn('git', args, { stdio: 'inherit' });
        child.on('error', () => resolve(EXIT_FAIL));
        child.on('close', (c) => resolve(c ?? EXIT_FAIL));
      });
      if (code !== 0) process.exit(code);
    },
  },
  {
    path: ['branch', 'list'],
    summary: 'List branches',
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(ref)}/branches`);
      const branches = (data.branches ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ branches: pickFields(branches, json.fields), defaultBranch: data.defaultBranch });
        return;
      }
      printTable(
        branches.map((b) => [
          b.name === data.defaultBranch ? `* ${b.name}` : `  ${b.name}`,
          String(b.sha).slice(0, 10),
          shortDate(b.date as string),
          String(b.subject ?? ''),
        ])
      );
    },
  },
  {
    path: ['branch', 'create'],
    summary: 'Create a branch at a ref',
    args: [{ name: 'name', required: true }, { name: 'from' }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const from = inv.args[1] ?? null;
      const data = await api(target, 'POST', `${repoPath(repo)}/branches`, {
        name: inv.args[0],
        // No `from` means from the default branch, which is what a caller
        // starting a branch almost always means.
        from: from ?? (await api(target, 'GET', `${repoPath(repo)}/branches`)).defaultBranch,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Created ${data.name} at ${String(data.sha).slice(0, 10)}`);
    },
  },
  {
    path: ['branch', 'delete'],
    summary: 'Delete a branch',
    args: [{ name: 'name', required: true }],
    options: [YES_OPTION, JSON_OPTION, ...COMMON],
    async run(inv) {
      requireYes(inv, 'Deleting a branch');
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const data = await api(target, 'DELETE', `${repoPath(repo)}/branches/${inv.args[0]}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Deleted ${data.deleted}`);
    },
  },
  {
    path: ['tag', 'list'],
    summary: 'List tags',
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(ref)}/tags`);
      const tags = (data.tags ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ tags: pickFields(tags, json.fields) });
        return;
      }
      if (tags.length === 0) {
        console.log('No tags');
        return;
      }
      printTable(tags.map((t) => [String(t.name), String(t.sha).slice(0, 10), shortDate(t.date as string), String(t.subject ?? '')]));
    },
  },
  {
    path: ['tag', 'create'],
    summary: 'Create a tag at a ref',
    args: [{ name: 'name', required: true }, { name: 'at' }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const at = inv.args[1] ?? null;
      const data = await api(target, 'POST', `${repoPath(repo)}/tags`, {
        name: inv.args[0],
        at: at ?? (await api(target, 'GET', `${repoPath(repo)}/branches`)).defaultBranch,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Created ${data.name} at ${String(data.sha).slice(0, 10)}`);
    },
  },
  {
    path: ['tag', 'delete'],
    summary: 'Delete a tag',
    args: [{ name: 'name', required: true }],
    options: [YES_OPTION, JSON_OPTION, ...COMMON],
    async run(inv) {
      requireYes(inv, 'Deleting a tag');
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const data = await api(target, 'DELETE', `${repoPath(repo)}/tags/${inv.args[0]}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Deleted ${data.deleted}`);
    },
  },
  {
    path: ['file', 'list'],
    summary: 'List a directory, or every path in the tree',
    description: `With no path this lists the repository root. --all lists every path in the tree
instead, which is the listing a caller looking for a file wants.`,
    args: [{ name: 'path' }],
    options: [
      REF_OPTION,
      { name: 'all', type: 'boolean', summary: 'Every path in the tree, recursively' },
      { name: 'commits', type: 'boolean', summary: 'Add the last commit for each entry (one git log each)' },
      { name: 'limit', type: 'int', value: '<n>', summary: 'With --all, at most this many paths' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const ref = inv.str('ref');
      const json = jsonMode(inv);
      if (inv.bool('all')) {
        const limit = inv.int('limit');
        const data = await api(
          target,
          'GET',
          `${repoPath(repo)}/paths${refQuery(ref, limit !== null ? { limit: String(limit) } : {})}`
        );
        if (json.enabled) {
          printJson(pickObject(data, json.fields));
          return;
        }
        for (const p of (data.paths ?? []) as string[]) console.log(p);
        if (data.truncated) console.error('(the list was capped by the server; ask for fewer paths)');
        return;
      }
      const dir = (inv.args[0] ?? '').replace(/^\/+/, '');
      const query = refQuery(ref, inv.bool('commits') ? { commits: '1' } : {});
      const data = await api(target, 'GET', `${repoPath(repo)}/tree/${dir}${query}`);
      const entries = (data.entries ?? []) as Record<string, unknown>[];
      if (json.enabled) {
        printJson({ ref: data.ref, path: data.path, entries: pickFields(entries, json.fields) });
        return;
      }
      printTable(
        entries.map((e) => {
          const last = e.lastCommit as Record<string, unknown> | null | undefined;
          const row = [String(e.type), String(e.name), e.size === null ? '' : String(e.size)];
          return last ? [...row, shortDate(last.date as string), String(last.subject ?? '')] : row;
        })
      );
    },
  },
  {
    path: ['file', 'view'],
    summary: 'Print one file',
    description: `Text is printed as text. A binary file is refused rather than written to a
terminal, unless --raw is given, which streams the bytes exactly as the vault
serves them. A Git LFS pointer is reported as one rather than handed over as if it
were the file, since the bytes are elsewhere.`,
    args: [{ name: 'path', required: true }],
    options: [
      REF_OPTION,
      { name: 'raw', type: 'boolean', summary: 'The bytes, unchanged, whatever they are' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const ref = inv.str('ref');
      const filePath = inv.args[0].replace(/^\/+/, '');
      if (inv.bool('raw')) {
        const r = await request(target, 'GET', `${repoPath(repo)}/raw/${filePath}${refQuery(ref)}`);
        if (!r.ok) {
          process.stderr.write(r.body.endsWith('\n') ? r.body : r.body + '\n');
          process.exit(exitCodeForStatus(r.status));
        }
        process.stdout.write(r.body);
        return;
      }
      const data = await api(target, 'GET', `${repoPath(repo)}/contents/${filePath}${refQuery(ref)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      if (data.encoding === 'lfs-pointer') {
        const lfs = data.lfs as { oid: string; size: number };
        console.error(`${filePath} is a Git LFS pointer (oid ${lfs.oid}, ${lfs.size} bytes).`);
        console.error('Fetch it with a clone that has git-lfs, or with --raw.');
        process.exit(EXIT_USAGE);
      }
      if (data.encoding === 'base64') {
        console.error(`${filePath} is binary (${data.size} bytes). Pass --raw to write the bytes out.`);
        process.exit(EXIT_USAGE);
      }
      process.stdout.write(String(data.content ?? ''));
    },
  },
  {
    path: ['file', 'write'],
    summary: 'Create or replace a file, committing the change',
    description: `The content comes from --body-file, or from --body, or from stdin when neither is
given, so a generated file can be piped straight in.

--expected-sha is the commit the caller last saw. Given one, a branch that has
moved since is a conflict (exit 5) rather than a silent overwrite, which is what a
caller that reads, thinks, and then writes wants. 'mochi file view <path>
--json=commit' is where that value comes from.`,
    args: [{ name: 'path', required: true }],
    options: [
      { name: 'branch', type: 'string', value: '<b>', summary: 'Branch to commit on; the default branch otherwise' },
      { name: 'new-branch', type: 'string', value: '<b>', summary: 'Create this branch and commit there instead' },
      { name: 'message', type: 'string', value: '<m>', summary: 'Commit message' },
      { name: 'body', type: 'string', value: '<t>', summary: 'The file content' },
      { name: 'body-file', type: 'string', value: '<f>', summary: "Read the content from a file, or '-' for stdin" },
      { name: 'expected-sha', type: 'string', value: '<s>', summary: 'The commit the caller last saw at the branch tip' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const inline = inv.str('body');
      const file = inv.str('body-file');
      if (inline !== null && file !== null) {
        throw new CliError('Pass either --body or --body-file, not both.', EXIT_USAGE);
      }
      const content = inline !== null ? inline : await readFileArg(file ?? '-');
      const data = await api(target, 'PUT', `${repoPath(repo)}/contents/${inv.args[0].replace(/^\/+/, '')}`, {
        branch: inv.str('branch') ?? (await api(target, 'GET', `${repoPath(repo)}/branches`)).defaultBranch ?? 'main',
        newBranch: inv.str('new-branch') ?? undefined,
        message: inv.str('message') ?? undefined,
        expectedSha: inv.str('expected-sha') ?? undefined,
        content,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${data.created ? 'Created' : 'Updated'} ${data.path} on ${data.branch} as ${String(data.sha).slice(0, 10)}`);
    },
  },
  {
    path: ['file', 'delete'],
    summary: 'Delete a file, committing the change',
    args: [{ name: 'path', required: true }],
    options: [
      { name: 'branch', type: 'string', value: '<b>', summary: 'Branch to commit on; the default branch otherwise' },
      { name: 'message', type: 'string', value: '<m>', summary: 'Commit message' },
      { name: 'expected-sha', type: 'string', value: '<s>', summary: 'The commit the caller last saw at the branch tip' },
      YES_OPTION,
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      requireYes(inv, 'Deleting a file');
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const data = await api(target, 'DELETE', `${repoPath(repo)}/contents/${inv.args[0].replace(/^\/+/, '')}`, {
        branch: inv.str('branch') ?? (await api(target, 'GET', `${repoPath(repo)}/branches`)).defaultBranch ?? 'main',
        message: inv.str('message') ?? undefined,
        expectedSha: inv.str('expected-sha') ?? undefined,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Deleted ${data.path} on ${data.branch} as ${String(data.sha).slice(0, 10)}`);
    },
  },
  {
    path: ['commit', 'list'],
    summary: 'List commits',
    options: [
      REF_OPTION,
      { name: 'path', type: 'string', value: '<p>', summary: 'Only commits touching this path' },
      { name: 'limit', type: 'int', value: '<n>', summary: 'At most this many' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const extra: Record<string, string> = {};
      const filePath = inv.str('path');
      if (filePath !== null) extra.path = filePath;
      const limit = inv.int('limit');
      if (limit !== null) extra.limit = String(limit);
      const data = await api(target, 'GET', `${repoPath(repo)}/commits${refQuery(inv.str('ref'), extra)}`);
      const commits = (data.commits ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ ref: data.ref, commits: pickFields(commits, json.fields) });
        return;
      }
      printTable(commits.map((c) => [String(c.sha).slice(0, 10), shortDate(c.date as string), String(c.author), String(c.subject)]));
    },
  },
  {
    path: ['commit', 'view'],
    summary: 'Show one commit',
    args: [{ name: 'sha', required: true }],
    options: [
      { name: 'patch', type: 'boolean', summary: 'Print the patch instead of the summary' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const sha = inv.args[0];
      if (inv.bool('patch')) {
        const r = await request(target, 'GET', `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/patch`);
        if (!r.ok) {
          process.stderr.write(r.body.endsWith('\n') ? r.body : r.body + '\n');
          process.exit(exitCodeForStatus(r.status));
        }
        process.stdout.write(r.body);
        return;
      }
      const data = await api(target, 'GET', `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`commit ${data.sha}`);
      console.log(`author ${data.author} <${data.email ?? ''}>`);
      console.log(`date   ${data.date}`);
      if ((data.parents as string[] | undefined)?.length) console.log(`parents ${(data.parents as string[]).join(' ')}`);
      console.log('');
      console.log(String(data.message ?? '').trimEnd());
    },
  },
  {
    path: ['diff'],
    summary: 'Compare two refs, as <base>...<head>',
    args: [{ name: 'range', required: true }],
    options: [
      { name: 'stat', type: 'boolean', summary: 'Only the counts and the commit list' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const range = inv.args[0];
      if (!range.includes('...')) throw new CliError("ask for a comparison as <base>...<head>", EXIT_USAGE);
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(repo)}/compare/${range}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      if (inv.bool('stat')) {
        console.log(`${data.ahead} ahead, ${data.behind} behind`);
        printTable(((data.commits ?? []) as Record<string, unknown>[]).map((c) => [String(c.sha).slice(0, 10), String(c.subject)]));
        return;
      }
      process.stdout.write(String(data.patch ?? ''));
    },
  },
  {
    path: ['search'],
    summary: 'Search a repository for literal text',
    args: [{ name: 'query', required: true }],
    options: [REF_OPTION, JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const query = refQuery(inv.str('ref'), { q: inv.args[0] });
      const data = await api(target, 'GET', `${repoPath(repo)}/search${query}`);
      const hits = (data.hits ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ ref: data.ref, query: data.query, hits: pickFields(hits, json.fields), truncated: data.truncated });
        return;
      }
      if (hits.length === 0) {
        console.log('No matches');
        return;
      }
      for (const h of hits) console.log(`${h.path}:${h.line}: ${String(h.text ?? '').trim()}`);
      if (data.truncated) console.error('(the server capped the results)');
    },
  },

  // ---- collaborators ----
  //
  // All three take the admin role on the repository, as the API routes behind
  // them do: who may see or write a repository is decided by the people who
  // administer it.
  {
    path: ['collab', 'list'],
    summary: "Show a repository's collaborators, and the owners standing over them",
    args: [{ name: 'repo' }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target, inv.args[0] ?? null);
      const data = await api(target, 'GET', `${repoPath(repo)}/collaborators`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${repo.collection}/${repo.repo} is ${data.private ? 'private' : 'public'}`);
      const collaborators = (data.collaborators ?? []) as { username: string; role: string }[];
      if (collaborators.length === 0) console.log('No collaborators.');
      else printTable(collaborators.map((c) => [c.username, c.role]));
      const owners = (data.owners ?? []) as string[];
      console.log(
        `Owners of ${repo.collection} hold the admin role without being listed: ` +
          `${[repo.collection, ...owners].join(', ')} (the first by bearing the collection's name).`
      );
    },
  },
  {
    path: ['collab', 'add'],
    summary: 'Give a user a role on a repository',
    description: `read may see a private repository; write may also push and edit; admin may also
change its settings, visibility, and collaborators. Adding a user who already
has a role replaces it.`,
    args: [
      { name: 'repo', required: true },
      { name: 'username', required: true },
    ],
    options: [
      { name: 'role', type: 'string', value: '<r>', summary: 'read, write (the default), or admin' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target, inv.args[0]);
      const data = await api(target, 'PUT', `${repoPath(repo)}/collaborators/${encodeURIComponent(inv.args[1])}`, {
        role: inv.str('role') ?? 'write',
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${data.username} now has the ${data.role} role on ${repo.collection}/${repo.repo}`);
    },
  },
  {
    path: ['collab', 'remove'],
    summary: "Remove a user's role on a repository",
    args: [
      { name: 'repo', required: true },
      { name: 'username', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target, inv.args[0]);
      const data = await api(target, 'DELETE', `${repoPath(repo)}/collaborators/${encodeURIComponent(inv.args[1])}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Removed ${data.removed} from ${repo.collection}/${repo.repo}`);
    },
  },
];
