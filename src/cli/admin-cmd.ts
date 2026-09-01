import { api } from '../cli-api';
import { CliError, EXIT_USAGE } from './exit';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, OptionSpec } from './parse';
import { TARGET_OPTIONS, targetFrom } from './target';

// The rest of administration: reading and removing users, listing and revoking
// their tokens, removing an empty collection, and the vault's own settings.

const YES_OPTION: OptionSpec = {
  name: 'yes',
  type: 'boolean',
  summary: 'Required: confirm that this cannot be undone',
};

export const adminCommands: Command[] = [
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
locking yourself out is your business, and vault.json remains hand-editable.`,
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
  {
    path: ['collection', 'rename'],
    summary: 'Rename a collection, with every repository in it',
    description: `Everything the collection holds moves with it: the repositories, their issues,
pull requests, releases, sites, run histories, and LFS objects. Requests for
the old address are redirected to the new one, so links and existing clones
keep working, until something else is created under that name. Token scopes
naming the old collection are the exception: they cover nothing afterwards and
have to be granted again under the new name.

Takes ownership of the collection; the owners travel with it. No --yes: a
rename is undone by renaming back.`,
    args: [
      { name: 'name', required: true },
      { name: 'new-name', required: true },
    ],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'POST', `/api/collections/${encodeURIComponent(inv.args[0])}/rename`, {
        name: inv.args[1],
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      // A rename to the name it already has is a success with nothing done,
      // which the API answers as changed:false rather than as an error.
      if (data.changed === false) {
        console.log(String(data.message ?? 'Nothing changed.'));
        return;
      }
      const repos = Number(data.repos ?? 0);
      console.log(`Now ${data.name}, with ${repos} ${repos === 1 ? 'repository' : 'repositories'} in it`);
      console.log('Remotes pointing at the old name, and token scopes naming it, need changing.');
    },
  },
  {
    path: ['collection', 'edit'],
    summary: "Change a collection's site alias",
    description: `The alias is the label that stands in for the collection's name in each of its
repositories' site hostnames, <repo>--<alias>.<sites host>. Empty means the
collection's own name where that name is usable as a hostname label, and the
name rewritten as one otherwise (simulated_instruments becomes
simulated-instruments), the rewrite being skipped when another collection
already holds the label it would produce.

Takes ownership of the collection. An alias another collection is already
reached by is refused, naming it. Changing the alias moves every site in the
collection to a new origin, and the hostnames they had stop resolving.`,
    args: [{ name: 'name', required: true }],
    options: [
      { name: 'site-alias', type: 'string', value: '<l>', summary: "Alias under the sites host; '' for the default" },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const alias = inv.str('site-alias');
      if (alias === null) throw new CliError('Nothing to change. Pass --site-alias.', EXIT_USAGE);
      const target = await targetFrom(inv);
      const data = await api(target, 'PATCH', `/api/collections/${encodeURIComponent(inv.args[0])}`, {
        siteAlias: alias,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(
        data.alias
          ? `Sites in ${data.name} are served under <repo>--${data.alias}`
          : `${data.name} has no site alias, so nothing in it has a derived hostname`
      );
    },
  },
  {
    path: ['collection', 'delete'],
    summary: 'Remove an empty collection',
    description: `Only an empty collection: one holding any repository is refused rather than
emptied. The collection's own owners list goes with it.`,
    args: [{ name: 'name', required: true }],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      if (!inv.bool('yes')) throw new CliError('Removing a collection cannot be undone. Pass --yes.', EXIT_USAGE);
      const target = await targetFrom(inv);
      const data = await api(target, 'DELETE', `/api/collections/${encodeURIComponent(inv.args[0])}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Removed ${data.deleted}`);
    },
  },
  {
    path: ['config', 'view'],
    summary: "Show the vault's settings",
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', '/api/config');
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      const ci = (data.ci ?? {}) as Record<string, unknown>;
      const sites = (data.sites ?? {}) as Record<string, unknown>;
      const network = (data.network ?? {}) as Record<string, unknown>;
      const limits = (data.limits ?? {}) as Record<string, unknown>;
      printTable([
        ['theme', String(data.theme)],
        ['ci.runs', String(ci.runs)],
        ['ci.days', String(ci.days)],
        ['ci.artifactMb', String(ci.artifactMb)],
        ['sites.host', String(sites.host || '(none; sites are sandboxed on the forge host)')],
        ['network.trustProxy', String(network.trustProxy)],
        ['limits.requestsPerMinute', String(limits.requestsPerMinute)],
        ['limits.authFailures', String(limits.authFailures)],
        [
          'limits.egressGbPerDay',
          Number(limits.egressGbPerDay) > 0 ? String(limits.egressGbPerDay) : '0 (no daily limit on outgoing bytes)',
        ],
      ]);
      console.log('');
      console.log(`themes: ${(data.themes as string[]).join(', ')}`);
      // Saying which of these a write can reach saves a caller discovering it by
      // being refused.
      console.log('theme, ci, sites.host, and limits.egressGbPerDay can be set with `mochi config set`.');
      console.log('network and the rest of limits are read once at startup: edit config.json in the vault and restart.');
      console.log('`mochi api /api/egress` shows what has gone out today, per repository.');
    },
  },
  {
    path: ['config', 'set'],
    summary: 'Change the theme, the sites hostname, or the CI retention settings',
    description: `Writes config.json in the vault, so a hosted vault is configured the same way as
one on your desk and there is no reason to reach its disk by hand.

--sites-host gives each repository's static site an origin of its own at
<repo>--<collection>.<host>, in place of the sandbox they are served under on the
vault's own hostname. Set it only once that hostname resolves to this vault and a
wildcard certificate covers it, since sites stop being served anywhere else the
moment it is set. --sites-host '' puts them back.

--egress-gb-per-day caps the bytes the vault may send in one UTC day, over
everything. Once a day's total reaches it, ordinary requests are refused with a
503 until 00:00 UTC; administration and signing in keep working, so the cap can
be raised from the vault itself. 0 sends without a limit. It is read per request,
so a change is in force immediately.

network.trustProxy and the rest of the limits block are not here. They are read
once when the server starts, so a command that changed them would report a change
the running server had not made. Edit config.json in the vault and restart.`,
    options: [
      { name: 'theme', type: 'string', value: '<t>', summary: 'Theme name' },
      {
        name: 'sites-host',
        type: 'string',
        value: '<host>',
        summary: "Hostname whose subdomains serve sites; '' to serve them sandboxed on the forge host",
      },
      { name: 'ci-runs', type: 'int', value: '<n>', summary: 'Completed runs to keep per repository' },
      { name: 'ci-days', type: 'int', value: '<n>', summary: 'Also drop runs older than this; 0 disables' },
      { name: 'ci-artifact-mb', type: 'int', value: '<n>', summary: 'Largest artifact a job may upload' },
      {
        name: 'egress-gb-per-day',
        type: 'string',
        value: '<gb>',
        summary: 'Gigabytes the vault may send per UTC day; 0 for no limit',
      },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const theme = inv.str('theme');
      // An empty string is a value here rather than an absence: it is how the
      // sites hostname is cleared, and str() returns null only when the option
      // was not given at all.
      const sitesHost = inv.str('sites-host');
      const runs = inv.int('ci-runs');
      const days = inv.int('ci-days');
      const artifactMb = inv.int('ci-artifact-mb');
      // Taken as a string and parsed here rather than declared as an int: half a
      // gigabyte is a reasonable budget to give a vault, and the option parser
      // has no float type.
      const egressRaw = inv.str('egress-gb-per-day');
      let egressGbPerDay: number | null = null;
      if (egressRaw !== null) {
        const gb = Number(egressRaw.trim());
        if (egressRaw.trim() === '' || !Number.isFinite(gb) || gb < 0) {
          throw new CliError('--egress-gb-per-day takes a number of gigabytes, or 0 for no limit.', EXIT_USAGE);
        }
        egressGbPerDay = gb;
      }
      if (
        theme === null &&
        sitesHost === null &&
        runs === null &&
        days === null &&
        artifactMb === null &&
        egressGbPerDay === null
      ) {
        throw new CliError(
          'Nothing to change. Pass --theme, --sites-host, --ci-runs, --ci-days, --ci-artifact-mb, or --egress-gb-per-day.',
          EXIT_USAGE
        );
      }
      const target = await targetFrom(inv);
      // The CI block is written whole, so the fields not named have to come from
      // what is there now rather than from a default.
      let ci: Record<string, number> | undefined;
      if (runs !== null || days !== null || artifactMb !== null) {
        const current = (await api(target, 'GET', '/api/config')).ci as Record<string, number>;
        ci = {
          runs: runs ?? current.runs,
          days: days ?? current.days,
          artifactMb: artifactMb ?? current.artifactMb,
        };
      }
      const data = await api(target, 'PATCH', '/api/config', {
        theme: theme ?? undefined,
        ci,
        sites: sitesHost === null ? undefined : { host: sitesHost },
        // The route merges this into the block it is part of, since the rest of
        // it is not writable from here.
        limits: egressGbPerDay === null ? undefined : { egressGbPerDay },
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`theme: ${data.theme}`);
      const saved = data.ci as Record<string, unknown>;
      console.log(`ci: keep ${saved.runs} runs, ${saved.days} days, artifacts up to ${saved.artifactMb} MB`);
      const host = String(((data.sites ?? {}) as Record<string, unknown>).host ?? '');
      console.log(
        host
          ? `sites: served from <repo>--<collection>.${host}`
          : "sites: served sandboxed on the vault's own hostname"
      );
      // Every reader of this setting calls loadConfig per request, so there is
      // nothing further to do; saying so is worth a line, because the settings
      // next to it in the same file do need a restart.
      const gb = Number(((data.limits ?? {}) as Record<string, unknown>).egressGbPerDay ?? 0);
      console.log(gb > 0 ? `egress: up to ${gb} GB per UTC day` : 'egress: no daily limit');
      if (sitesHost !== null || egressGbPerDay !== null) console.log('In effect now; no restart needed.');
    },
  },
];
