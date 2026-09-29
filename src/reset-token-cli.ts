import * as fs from 'fs';
import * as path from 'path';
import { CliError, EXIT_USAGE } from './cli/exit';
import { naming } from './naming';
import { resetUserToken, vaultFilePath } from './vault';

// `mochi reset-token`: the way back in for the operator of a vault whose owner
// token is lost. Every other command that mints a token talks to a running
// server and needs a credential to do it, which is exactly what is missing
// here. This one edits vault.json on disk instead, the way `serve` initializes
// it, so the credential it asks for is access to the directory. On a machine
// you have a shell on that is the directory itself; on Fly it is `fly ssh`,
// which `deploy fly reset-token` drives.
//
// It runs beside a live server without stopping it. The edit takes the same
// lock the server's own edits take, and the server rereads vault.json on every
// request, so the new token works on the next one.

/** The help text, in the naming of whichever application registers the command. */
export function resetTokenHelp(): string {
  const product = naming.product;
  const noun = naming.rootNoun;
  const env = `${naming.envPrefix}_${noun.toUpperCase()}`;
  return `Usage: ${product} reset-token [<${noun}>] [--user <name>] [--revoke-others] [--json]

Give a user of a ${noun} on this machine a new token, by editing its state file
directly rather than through the server. This is for when every other way in is
gone: the owner's token lost, and no signed-in browser or other administrator
left to mint a new one. The ${noun} defaults to $${env}, then the current
directory. The server can keep running: it rereads the file on every request.

The new token is printed once and only its hash is stored. The user's other
tokens keep working unless --revoke-others is given, which also ends every
session started with them.

Run it as the user the server runs as. The file is rewritten readable by its
writer alone, so a copy written by root would lock the server out; this refuses
rather than do that. For a ${noun} on Fly, ${product} deploy fly reset-token <app> does
all of this from your own machine.

Options:
  --user <name>          whose token to reset (default: owner)
  --revoke-others        revoke the user's existing tokens
  --token-hash <sha256>  store this hash rather than minting a token here, so the
                         token itself never reaches this machine
  --json                 print the result as JSON`;
}

export function resetTokenCmd(args: string[], usage: () => never): void {
  let dir: string | null = null;
  let username = 'owner';
  let revokeOthers = false;
  let hash: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--user' || a === '--token-hash') {
      const v = args[++i];
      if (v === undefined || v.startsWith('-')) throw new CliError(`${a} takes a value`, EXIT_USAGE);
      if (a === '--user') username = v;
      else hash = v;
    } else if (a === '--revoke-others') revokeOthers = true;
    else if (a === '--json') json = true;
    else if (a.startsWith('-')) throw new CliError(`Unknown option: ${a}`, EXIT_USAGE);
    else if (dir === null) dir = a;
    else throw new CliError(`Unexpected argument: ${a}`, EXIT_USAGE);
  }
  const noun = naming.rootNoun;
  const root = path.resolve(dir ?? process.env[`${naming.envPrefix}_${noun.toUpperCase()}`] ?? '.');
  const file = vaultFilePath(root);
  if (!fs.existsSync(file)) {
    throw new CliError(`No ${naming.stateFile} in ${root}, so there is no ${noun} there to reset a token in.`);
  }

  // The file is written mode 600, so whoever writes it is the only one who can
  // read it afterwards. On Fly, `fly ssh console` logs in as root while the
  // server runs as node, and a reset done as root would leave a vault whose
  // server can no longer read its own users: every sign-in refused, the new
  // token included. Refusing here is cheaper than explaining that afterwards.
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const owner = fs.statSync(file).uid;
  if (euid !== null && euid !== owner) {
    throw new CliError(
      `${naming.stateFile} belongs to uid ${owner}, and this is running as uid ${euid}. The file is rewritten ` +
        `readable by its writer alone, so a server running as uid ${owner} could no longer read it. Run this ` +
        `as that user instead (on Fly: fly ssh console -u node).`
    );
  }

  let result: ReturnType<typeof resetUserToken>;
  try {
    result = resetUserToken(root, username, { hash, revokeOthers });
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }

  if (json) {
    console.log(
      JSON.stringify({
        username,
        ...(result.token ? { token: result.token } : {}),
        id: result.id,
        revoked: result.revoked,
        kept: result.kept,
      })
    );
    return;
  }
  if (result.token) {
    console.log(`New token for '${username}' in ${root} (shown once; only its hash is stored):`);
    console.log('');
    console.log(`  ${result.token}`);
  } else {
    console.log(`Stored the given token hash for '${username}' in ${root}.`);
  }
  console.log('');
  if (result.revoked.length) {
    console.log(`Revoked its other tokens (${result.revoked.join(', ')}); sessions started with them end on their`);
    console.log('next request.');
  } else if (result.kept.length) {
    const n = result.kept.length;
    console.log(`Its ${n} other token${n === 1 ? '' : 's'} (${result.kept.join(', ')}) still work${n === 1 ? 's' : ''}. If a lost one may`);
    console.log('have been found by someone else, run this again with --revoke-others.');
  }
  console.log(`The server needs no restart; the token works on its next request.`);
}
