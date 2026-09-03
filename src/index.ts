#!/usr/bin/env node
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  CredentialTarget,
  approveCredential,
  clearLogin,
  configuredHelper,
  credentialTarget,
  loadLogin,
  loginPath,
  readCredential,
  rejectCredential,
  saveLogin,
  setHelper,
} from './credentials';
import { api } from './cli-api';
import { apiCommand } from './cli/api-cmd';
import { issueCommands } from './cli/issue-cmd';
import { prCommands } from './cli/pr-cmd';
import { adminCommands } from './cli/admin-cmd';
import { backupCommands } from './cli/backup-cmd';
import { releaseCommands } from './cli/release-cmd';
import { repoCommands } from './cli/repo-cmd';
import { runCommands } from './cli/run-cmd';
import { CliError, EXIT_AUTH, EXIT_FAIL, EXIT_USAGE, jsonErrorsWanted } from './cli/exit';
import { readStdin } from './cli/input';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson } from './cli/output';
import { Cli, Command, Invocation, OptionSpec, dispatch, registryJson } from './cli/parse';
import { TARGET_OPTIONS, targetFrom } from './cli/target';
import { collectionAddCmd, collectionListCmd, forkCmd, importCmd } from './import-cli';
import { syncCommand } from './cli/sync-cmd';
import { deployDestroyCmd, deployFlyCmd, deployShowCmd } from './deploy-cli';
import {
  deployFlyRunnerCmd,
  deployFlyRunnerDestroyCmd,
  deployFlyRunnerShowCmd,
} from './deploy-runner-cli';
import { jobRunCmd } from './job-cli';
import {
  runnerAddCmd,
  runnerEditCmd,
  runnerListCommand,
  runnerRemoveCmd,
  runnerRunCmd,
  runnerWakeCmd,
} from './runner-cli';
import { seedTrustProxy } from './config';
import { isValidUserName } from './scan';
import { DEFAULT_THEME, themeNames } from './themes';
import { bootstrapVault } from './vault';

// The CLI's commands, as a registry rather than a chain of string comparisons
// with one help text covering all of them. See src/cli/parse.ts for why.

const FOOTER = `Configuration:
  mochi login https://vault.example.com   once, then the rest need no arguments

The vault URL is kept in ~/.config/mochi/login.json and the token in git's
own credential store. --host and --token override either for a single command,
and MOCHI_HOST and MOCHI_TOKEN sit between the two, for a caller with
no keyring and possibly no writable home directory.

Vault layout, where <repos> is <vault>/collections/<collection>/repos:
  <repos>/<repo>.git                 bare repositories (the .git suffix is optional)
  <repos>/<repo>.site                static site for a repo, served once enabled in its settings
  <repos>/<repo>.lfs                 Git LFS objects, when no bucket is configured
  <repos>/<repo>.runs                workflow run history and logs
  <vault>/vault.json                 users and hashed tokens (server-managed)
  <vault>/runners.json               registered runners (server-managed)
  <vault>/config.json                vault settings: theme, sites host, CI retention, limits
  <vault>/.secret                    session-cookie signing key (server-managed)

A vault laid out the older way, with collections directly in <vault>, is moved
to this one on the first start of a server that knows it.

Backing up a hosted vault:
  mochi backup ~/backups/myvault --snapshot   incremental, over HTTP; see docs/backup.md

Themes: ${themeNames().join(', ')} (default ${DEFAULT_THEME}). Pick one under
Admin > Appearance in the web interface, or write config.json by hand.`;

// ---- serve ----

async function serveCmd(args: string[], usage: () => never) {
  let dir: string | null = null;
  let port = 3000;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '-p' || a === '--port') port = parseInt(args[++i], 10);
    else if (a === '--host') host = args[++i];
    else if (a.startsWith('-')) throw new CliError(`Unknown option: ${a}`, EXIT_USAGE);
    else dir = a;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new CliError('Invalid port', EXIT_USAGE);
  const vault = path.resolve(dir ?? process.env.MOCHI_VAULT ?? '.');
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) {
    throw new CliError(`Vault directory does not exist: ${vault}`);
  }
  // A vault with no vault.json is initialized on first start. The owner token
  // is normally minted here and printed once; MOCHI_OWNER_TOKEN lets the
  // operator supply it instead, which is how `mochi deploy` hands a remote
  // vault a token it already holds. A supplied token is not printed: it is
  // already where it needs to be, and a hosted server's log is not a good
  // place to leave a copy.
  const boot = bootstrapVault(vault, process.env.MOCHI_OWNER_TOKEN ?? null);
  // Set by `mochi deploy fly`, which knows there is a TLS proxy in front but
  // cannot write to the volume before the vault exists. It only seeds the
  // setting; config.json remains the place it lives and can be edited by hand.
  const seeded = process.env.MOCHI_TRUST_PROXY === '1' ? seedTrustProxy(vault) : false;
  // Imported here rather than at the top of the file: the server pulls in express
  // and the whole rendering stack, which is most of what starting this process
  // costs, and no other command needs any of it. A CLI a person or an agent runs
  // in a loop should not pay for the server it is not starting.
  const { createApp } = await import('./server');
  const app = createApp(vault);
  // What one request cannot be allowed to do is take the vault down for
  // everyone else. Node's default for an uncaught exception or an unhandled
  // rejection is to exit, on the reasoning that the process may be left in
  // a state nothing can trust. That reasoning is weaker here than usual: the
  // process holds no state that matters -- the vault is on disk, written by
  // rename, and re-read on every request -- so what an escaped error has
  // corrupted is at most one response, which is already lost. So the error is
  // logged with its stack and the process goes on. Anything that recurs will
  // recur in the log, which is where an operator can find it; a crash would
  // have said the same thing once and then stopped serving.
  process.on('uncaughtException', (err) => {
    console.error('uncaught exception (the server continues):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection (the server continues):', reason);
  });
  app.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    if (boot && boot.preset) {
      console.log('');
      console.log('Initialized a new vault (no vault.json found).');
      console.log(`Owner '${boot.username}' was given the token from MOCHI_OWNER_TOKEN, so it is`);
      console.log('not repeated here; only its hash is stored.');
      console.log('');
    } else if (boot) {
      console.log('');
      console.log('Initialized a new vault (no vault.json found).');
      console.log(`Owner token for user '${boot.username}' (shown once; only its hash is stored):`);
      console.log('');
      console.log(`  ${boot.token}`);
      console.log('');
      console.log('Sign in on the web with it, or manage users from anywhere:');
      console.log(`  mochi login ${url}`);
      console.log('');
    }
    if (seeded) console.log('Recorded network.trustProxy: true in config.json (MOCHI_TRUST_PROXY is set).');
    console.log(`Mochi Forge serving vault ${vault}`);
    console.log(`  ${url}`);
  });
}

// ---- users ----

// Removed rather than renamed, and kept only to say so: glob scopes on users
// became roles held where they apply, so a --scope that silently became an
// unknown option would look like a typo rather than like a change of design.
const REMOVED_SCOPE_OPTIONS: OptionSpec[] = [
  { name: 'scope', type: 'string[]', hidden: true, summary: 'Removed: access is granted where it applies' },
  { name: 'admin', type: 'string[]', hidden: true, summary: 'Removed: see --site-admin and collection owners' },
];

function refuseScopeOptions(inv: Invocation): void {
  if (inv.list('scope').length || inv.list('admin').length) {
    throw new CliError(
      '--scope and --admin are gone: a user owns the collection named after them, and anything more is granted ' +
        "where it applies. Use 'mochi collab add' for a repository, 'mochi collection owner add' for a " +
        'collection, or --site-admin for everything.',
      EXIT_USAGE
    );
  }
}

// Removed rather than renamed, and kept only to say so: a `--vault` that
// silently became an unknown option would look like a typo rather than like a
// change of design.
const VAULT_OPTION: OptionSpec = {
  name: 'vault',
  type: 'string',
  hidden: true,
  summary: 'Removed: user commands talk to a running server',
};

function refuseVaultOption(inv: Invocation): void {
  if (inv.str('vault') !== null) {
    throw new CliError(
      '--vault is gone: user commands talk to a running server. Run `mochi login <url>` first.',
      EXIT_USAGE
    );
  }
}

function formatStanding(user: { username?: string; name?: string; siteAdmin?: boolean }): string {
  const name = user.username ?? user.name ?? '';
  return user.siteAdmin ? 'site admin' : `owns collection '${name}' by name`;
}

async function userAddCmd(inv: Invocation) {
  refuseVaultOption(inv);
  refuseScopeOptions(inv);
  const username = inv.args[0];
  if (!isValidUserName(username)) {
    throw new CliError(
      'A valid username is required (letters, digits, dot, underscore, dash, not starting with a dot)',
      EXIT_USAGE
    );
  }
  const tokenScope = inv.list('token-scope');
  const target = await targetFrom(inv);
  const data = await api(target, 'POST', '/api/users', {
    username,
    siteAdmin: inv.bool('site-admin') || undefined,
    tokenScope: tokenScope.length ? tokenScope : undefined,
  });
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(pickObject(data, json.fields));
    return;
  }
  console.log(
    data.created
      ? `Created user '${data.username}' on ${target.host}`
      : `Minted a new token for existing user '${data.username}'`
  );
  console.log(`  ${formatStanding(data as { username: string; siteAdmin?: boolean })}`);
  if (tokenScope.length) console.log(`  this token is restricted to: ${tokenScope.join(', ')}`);
  console.log('');
  console.log('Token (copy it now; only its hash is stored):');
  console.log(`  ${data.token}`);
  console.log('');
  console.log(`Use it as the password with username '${data.username}' when git asks for credentials.`);
}

async function userGrantCmd(inv: Invocation) {
  refuseVaultOption(inv);
  refuseScopeOptions(inv);
  const username = inv.args[0];
  const grant = inv.bool('site-admin');
  const revoke = inv.bool('revoke-site-admin');
  if (grant === revoke) {
    throw new CliError(
      `Pass exactly one of --site-admin or --revoke-site-admin. Repository and collection access is granted with ` +
        `'mochi collab add' and 'mochi collection owner add'.`,
      EXIT_USAGE
    );
  }
  const target = await targetFrom(inv);
  const data = await api(target, 'POST', `/api/users/${encodeURIComponent(username)}/grant`, {
    siteAdmin: grant,
  });
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(pickObject(data, json.fields));
    return;
  }
  console.log(`${data.username}: ${data.siteAdmin ? 'now a site admin' : 'no longer a site admin'}`);
}

async function userListCmd(inv: Invocation) {
  refuseVaultOption(inv);
  const target = await targetFrom(inv);
  const data = await api(target, 'GET', '/api/users');
  const users = (data.users ?? []) as { name: string; siteAdmin?: boolean; tokens: number }[];
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson({ users: pickFields(users as unknown as Record<string, unknown>[], json.fields) });
    return;
  }
  if (users.length === 0) {
    console.log(`No users on ${target.host}`);
    return;
  }
  const width = Math.max(...users.map((u) => u.name.length));
  for (const u of users) {
    const tokens = `${u.tokens} token${u.tokens === 1 ? '' : 's'}`;
    console.log(`${u.name.padEnd(width)}  ${tokens.padEnd(9)}  ${u.siteAdmin ? 'site admin' : ''}`.trimEnd());
  }
}

async function whoamiCmd(inv: Invocation) {
  const target = await targetFrom(inv);
  const data = await api(target, 'GET', '/api/whoami');
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(pickObject(data, json.fields));
    return;
  }
  console.log(`${data.username} @ ${target.host}`);
  console.log(`  ${formatStanding(data as { username: string; siteAdmin?: boolean })}`);
  const owned = (data.ownedCollections ?? []) as string[];
  if (owned.length) console.log(`  collections: ${owned.join(', ')}`);
  if (data.tokenScope) console.log(`  this token is restricted to: ${(data.tokenScope as string[]).join(', ')}`);
}

// ---- login and logout ----

// The vault being logged in to or out of: the URL given, the environment, or
// the one logged in to last, which is what makes `mochi logout` need no
// arguments.
function loginTarget(host: string | null): { host: string; target: CredentialTarget } {
  const resolved = (host ?? process.env.MOCHI_HOST ?? loadLogin()?.host ?? '').replace(/\/+$/, '');
  if (!resolved) throw new CliError('Which vault? Give its URL, e.g. https://vault.example.com', EXIT_USAGE);
  try {
    return { host: resolved, target: credentialTarget(resolved) };
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), EXIT_USAGE);
  }
}

// A token is a credential and a terminal keeps scrollback, so it is read
// without echo. Passing --token instead would leave it in shell history, and
// --token-stdin hands one over with no terminal at all.
// Raw mode rather than readline: readline redraws its line through cursor
// control that bypasses any echo suppression, which erases the prompt.
function promptToken(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error('No token given and no terminal to ask on. Pass --token <t> or --token-stdin.'));
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const finish = (err: Error | null) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    // Raw mode delivers ^C as a byte rather than as SIGINT, so cancelling has
    // to be handled here or it would be pasted into the token.
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(null);
        if (ch === '\u0003') return finish(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}

// login is the one command that reads a token without contacting a vault
// first, so it resolves --token and --token-stdin itself rather than through
// targetFrom.
async function tokenFor(inv: Invocation): Promise<string | null> {
  const flag = inv.str('token');
  if (inv.bool('token-stdin')) {
    if (flag) throw new CliError('Pass either --token or --token-stdin, not both.', EXIT_USAGE);
    const value = (await readStdin()).trim();
    // Empty stdin is 3 and not 2: the invocation was well formed, and what is
    // missing is the token, which is the case exit code 3 is documented to
    // cover. A pipeline whose token source came up empty gets the same code it
    // would get for having supplied no token at all.
    if (!value) throw new CliError('--token-stdin was given but stdin was empty.', EXIT_AUTH);
    return value;
  }
  return flag ?? process.env.MOCHI_TOKEN?.trim() ?? null;
}

async function loginCmd(inv: Invocation) {
  const { host, target } = loginTarget(inv.args[0] ?? inv.str('host'));

  // Settle where the token would go before asking for one: being prompted for
  // a token and only then told there is nowhere to put it is the wrong order.
  const chosen = inv.str('helper');
  if (chosen) await setHelper(target.url, chosen);
  const helper = await configuredHelper(target.url);
  if (!helper) {
    console.error(`No credential helper is configured for ${target.url}, so git has nowhere to keep a token.`);
    console.error('Storing one would silently do nothing, so this is refused rather than reported as success.');
    console.error('');
    console.error('Choose where the token should live and run login again:');
    console.error('  mochi login --helper store        a file at ~/.git-credentials, mode 0600, in plain text');
    console.error('  mochi login --helper cache        memory only, forgotten after 15 minutes');
    console.error('  mochi login --helper libsecret    the desktop keyring, on Linux');
    console.error('  mochi login --helper osxkeychain  the login keychain, on macOS');
    console.error('');
    console.error(`The choice is recorded for ${target.url} alone; other remotes keep whatever they use now.`);
    process.exit(EXIT_FAIL);
  }

  const given = await tokenFor(inv);
  const token = given ?? (await promptToken(`Token for ${target.url}: `));
  if (!token) throw new CliError('No token given.', EXIT_USAGE);

  // Verified before it is stored. A token that does not work is worse stored
  // than absent: git would then fail with it instead of asking for a better one.
  const who = await api({ host, token }, 'GET', '/api/whoami');
  const username = String(who.username ?? '');
  if (!username) throw new CliError(`${host} did not say who this token belongs to.`);

  await approveCredential(target, username, token);

  // Read back rather than trusting the exit code: approve succeeds whether or
  // not the helper kept anything, and a helper that is configured but not
  // installed fails only here.
  const stored = await readCredential(target);
  if (!stored || stored.username !== username || stored.password !== token) {
    console.error(`The credential helper '${helper}' did not keep the token for ${target.url}.`);
    console.error(`Check that git credential-${helper} is installed and working.`);
    process.exit(EXIT_FAIL);
  }

  // Recorded only now: a login that could not keep its token is not a login,
  // and pointing later commands at a vault they cannot reach would be worse
  // than pointing them nowhere.
  saveLogin(host);

  console.log(`Stored the token for '${username}' at ${target.url} (helper: ${helper}).`);
  console.log(`  ${formatStanding(who as { username: string; siteAdmin?: boolean })}`);
  if (who.tokenScope) console.log(`  this token is restricted to: ${(who.tokenScope as string[]).join(', ')}`);
  console.log('');
  console.log('git clone, fetch, push, and git lfs against this vault will no longer ask for a password,');
  console.log(`and mochi commands talk to it by default (${loginPath()}).`);
  console.log('Run `mochi logout` to remove it again.');
}

// ---- web ----

// Best effort and platform-shaped. The URL is printed first, so a machine
// with no opener, or an SSH session, still leaves the person one paste away.
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The link is already on the terminal.
  }
}

async function webCmd(inv: Invocation) {
  const target = await targetFrom(inv);
  const next = inv.args[0] ?? '/';
  const data = await api(target, 'POST', '/api/login-url', { next });
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(pickObject(data, json.fields));
    return;
  }
  console.log(`A one-time sign-in link for '${data.username}' at ${target.host}:`);
  console.log('');
  console.log(`  ${data.url}`);
  console.log('');
  console.log(`It works once, expires in ${data.expiresInSeconds} seconds, and asks before signing in.`);
  openBrowser(String(data.url));
}

async function logoutCmd(inv: Invocation) {
  if (inv.str('token') || inv.str('helper')) {
    throw new CliError('logout takes only --host: it removes a stored credential rather than making one.', EXIT_USAGE);
  }
  const { host, target } = loginTarget(inv.args[0] ?? inv.str('host'));
  const stored = await readCredential(target);
  if (!stored) {
    clearLogin(host);
    console.log(`No stored credential for ${target.url}.`);
    return;
  }
  await rejectCredential(target, stored.username);
  const after = await readCredential(target);
  if (after) {
    throw new CliError(
      `The credential for '${after.username}' at ${target.url} is still there: the helper did not erase it.`
    );
  }
  clearLogin(host);
  console.log(`Removed the stored credential for '${stored.username}' at ${target.url}.`);
}

// ---- the registry ----

/** A command whose own argument handling is left alone; it is dispatched and documented here all the same. */
function raw(
  path: string[],
  summary: string,
  description: string,
  run: (args: string[], usage: () => never) => void | Promise<void>
): Command {
  return {
    path,
    summary,
    description: description || undefined,
    raw: true,
    run: (inv) => run(inv.argv, () => inv.help()),
  };
}

const commands: Command[] = [
  raw(
    ['serve'],
    'Serve a vault over HTTP',
    `Serve a vault: a directory of collections containing bare git repositories.
The vault defaults to $MOCHI_VAULT, then the current directory. On the
first start with no vault.json, the server initializes one and prints an owner
token once.

Options:
  -p, --port <n>   port to listen on (default 3000)
  --host <h>       address to bind (default 127.0.0.1)`,
    serveCmd
  ),
  raw(
    ['import'],
    'Bring an existing repository into the vault',
    `Usage: mochi import <source> <collection>[/<name>] [--lfs]

Clone the source into a temporary directory, push it here, which creates it,
and remove the clone again. The source is an https or ssh git URL, owner/repo
for GitHub, or a directory on this machine; the name defaults to its last
segment. Nothing happens on the server, so the source is read with whatever git
credentials this machine already has. Branches and tags come across; --lfs
carries Git LFS objects too, and needs git-lfs installed.

A description is not part of a repository's git data. For a public GitHub
source it is read from GitHub's API afterwards and set here.

Options:
  --lfs                    carry Git LFS objects too
  --description <text>     set this description instead of the source's
  --no-description         leave the description empty`,
    importCmd
  ),
  raw(
    ['fork'],
    'Import a repository and remember where it came from',
    `Usage: mochi fork <source> <collection>[/<name>] [--lfs]

Everything mochi import does, plus the source URL is recorded as the
repository's upstream, which the repository header shows, mochi sync
fast-forwards from, and mochi pr export sends pull requests back to. The
source must be a URL (or owner/repo for GitHub): a local directory has no
upstream to record.

Options are those of mochi import.`,
    forkCmd
  ),
  syncCommand,
  raw(
    ['collection', 'add'],
    'Create an empty collection',
    `Pushing to a new path creates its collection on the way, so this is for the
other order: making the collection first and filling it afterwards.`,
    collectionAddCmd
  ),
  raw(
    ['collection', 'list'],
    "Show the vault's collections and how many repositories each holds",
    '',
    collectionListCmd
  ),
  {
    path: ['collection', 'owner', 'add'],
    summary: 'Make a user an owner of a collection',
    description: `Owners hold the admin role on every repository in the collection, may create
repositories in it, and manage the collection itself. The user the collection
is named after owns it by name and needs no entry.`,
    args: [
      { name: 'collection', required: true },
      { name: 'username', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(
        target,
        'PUT',
        `/api/collections/${encodeURIComponent(inv.args[0])}/owners/${encodeURIComponent(inv.args[1])}`
      );
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Owners of ${data.name}: ${((data.owners ?? []) as string[]).join(', ') || '(none listed)'}`);
    },
  },
  {
    path: ['collection', 'owner', 'remove'],
    summary: 'Remove a user from the owners of a collection',
    args: [
      { name: 'collection', required: true },
      { name: 'username', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(
        target,
        'DELETE',
        `/api/collections/${encodeURIComponent(inv.args[0])}/owners/${encodeURIComponent(inv.args[1])}`
      );
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Owners of ${data.name}: ${((data.owners ?? []) as string[]).join(', ') || '(none listed)'}`);
    },
  },
  {
    path: ['user', 'add'],
    summary: 'Create a user and print its token once',
    description: `A user owns the collection named after them, the way a GitHub account owns its
namespace: they create repositories there and administer them. Anything more is
granted where it applies ('mochi collab add' on a repository, 'mochi
collection owner add' on a collection) or with --site-admin. Run again on an
existing user to mint an additional token. Only a SHA-256 hash of a token is
ever stored, so the token is shown once and cannot be recovered afterwards.`,
    args: [{ name: 'username', required: true }],
    options: [
      { name: 'site-admin', type: 'boolean', summary: 'Admin role everywhere, plus users, runners, and settings' },
      { name: 'token-scope', type: 'string[]', value: '<glob>', summary: 'Restrict this token alone to these globs' },
      ...REMOVED_SCOPE_OPTIONS,
      VAULT_OPTION,
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    run: userAddCmd,
  },
  {
    path: ['user', 'grant'],
    summary: 'Grant or withdraw the site-admin bit',
    description: `Per-repository access is granted on the repository ('mochi collab add') and
per-collection access on the collection ('mochi collection owner add');
this command carries only the one bit that is the vault's own.`,
    args: [{ name: 'username', required: true }],
    options: [
      { name: 'site-admin', type: 'boolean', summary: 'Make this user a site admin' },
      { name: 'revoke-site-admin', type: 'boolean', summary: 'Withdraw the site-admin bit' },
      ...REMOVED_SCOPE_OPTIONS,
      VAULT_OPTION,
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    run: userGrantCmd,
  },
  {
    path: ['user', 'list'],
    summary: 'Show users, who is a site admin, and how many tokens each has',
    options: [VAULT_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    run: userListCmd,
  },
  {
    path: ['whoami'],
    summary: 'Show the user, their standing, and the token restriction for the current token',
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    run: whoamiCmd,
  },
  {
    path: ['login'],
    summary: 'Log in to a vault and hand the token to git',
    description: `Ask for a token, check it, and hand it to git's credential store, so that clone,
fetch, push, git lfs, and every other mochi command stop asking for it. The
vault URL is remembered, so later commands need no arguments. The token is read
back after storing to confirm it was really kept.

--helper picks where it lives (store, cache, libsecret, osxkeychain) and is
recorded for this vault's host alone; without it, whatever git is already
configured to use for that host is used, and login refuses rather than storing
nothing when that is nothing.`,
    args: [{ name: 'vault-url' }],
    options: [
      {
        name: 'helper',
        type: 'string',
        value: '<name>',
        summary: 'Where the token lives: store, cache, libsecret, osxkeychain',
      },
      ...TARGET_OPTIONS,
    ],
    run: loginCmd,
  },
  {
    path: ['web'],
    summary: 'Open the vault in a browser, signed in as you',
    description: `Mints a one-time sign-in link from the stored token and opens it in the
default browser (the link is printed too, for machines without one). The link
lands on a page that names the account and signs in on a click; it works once
and expires after two minutes. The browser session is bound to the same token
this CLI holds, so revoking that token signs the browser out as well.

An optional path says where to land: mochi web /alice/myrepo`,
    args: [{ name: 'path' }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    run: webCmd,
  },
  {
    path: ['logout'],
    summary: "Remove this vault's stored credential and forget the vault",
    args: [{ name: 'vault-url' }],
    options: [
      { name: 'helper', type: 'string', value: '<name>', hidden: true, summary: 'Not accepted by logout' },
      ...TARGET_OPTIONS,
    ],
    run: logoutCmd,
  },
  raw(
    ['deploy', 'fly'],
    'Put a vault on Fly.io, or deploy an update to one',
    `Usage: mochi deploy fly <app> [--region <r>] [--volume <gb>] [--vm-size <s>]
                            [--vm-memory <m>] [--lfs-bucket] [--org <o>]
                            [--image <ref> | --from-source [--local-build]]

Needs flyctl installed, and fly auth login done. The app name is globally
unique on Fly and becomes the URL, https://<app>.fly.dev. Creating one mints
the owner token here and hands it to the server as a secret, then prints it once
the vault answers, with how to sign in on the web and how to store it for the
CLI and git. Nothing is kept on this machine: mochi login with that token is
what does that. Run it again to deploy a new version; settings not named by a
flag keep whatever the live app has, so a single flag changes a single thing. A
vault is a directory on one volume, so the app runs as exactly one machine: a
busier vault wants a bigger one, not more.

By default the image deployed is the published one for this CLI's own version.
--from-source builds it from the checkout you are running instead, which is how
to deploy a change before it has been released; --local-build uses this machine's
Docker rather than Fly's builder. --image <ref> deploys some other published tag.

See also: mochi deploy fly show <app>, mochi deploy fly destroy <app>.
`,
    deployFlyCmd
  ),
  raw(
    ['deploy', 'fly', 'runner'],
    'Put a workflow runner on Fly.io, which stops when idle',
    `Usage: mochi deploy fly runner <app> [--allow <glob>...] [--labels <l,...>]
                                   [--job-timeout <45m>] [--idle <5m>]
                                   [--region <r>] [--volume <gb>]
                                   [--vm-size <s>] [--vm-memory <m>] [--org <o>]
                                   [--image <ref> | --from-source [--local-build]]
                                   [--image-only]

Needs flyctl, and a login to the vault this runner will serve. Registers the
runner (named after the app unless --name says otherwise), creates the app and a
volume for the images jobs run in, hands the machine the vault URL and its token
as Fly secrets, and tells the vault where to send a wake request.

The machine stops when no job has arrived for --idle, and the vault starts it
again when one is queued, so a stopped machine is the resting state rather than
a fault. The first job after a stop waits about half a minute for the boot. What
it costs while stopped is the volume alone.

--allow is required the first time and says which repositories this runner may
take jobs for; it executes whatever their workflows contain, on this machine.
Run the same command again to deploy a new version.

--job-timeout is the longest a single job may run on the machine, 20 minutes by
default, which on hardware billed by the minute is the bound worth setting: it
caps what a workflow's own timeout-minutes may ask for.

--image-only moves an already-deployed runner to a new image and touches
nothing else: no registration, no token, no wake rewrite, so it needs flyctl
and no vault login. A runner and the vault it serves speak one protocol, so
the pipeline that redeploys the vault should redeploy the runner beside it,
and this flag is what lets a job holding only a Fly credential do that.

See also: mochi deploy fly runner show <app>, destroy <app>, mochi runner list.
`,
    deployFlyRunnerCmd
  ),
  raw(
    ['deploy', 'fly', 'runner', 'show'],
    'What Fly has for this runner app, and which runner it serves',
    '',
    deployFlyRunnerShowCmd
  ),
  raw(
    ['deploy', 'fly', 'runner', 'destroy'],
    'Destroy the runner app, and offer to remove its registration',
    'No undo, though a runner keeps nothing that matters. Pass --yes to skip the confirmation.',
    deployFlyRunnerDestroyCmd
  ),
  raw(['deploy', 'fly', 'show'], 'What Fly has for this app, and whether the vault answers', '', deployShowCmd),
  raw(
    ['deploy', 'fly', 'destroy'],
    'Destroy the app and its volume, and with them the vault',
    'No undo. Pass --yes to skip the confirmation.',
    deployDestroyCmd
  ),
  raw(
    ['runner', 'add'],
    'Register a machine that will execute workflow jobs',
    `Usage: mochi runner add <name> --allow <glob>... [--labels <l,...>]
                        [--job-timeout <45m>] [--save]

Prints its token once. --allow says which repositories it may take jobs for, as
globs over collection/repo; you must own every collection they name (a site admin may name any). Jobs never run on
the vault's machine, so a vault with no runner queues its runs and waits.

--job-timeout is the longest a single job may run on this machine, 20 minutes by
default and stated in minutes or as a duration like 2h. It is a ceiling on what
a job's own timeout-minutes may ask for, not a default it can override; change
it later with mochi runner edit.`,
    runnerAddCmd
  ),
  raw(
    ['runner', 'edit'],
    "Change a registered runner's job timeout",
    `Usage: mochi runner edit <name> --job-timeout <45m|default>

The longest a single job may run on that machine. A job asking for less with
timeout-minutes keeps what it asked for; one asking for more, or asking for
nothing, is held to this. --job-timeout default puts the runner back on the
vault's own default of 20 minutes.

Applies to the next job the runner takes: one already running keeps the timeout
it was handed with the job.`,
    runnerEditCmd
  ),
  raw(
    ['runner', 'run'],
    'Take jobs and run them, one at a time, each in a Docker container',
    `Usage: mochi runner run [--host <url>] [--runner-token <t>] [--labels <l,...>]

Reads ~/.config/mochi/runner.json when given no arguments. Needs a working
docker or podman command; --engine picks one when both are present (asked
interactively otherwise), and --image <label>=<image> overrides which image a
runs-on label maps to. Actions named by uses: are fetched from github.com (--actions-url
changes that) and cached under ~/.cache/mochi (--cache-dir changes that),
keyed by the commit the ref resolves to, so a moved branch or tag is picked up
on the next run; --no-action-cache downloads every time. --work-dir sets where
job workspaces are made, --network which Docker network the container joins,
and MOCHI_RUNNER_TOKEN supplies the token instead of --runner-token.

Each job runs in a container of its own, held to --job-pids <4096> processes
(0 for no limit) and, when given, --job-memory <2g> and --job-cpus <2>, as
docker run takes them. A job over the process limit cannot fork; one over the
memory limit is killed. There is no default for memory or CPU, since the right
figure is the machine's to decide.

--idle <5m> stops the runner when no job has arrived for that long, which is
what makes a runner that costs money while it is up affordable: it exits, and
whatever hosts it stops. Something then has to start it again, so --wake-port
listens for the vault's wake request and --wake-secret (or MOCHI_WAKE_SECRET)
is what that request must present. See mochi runner wake.`,
    runnerRunCmd
  ),
  runnerListCommand,
  raw(
    ['runner', 'wake'],
    'Start a runner that stops when idle, or say where to reach it',
    `Usage: mochi runner wake <name> [--url <url> [--wake-secret <s>]] [--clear]

With no flags this sends the wake request now and reports how long the runner
took to answer, which is the way to test one without queuing a job. --url says
where to send it, generating the secret unless --wake-secret gives one; --clear
removes the address, after which nothing starts this runner.

The vault sends this by itself whenever a job is queued that a runner could take
and that runner has not been heard from, at most once a minute per runner
however many jobs are waiting.`,
    runnerWakeCmd
  ),
  raw(['runner', 'remove'], 'Remove a registered runner', '', runnerRemoveCmd),
  raw(
    ['job', 'run'],
    "Run a workflow run's manual jobs here, from a command minted on its run page",
    `Usage: mochi job run <vault-url> <token> [--job <pattern>] [--yes]
                     [--engine docker|podman] [--image <label>=<image>]

The run page of a run with 'runs-on: manual' jobs mints this command, token and
all (also: mochi run exec-command <n>). The token must be pasted within fifteen
minutes and works once: redeeming it starts a session that lives until the run
finishes, and a copy left in scrollback buys nothing afterwards.

Each job is shown step by step and nothing executes until you agree; --yes skips
the asking, and is required when there is no terminal to ask on. --job limits the
session to jobs matching a glob over the job key. Jobs execute in containers
exactly as on a registered runner: --engine picks docker or podman when both are
present (asked interactively otherwise), and --image, --work-dir, --network,
--cache-dir, --actions-url, --no-action-cache mean what they mean for
mochi runner run.

Exits 0 when everything it ran succeeded, 1 when something failed. Ctrl-C
finishes the job in hand and stops; a second Ctrl-C quits now, and the vault
fails the abandoned job when its lease expires.`,
    jobRunCmd
  ),
  ...repoCommands,
  ...issueCommands,
  ...prCommands,
  ...runCommands,
  ...releaseCommands,
  ...adminCommands,
  ...backupCommands,
  apiCommand,
  {
    path: ['commands'],
    summary: 'List every command, its arguments, and its options',
    description: `With --json this is the whole registry as data, which is enough to discover the
command set without reading any documentation.`,
    options: [JSON_OPTION],
    run: (inv) => {
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(registryJson(cli));
        return;
      }
      for (const c of cli.commands) console.log(`${c.path.join(' ').padEnd(24)}  ${c.summary}`);
    },
  },
];

const cli: Cli = {
  name: 'mochi',
  groups: [
    { name: 'repo', summary: 'Repositories: what the vault holds' },
    { name: 'branch', summary: 'Branches' },
    { name: 'tag', summary: 'Tags' },
    { name: 'file', summary: 'Files in a repository, at a ref' },
    { name: 'commit', summary: 'Commits and their patches' },
    { name: 'issue', summary: 'Issues' },
    { name: 'pr', summary: 'Pull requests' },
    { name: 'workflow', summary: 'Workflow files, and dispatching them by hand' },
    { name: 'run', summary: 'Workflow runs, their logs, and their artifacts' },
    { name: 'release', summary: 'Release notes attached to a tag' },
    { name: 'config', summary: "The vault's own settings" },
    { name: 'collection', summary: 'Collections: the directories a vault holds repositories in' },
    { name: 'user', summary: 'Users, their scopes, and their tokens' },
    { name: 'deploy', summary: 'Put a vault on Fly.io and manage it there' },
    { name: 'runner', summary: 'Machines that execute workflow jobs' },
    { name: 'job', summary: 'Run manual workflow jobs from a pasted command' },
  ],
  commands,
  footer: FOOTER,
};

async function main() {
  await dispatch(cli, process.argv.slice(2));
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  // A caller that asked for JSON gets JSON on failure too, so that parsing
  // stderr is possible rather than nearly possible.
  if (jsonErrorsWanted()) process.stderr.write(JSON.stringify({ error: message }) + '\n');
  else console.error(message);
  process.exit(e instanceof CliError ? e.code : EXIT_FAIL);
});
