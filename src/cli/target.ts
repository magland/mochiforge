import { RemoteTarget, remoteTarget } from '../cli-api';
import { naming } from '../naming';
import { CliError, EXIT_AUTH, EXIT_USAGE } from './exit';
import { readStdin } from './input';
import { Invocation, OptionSpec } from './parse';

// Which vault a command talks to, and with what token. Every command that
// reaches a vault takes the same three options, declared once here so that they
// are spelled and documented identically everywhere.

// The summaries read naming at module load, which is after a sibling
// application's branding module has run (it is that application's first
// import), and is simply the mochi defaults everywhere else.
export const TARGET_OPTIONS: OptionSpec[] = [
  {
    name: 'host',
    type: 'string',
    value: '<url>',
    summary: `${naming.rootNoun[0].toUpperCase()}${naming.rootNoun.slice(1)} URL, ahead of ${naming.envPrefix}_HOST and the last login`,
  },
  {
    name: 'token',
    type: 'string',
    value: '<t>',
    summary: `Token, ahead of ${naming.envPrefix}_TOKEN and git's credential store`,
  },
  {
    name: 'token-stdin',
    type: 'boolean',
    summary: 'Read the token from stdin, so it is in neither argv nor shell history',
  },
];

/**
 * The vault and token a command should use, from its options, the environment, or
 * the login.
 *
 * `opts.host` is a fallback a command can supply from state of its own, and sits
 * between the environment and the login: `mochi backup` records the vault a
 * backup directory is a backup of, and that has to outrank the last login,
 * because a machine that has since logged in to another vault must not quietly
 * start filling one backup directory from a different vault.
 */
export async function targetFrom(inv: Invocation, opts: { host?: string | null } = {}): Promise<RemoteTarget> {
  let token = inv.str('token');
  if (inv.bool('token-stdin')) {
    // Two ways of saying where the token comes from is a usage error, as every
    // other "not both" in the CLI is; an empty stdin below is not, because
    // there the invocation was fine and the token is what is missing.
    if (token) throw new CliError('Pass either --token or --token-stdin, not both.', EXIT_USAGE);
    token = (await readStdin()).trim();
    if (!token) throw new CliError('--token-stdin was given but stdin was empty.', EXIT_AUTH);
  }
  const host = inv.str('host') ?? process.env[`${naming.envPrefix}_HOST`]?.trim() ?? opts.host ?? null;
  return await remoteTarget({ host, token });
}
