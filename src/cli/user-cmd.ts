import { api } from '../cli-api';
import { naming } from '../naming';
import { isValidUserName } from '../scan';
import { CliError, EXIT_USAGE } from './exit';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, Invocation, OptionSpec } from './parse';
import { TARGET_OPTIONS, targetFrom } from './target';

// The commands about people: creating users and the site-admin bit, listing
// them, who the current token is, one user's standing, removing a user, and
// their tokens. They were split between src/index.ts and admin-cmd.ts and
// are registered from both places still, in the same order; they live here
// so that a sibling application built on these modules (see src/naming.ts),
// whose server answers the same routes (src/api/users.ts), can offer the same
// commands. What they say about the product takes its words from naming.

const YES_OPTION: OptionSpec = {
  name: 'yes',
  type: 'boolean',
  summary: 'Required: confirm that this cannot be undone',
};


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
        `where it applies. Use '${naming.product} collab add' for a ${naming.itemNoun}, '${naming.product} collection owner add' for a ` +
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
      `--vault is gone: user commands talk to a running server. Run \`${naming.product} login <url>\` first.`,
      EXIT_USAGE
    );
  }
}

export function formatStanding(user: { username?: string; name?: string; siteAdmin?: boolean }): string {
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
        `'${naming.product} collab add' and '${naming.product} collection owner add'.`,
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

/** user add, user grant, user list, and whoami, where src/index.ts lists them. */
export function userCommands(): Command[] {
  return [
  {
    path: ['user', 'add'],
    summary: 'Create a user and print its token once',
    description: `A user owns the collection named after them, the way a GitHub account owns its
namespace: they create ${naming.itemNounPlural} there and administer them. Anything more is
granted where it applies ('${naming.product} collab add' on a ${naming.itemNoun}, '${naming.product}
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
    description: `Per-${naming.itemNoun} access is granted on the ${naming.itemNoun} ('${naming.product} collab add') and
per-collection access on the collection ('${naming.product} collection owner add');
this command carries only the one bit that is the ${naming.rootNoun}'s own.`,
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
  ];
}

/** user view, user delete, and user token list and revoke, where admin-cmd.ts lists them. */
export function userAdminCommands(): Command[] {
  return [
  {
    path: ['user', 'view'],
    summary: "Show one user's standing and the tokens they hold",
    description: `Never a token, and never a token's hash: only a SHA-256 hash is stored, so there
is nothing to show even if it were a good idea. What comes back is the id
revocation takes, when the token was minted, and any scope of its own.`,
    args: [{ name: 'username', required: true }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', `/api/users/${encodeURIComponent(inv.args[0])}`);
      const tokens = (data.tokens ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${data.name} @ ${target.host}`);
      console.log(`  ${data.siteAdmin ? 'site admin' : `owns collection '${data.name}' by name`}`);
      console.log('');
      if (tokens.length === 0) {
        console.log('No tokens, so this user cannot sign in or push.');
        return;
      }
      printTable(
        tokens.map((t) => [
          String(t.id),
          shortDate(t.created as string) || '(unknown date)',
          t.scope ? `restricted to: ${(t.scope as string[]).join(', ')}` : '',
        ])
      );
    },
  },
  {
    path: ['user', 'delete'],
    summary: 'Remove a user and every token they hold',
    args: [{ name: 'username', required: true }],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      if (!inv.bool('yes')) throw new CliError('Removing a user cannot be undone. Pass --yes.', EXIT_USAGE);
      const name = inv.args[0];
      const target = await targetFrom(inv);
      const data = await api(target, 'DELETE', `/api/users/${encodeURIComponent(name)}?confirm=${encodeURIComponent(name)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Removed ${data.deleted}`);
    },
  },
  {
    path: ['user', 'token', 'list'],
    summary: "List a user's tokens, by the id revocation takes",
    args: [{ name: 'username', required: true }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', `/api/users/${encodeURIComponent(inv.args[0])}/tokens`);
      const tokens = (data.tokens ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ tokens: pickFields(tokens, json.fields) });
        return;
      }
      if (tokens.length === 0) {
        console.log('No tokens');
        return;
      }
      printTable(
        tokens.map((t) => [
          String(t.id),
          shortDate(t.created as string) || '(unknown date)',
          t.scope ? `restricted to: ${(t.scope as string[]).join(', ')}` : '',
        ])
      );
    },
  },
  {
    path: ['user', 'token', 'revoke'],
    summary: 'Revoke one token, leaving the user and their other tokens',
    description: `Revoking the token you are using is allowed and is reported rather than refused:
locking yourself out is your business, and ${naming.stateFile} remains hand-editable.`,
    args: [
      { name: 'username', required: true },
      { name: 'token-id', required: true },
    ],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      if (!inv.bool('yes')) throw new CliError('Revoking a token cannot be undone. Pass --yes.', EXIT_USAGE);
      const target = await targetFrom(inv);
      const data = await api(
        target,
        'DELETE',
        `/api/users/${encodeURIComponent(inv.args[0])}/tokens/${encodeURIComponent(inv.args[1])}`
      );
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Revoked ${data.revoked}; ${data.remaining} token${data.remaining === 1 ? '' : 's'} left.`);
      if (data.wasThisToken) console.log('That was the token this command authenticated with, so it will not work again.');
    },
  },
  ];
}
