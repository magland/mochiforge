import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { naming } from './naming';

// The client side of authentication. A token is the password git sends over
// Basic auth, so the place to keep it is git's own credential store: clone,
// fetch, push, and git-lfs all read credentials through the same `git
// credential` plumbing, and storing it once there stops every one of them from
// asking again. Nothing here is vault state. The server never learns that a
// credential was stored, and `git credential reject` undoes it.

export class CredentialError extends Error {}

export interface CredentialTarget {
  protocol: string;
  host: string;
  url: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Unlike execGit in git.ts, these commands are not about a repository, and a
// non-zero exit is frequently the answer rather than a failure: `git config
// --get-urlmatch` exits 1 when nothing matches, and `git credential fill`
// exits non-zero when it has nothing to give. So this reports the exit code
// instead of throwing on it.
function git(args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { env: opts.env ?? process.env, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT') {
          reject(new CredentialError('git is not on PATH, so there is nowhere to store a credential'));
          return;
        }
        resolve({ code: typeof code === 'number' ? code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      }
    );
    if (child.stdin) {
      if (opts.input !== undefined) child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

// git keys credentials by protocol and host, the port included. The path plays
// no part unless credential.useHttpPath is set, so a vault served under a
// subpath is still one credential for the whole vault.
export function credentialTarget(hostUrl: string): CredentialTarget {
  let u: URL;
  try {
    u = new URL(hostUrl);
  } catch {
    throw new CredentialError(`Not a URL: ${hostUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new CredentialError(`${hostUrl} is not an http or https URL`);
  }
  const protocol = u.protocol.slice(0, -1);
  return { protocol, host: u.host, url: `${protocol}://${u.host}` };
}

// The credential description git reads on stdin: key=value lines, then a blank
// line. A newline inside a value would let it forge further fields, so values
// carrying one are refused rather than written.
function describe(target: CredentialTarget, fields: Record<string, string>): string {
  const lines = [`protocol=${target.protocol}`, `host=${target.host}`];
  for (const [key, value] of Object.entries(fields)) {
    if (/[\n\r\0]/.test(value)) throw new CredentialError(`${key} contains a line break`);
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n') + '\n\n';
}

function parseCredential(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// What git would actually use for this host, taking both credential.helper and
// any URL-scoped credential.<url>.helper into account. Null means none, which
// matters more than it looks: `git credential approve` with no helper
// configured succeeds and stores nothing at all.
export async function configuredHelper(url: string): Promise<string | null> {
  const r = await git(['config', '--get-urlmatch', 'credential.helper', url]);
  const value = r.stdout.trim();
  return r.code === 0 && value !== '' ? value : null;
}

// Recorded for this URL alone, so other remotes keep whatever they use now.
export async function setHelper(url: string, helper: string): Promise<void> {
  const r = await git(['config', '--global', `credential.${url}.helper`, helper]);
  if (r.code !== 0) {
    throw new CredentialError(r.stderr.trim() || `git config exited ${r.code}`);
  }
}

export async function approveCredential(
  target: CredentialTarget,
  username: string,
  password: string
): Promise<void> {
  const r = await git(['credential', 'approve'], { input: describe(target, { username, password }) });
  if (r.code !== 0) {
    throw new CredentialError(r.stderr.trim() || `git credential approve exited ${r.code}`);
  }
}

// Reading back what is stored must never turn into a prompt. Without both of
// these, a lookup that finds nothing would ask: through an editor's askpass
// dialog when GIT_ASKPASS is set, which is invisible from the terminal the
// command was run in, or on the terminal otherwise. An empty GIT_ASKPASS also
// shadows core.askPass and SSH_ASKPASS, which git consults only when
// GIT_ASKPASS is unset.
export async function readCredential(
  target: CredentialTarget
): Promise<{ username: string; password: string } | null> {
  const r = await git(['credential', 'fill'], {
    input: describe(target, {}),
    env: { ...process.env, GIT_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.code !== 0) return null;
  const c = parseCredential(r.stdout);
  return c.username && c.password ? { username: c.username, password: c.password } : null;
}

export async function rejectCredential(target: CredentialTarget, username?: string): Promise<void> {
  const r = await git(['credential', 'reject'], {
    input: describe(target, username ? { username } : {}),
  });
  if (r.code !== 0) {
    throw new CredentialError(r.stderr.trim() || `git credential reject exited ${r.code}`);
  }
}

// Where the CLI remembers which vault it is talking to. The token itself is
// never written here: it lives in git's credential store, put there by
// `mochi login`, so there is one place a token is kept rather than two.
// This file records only the vault URL of the most recent login, which is what
// makes `mochi user list` work with no arguments and no environment.
export function loginPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, naming.configDirName, 'login.json');
}

export function loadLogin(file = loginPath()): { host: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { host?: unknown };
    return typeof parsed.host === 'string' && parsed.host ? { host: parsed.host } : null;
  } catch {
    return null;
  }
}

export function saveLogin(host: string, file = loginPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ host }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Only forgets the vault named, so logging out of one vault does not silently
// redirect commands that were aimed at another.
export function clearLogin(host: string, file = loginPath()): void {
  const saved = loadLogin(file);
  if (!saved || saved.host !== host) return;
  try {
    fs.rmSync(file);
  } catch {
    /* nothing to remove */
  }
}

// The vault a command should talk to, and the token to talk with. Precedence is
// the same for both: the option, then the environment, then what `mochi
// login` left behind (the URL in login.json, the token in git's credential
// store).
//
// The environment is here for a caller that has no keyring and possibly no
// writable home directory, which is an agent in a container rather than a
// person at a laptop. `mochi login` remains the one thing a person
// configures, and the runner already took this shape with
// MOCHI_RUNNER_TOKEN.
export async function vaultTarget(args: {
  host?: string | null;
  token?: string | null;
}): Promise<{ host: string; token: string }> {
  const envHost = process.env[`${naming.envPrefix}_HOST`]?.trim() || null;
  const envToken = process.env[`${naming.envPrefix}_TOKEN`]?.trim() || null;
  const host = (args.host ?? envHost ?? loadLogin()?.host ?? '').replace(/\/+$/, '');
  if (!host) {
    throw new CredentialError(
      `No ${naming.rootNoun}. Log in to one first:\n\n` +
        `  ${naming.product} login https://${naming.rootNoun}.example.com\n\n` +
        `or pass --host <url>, or set ${naming.envPrefix}_HOST.`
    );
  }
  if (args.token) return { host, token: args.token };
  if (envToken) return { host, token: envToken };
  const target = credentialTarget(host);
  const stored = await readCredential(target);
  if (!stored) {
    throw new CredentialError(
      `No stored token for ${target.url}. Log in again:\n\n` +
        `  ${naming.product} login ${target.url}\n\n` +
        `or pass --token <token>, or set ${naming.envPrefix}_TOKEN.`
    );
  }
  return { host, token: stored.password };
}
