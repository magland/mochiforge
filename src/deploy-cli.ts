import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearLogin, credentialTarget, loadLogin, readCredential, rejectCredential } from './credentials';
import { backupLineFor } from './cli/backup-cmd';
import { mintToken } from './vault';

// `mochi deploy fly`: put a vault on Fly.io from one command, and deploy
// updates to it with the same one. This is a thin driver of the fly command
// rather than a client of Fly's API, so it inherits `fly auth login` and the
// user's existing organization; the only prerequisite is that flyctl is
// installed and logged in.
//
// Nothing about a deployment is remembered on this machine. Fly already knows
// the region, the volume size, and the machine's shape, so this reads them back
// from the live app and applies only what the flags change. A generated
// fly.toml goes to a temporary directory for the length of the deploy, which is
// why there is no fly.toml in this repository to keep in sync or to explain.

export const IMAGE_REPO = 'ghcr.io/magland/mochi';
const VOLUME_NAME = 'vault';
const OWNER_TOKEN_SECRET = 'MOCHI_OWNER_TOKEN';
const INTERNAL_PORT = 3000;

interface FlyResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Settings {
  region: string;
  volumeGb: number;
  cpuKind: string;
  cpus: number;
  memory: string;
}

const DEFAULTS: Settings = { region: 'ewr', volumeGb: 10, cpuKind: 'shared', cpus: 1, memory: '512mb' };

interface DeployArgs {
  app: string | null;
  region: string | null;
  volumeGb: number | null;
  vmSize: string | null;
  memory: string | null;
  image: string | null;
  /** Build the image from this checkout rather than pulling a published one. */
  fromSource: boolean;
  /** With --from-source, build with the local Docker rather than Fly's builder. */
  localBuild: boolean;
  org: string | null;
  lfsBucket: boolean;
  yes: boolean;
}

const FLY_NOT_FOUND =
  'Neither fly nor flyctl is on PATH. Install it from https://fly.io/docs/flyctl/install/';

/**
 * The name flyctl goes by here.
 *
 * A normal install provides both `fly` and `flyctl`, but not every install is
 * normal: flyctl's own GitHub Action unpacks the release tarball, which carries
 * `flyctl` alone. So preferring `fly` and falling back keeps a deploy from a CI
 * runner working, which is the one place nobody is watching to fix the PATH.
 * Either name is the same binary, so which one was found never matters again.
 */
function flyBin(): string {
  if (cachedFlyBin === null) cachedFlyBin = onPath('fly') ?? onPath('flyctl') ?? 'fly';
  return cachedFlyBin;
}

let cachedFlyBin: string | null = null;

function onPath(name: string): string | null {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      try {
        fs.accessSync(path.join(dir, n), fs.constants.X_OK);
        return name;
      } catch {
        /* not this one */
      }
    }
  }
  return null;
}

// Quiet commands, whose output this code reads rather than the user. A non-zero
// exit is often the answer and not a failure (`fly status` on an app that does
// not exist), so the code is reported instead of thrown.
//
// The optional stdin is how a secret is handed over. An argument would be
// readable in `ps` by every other user on this machine for as long as the child
// runs, and a token is worth more than that.
export function fly(args: string[], stdin?: string): Promise<FlyResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(flyBin(), args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        reject(new Error(FLY_NOT_FOUND));
        return;
      }
      resolve({ code: typeof code === 'number' ? code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    if (stdin !== undefined) {
      // A child that exits before reading breaks the pipe; that failure is
      // already reported by its exit code above, so it is not raised twice.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdin);
    }
  });
}

async function flyJson<T>(args: string[]): Promise<T | null> {
  const r = await fly([...args, '--json']);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

// The commands whose progress the user should watch: deploying, creating a
// volume, provisioning a bucket. Their output is fly's to format, and hiding a
// three-minute deploy behind a spinner of our own would only lose detail.
export function flyStream(args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(flyBin(), args, { stdio: 'inherit', cwd });
    child.on('error', (e) => {
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(FLY_NOT_FOUND) : e);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseDeployArgs(args: string[], usage: () => never): DeployArgs {
  const out: DeployArgs = {
    app: null,
    region: null,
    volumeGb: null,
    vmSize: null,
    memory: null,
    image: null,
    fromSource: false,
    localBuild: false,
    org: null,
    lfsBucket: false,
    yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--region') out.region = args[++i];
    else if (a === '--volume') {
      const gb = parseInt(args[++i], 10);
      if (!Number.isInteger(gb) || gb < 1) die('--volume takes a size in whole gigabytes, e.g. --volume 10');
      out.volumeGb = gb;
    } else if (a === '--vm-size') out.vmSize = args[++i];
    else if (a === '--vm-memory') out.memory = args[++i];
    else if (a === '--image') out.image = args[++i];
    else if (a === '--from-source') out.fromSource = true;
    else if (a === '--local-build') out.localBuild = true;
    else if (a === '--org') out.org = args[++i];
    else if (a === '--lfs-bucket') out.lfsBucket = true;
    else if (a === '-y' || a === '--yes') out.yes = true;
    else if (a.startsWith('-')) die(`Unknown option: ${a}`);
    else if (!out.app) out.app = a;
    else die(`Unexpected argument: ${a}`);
  }
  return out;
}

// `deploy fly show` and `deploy fly destroy` take an app name and nothing else,
// apart from --yes on destroy. The flags that shape a deployment are parsed by the
// same function they share, so accepting one here and then ignoring it would
// look like it had been applied. Only the first one found is named, since fixing
// it means dropping it and running the command again either way.
function rejectFlyFlags(a: DeployArgs, usage: string, allowYes: boolean): void {
  const used: [string, boolean][] = [
    ['--region', a.region !== null],
    ['--volume', a.volumeGb !== null],
    ['--vm-size', a.vmSize !== null],
    ['--vm-memory', a.memory !== null],
    ['--image', a.image !== null],
    ['--from-source', a.fromSource],
    ['--local-build', a.localBuild],
    ['--org', a.org !== null],
    ['--lfs-bucket', a.lfsBucket],
    ['--yes', a.yes && !allowYes],
  ];
  const flag = used.find(([, given]) => given);
  if (!flag) return;
  if (flag[0] === '--yes') die(`--yes confirms a destroy, and there is nothing here to confirm.\nUsage: ${usage}`);
  die(`${flag[0]} says how to deploy, and this command deploys nothing.\nUsage: ${usage}`);
}

// Fly's own machine sizes name a CPU kind and a count: shared-cpu-4x,
// performance-2x. The generated config sets cpu_kind and cpus separately, since
// spelling those two out avoids having to know which shorthands Fly accepts
// today, so the shorthand is taken apart here.
export function parseVmSize(size: string): { cpuKind: string; cpus: number } {
  const m = /^(shared|performance)(?:-cpu)?-(\d+)x$/.exec(size.trim());
  if (!m) {
    die(
      `Not a Fly machine size: ${size}\n` +
        'Expected something like shared-cpu-1x, shared-cpu-4x, or performance-2x.\n' +
        'See: fly platform vm-sizes'
    );
  }
  return { cpuKind: m[1], cpus: parseInt(m[2], 10) };
}

export function normalizeMemory(memory: string): string {
  const m = /^(\d+)\s*(mb|gb)?$/i.exec(memory.trim());
  if (!m) die(`Not a memory size: ${memory}\nExpected something like 512mb, 1gb, or 2048.`);
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 'mb').toLowerCase();
  const mb = unit === 'gb' ? n * 1024 : n;
  if (mb < 256) die(`Memory of ${memory} is below Fly's 256mb minimum.`);
  return `${mb}mb`;
}

/** The version of this CLI, which is the image tag deployed unless --image says otherwise. */
export function ownVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* fall through to the message below */
  }
  die('Could not read this package\'s version, so there is no image tag to deploy. Pass --image <ref>.');
}

/**
 * The checkout this CLI is running out of, for --from-source.
 *
 * dist/deploy-cli.js and src/deploy-cli.ts are both one directory below the
 * package root, so this is the same answer either way: a built checkout, or one
 * being run through tsx. The published npm package ships only dist, so a globally
 * installed mochi has no Dockerfile and no src to build from, and that is
 * worth saying rather than letting docker fail on a missing file.
 */
export function sourceRoot(): string {
  const root = path.resolve(__dirname, '..');
  if (!fs.existsSync(path.join(root, 'Dockerfile')) || !fs.existsSync(path.join(root, 'src'))) {
    die(
      '--from-source builds the image from a mochi checkout, and this is not one:\n' +
        `  ${root}\n\n` +
        'The published package contains only the compiled output, so there is nothing to\n' +
        'build. Clone the repository and run the deploy from there:\n\n' +
        '  git clone https://github.com/magland/mochiforge && cd mochiforge && npm install\n' +
        '  npm run build && node dist/index.js deploy fly <app> --from-source\n'
    );
  }
  return root;
}

export async function requireFly(): Promise<void> {
  const who = await fly(['auth', 'whoami']);
  if (who.code !== 0) {
    die('Not logged in to Fly. Run:\n\n  fly auth login\n');
  }
}

export interface VolumeInfo {
  id: string;
  name: string;
  region: string;
  size_gb: number;
  state?: string;
}

export interface MachineInfo {
  id: string;
  state?: string;
  region?: string;
  config?: {
    image?: string;
    env?: Record<string, string>;
    guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number };
  };
}

export async function appExists(app: string): Promise<boolean> {
  const r = await fly(['status', '-a', app]);
  return r.code === 0;
}

export async function namedVolume(app: string, name: string): Promise<VolumeInfo | null> {
  const vols = (await flyJson<VolumeInfo[]>(['volumes', 'list', '-a', app])) ?? [];
  return vols.find((v) => v.name === name) ?? null;
}

async function vaultVolume(app: string): Promise<VolumeInfo | null> {
  return namedVolume(app, VOLUME_NAME);
}

export async function machines(app: string): Promise<MachineInfo[]> {
  return (await flyJson<MachineInfo[]>(['machines', 'list', '-a', app])) ?? [];
}

/**
 * The hostnames Fly serves this app under besides <app>.fly.dev, from its
 * certificates. A vault with a domain of its own is reached by that name, so
 * anything asking "is this app the one at <url>" has to know both.
 */
async function certHostnames(app: string): Promise<string[]> {
  const certs = (await flyJson<{ hostname?: string }[]>(['certs', 'list', '-a', app])) ?? [];
  // A wildcard covers each repository's site rather than the vault itself, so it
  // is not a name the vault answers on.
  return certs.map((c) => c.hostname ?? '').filter((h) => h !== '' && !h.startsWith('*.'));
}

export async function secretNames(app: string): Promise<string[]> {
  const secrets = (await flyJson<{ Name?: string; name?: string }[]>(['secrets', 'list', '-a', app])) ?? [];
  return secrets.map((s) => s.Name ?? s.name ?? '').filter(Boolean);
}

/** What Fly currently has, so that a flag-less redeploy changes nothing and one flag changes one thing. */
async function liveSettings(app: string): Promise<Partial<Settings>> {
  const out: Partial<Settings> = {};
  const vol = await vaultVolume(app);
  if (vol) {
    out.region = vol.region;
    out.volumeGb = vol.size_gb;
  }
  const guest = (await machines(app)).find((m) => m.config?.guest)?.config?.guest;
  if (guest) {
    if (guest.cpu_kind) out.cpuKind = guest.cpu_kind;
    if (guest.cpus) out.cpus = guest.cpus;
    if (guest.memory_mb) out.memory = `${guest.memory_mb}mb`;
  }
  return out;
}

function resolveSettings(a: DeployArgs, live: Partial<Settings>): Settings {
  const base: Settings = { ...DEFAULTS, ...live };
  const vm = a.vmSize ? parseVmSize(a.vmSize) : null;
  return {
    region: a.region ?? base.region,
    volumeGb: a.volumeGb ?? base.volumeGb,
    cpuKind: vm?.cpuKind ?? base.cpuKind,
    cpus: vm?.cpus ?? base.cpus,
    memory: a.memory ? normalizeMemory(a.memory) : base.memory,
  };
}

// A vault is a directory on one volume, so this app runs as exactly one
// machine: --ha=false at deploy time, and min_machines_running = 0 with
// auto-start here. A second machine would mean a second volume and a second
// vault, diverging silently from the first. For the same reason, a busier vault
// wants a bigger machine rather than more of them.
function flyToml(app: string, s: Settings): string {
  return `# Generated by mochi deploy for '${app}'. Written to a temporary
# directory for the length of one deploy; edit the deploy command, not this.
app = "${app}"
primary_region = "${s.region}"

[mounts]
  source = "${VOLUME_NAME}"
  destination = "/vault"

# Fly always terminates TLS in front, so the forwarded headers are the only place
# the real scheme and address appear. The server records this in the vault's
# config.json on the next start, where it can be changed by hand afterwards.
[env]
  MOCHI_TRUST_PROXY = "1"

[http_service]
  internal_port = ${INTERNAL_PORT}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  [http_service.concurrency]
    type = "requests"
    hard_limit = 250
    soft_limit = 200

[[vm]]
  cpu_kind = "${s.cpuKind}"
  cpus = ${s.cpus}
  memory = "${s.memory}"
`;
}

function writeTempConfig(app: string, s: Settings): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-deploy-'));
  const file = path.join(dir, 'fly.toml');
  fs.writeFileSync(file, flyToml(app, s));
  return file;
}

export function appUrl(app: string): string {
  return `https://${app}.fly.dev`;
}

/**
 * Wait for the deployed vault to answer as the token's owner. This is both the
 * health check and the proof that the injected token was adopted: a machine
 * that boots and then fails to read its volume answers nothing, and a vault
 * that was already initialized answers 401.
 */
async function waitForVault(
  url: string,
  token: string,
  seconds = 120
): Promise<{ ok: true; username: string } | { ok: false; reason: string }> {
  const deadline = Date.now() + seconds * 1000;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = (await resp.json()) as { username?: unknown };
        if (typeof data.username === 'string' && data.username) return { ok: true, username: data.username };
        last = 'the vault answered without saying who the token belongs to';
      } else if (resp.status === 401 || resp.status === 403) {
        // Conclusive rather than worth retrying: the server is up and has
        // rejected this token, which means the vault was initialized before.
        return { ok: false, reason: `the vault did not accept the new owner token (HTTP ${resp.status})` };
      } else {
        last = `HTTP ${resp.status} from ${url}`;
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, reason: `timed out after ${seconds}s: ${last}` };
}

export async function deployFlyCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseDeployArgs(args, usage);
  if (!a.app) {
    die(
      'Which app? Fly app names are globally unique, and the name becomes the URL:\n\n' +
        '  mochi deploy fly my-vault-name    ->  https://my-vault-name.fly.dev\n'
    );
  }
  const app = a.app;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) {
    die(`Not a valid Fly app name: ${app}\nUse lowercase letters, digits, and dashes.`);
  }

  // What gets deployed: a published image to pull, or this checkout to build.
  // Settled from the flags before anything reaches the network, so a
  // contradiction between them costs no round trip and creates no app.
  if (a.fromSource && a.image !== null) {
    die('--image names an image to pull and --from-source builds one instead. Pass one or the other.');
  }
  if (a.localBuild && !a.fromSource) {
    die('--local-build says how to build, and without --from-source there is nothing to build.');
  }
  const buildRoot = a.fromSource ? sourceRoot() : null;
  const image = buildRoot === null ? a.image ?? `${IMAGE_REPO}:${ownVersion()}` : null;

  await requireFly();

  const existed = await appExists(app);
  const live = existed ? await liveSettings(app) : {};
  const settings = resolveSettings(a, live);

  // A volume cannot move, so a region flag that disagrees with the volume that
  // exists is a request this cannot carry out. Saying so beats deploying a
  // machine in one region that can never attach the disk in another.
  if (existed && live.region && a.region && a.region !== live.region) {
    die(
      `This vault's volume is in ${live.region}, and a volume cannot be moved to ${a.region}.\n` +
        'Deploying to another region means a new vault and copying the data across.'
    );
  }

  if (existed) {
    console.log(`==> Updating '${app}' (${appUrl(app)})`);
  } else {
    console.log(`==> Creating '${app}' in ${settings.region}`);
    const created = await flyStream(['apps', 'create', app, ...(a.org ? ['--org', a.org] : [])]);
    if (created !== 0) {
      die(
        `\nCould not create the Fly app '${app}'.\n` +
          'App names are globally unique, so a name in use by anyone stops this. Try another.'
      );
    }
  }

  const vol = await vaultVolume(app);
  if (!vol) {
    console.log(`==> Creating a ${settings.volumeGb}GB volume '${VOLUME_NAME}' in ${settings.region}`);
    const code = await flyStream([
      'volumes',
      'create',
      VOLUME_NAME,
      '-a',
      app,
      '--region',
      settings.region,
      '--size',
      String(settings.volumeGb),
      '--yes',
    ]);
    if (code !== 0) die('\nCould not create the volume, so there is nowhere to keep the vault.');
  } else if (settings.volumeGb > vol.size_gb) {
    console.log(`==> Extending volume '${VOLUME_NAME}' from ${vol.size_gb}GB to ${settings.volumeGb}GB`);
    const code = await flyStream(['volumes', 'extend', vol.id, '-a', app, '--size', String(settings.volumeGb)]);
    if (code !== 0) die('\nCould not extend the volume.');
  } else if (a.volumeGb !== null && a.volumeGb < vol.size_gb) {
    // Fly volumes only grow. Ignoring this quietly would leave the operator
    // believing the vault had been shrunk, and paying for the old size.
    die(
      `The volume is ${vol.size_gb}GB and Fly volumes cannot be shrunk, so --volume ${a.volumeGb} cannot be applied.\n` +
        'Leave the flag off to keep the size it has.'
    );
  }

  const secrets = existed ? await secretNames(app) : [];

  if (a.lfsBucket && !secrets.includes('BUCKET_NAME')) {
    // Tigris' own secret names are the ones the LFS store already reads, so
    // provisioning a bucket is the whole configuration step. It is the only
    // provider a deploy can set up unattended, which is why this flag uses it
    // and not the one the documentation recommends.
    console.log('==> Provisioning a Tigris bucket for Git LFS objects');
    // Said here rather than only in the documentation, because this is the
    // moment the choice is being made. LFS bytes leave the bucket rather than
    // the app, so they are outside the vault's daily egress cap and are billed
    // on the bucket's own terms; R2 charges nothing for them.
    console.log('    Tigris is what a deploy can provision unattended, not what costs least to');
    console.log('    serve from: LFS downloads leave the bucket, so they are billed by the bucket');
    console.log('    and are not covered by the vault\'s daily egress limit. Cloudflare R2 charges');
    console.log('    no egress fees; see docs/lfs.md#storage-providers to point this vault there.');
    const code = await flyStream(['storage', 'create', '-a', app, '-n', `${app}-lfs`, '--yes']);
    if (code !== 0) {
      die(
        '\nCould not provision the bucket. The app and volume are already there, so\n' +
          'this command is safe to run again once the bucket problem is sorted out.'
      );
    }
  } else if (a.lfsBucket) {
    console.log('==> A bucket is already configured (BUCKET_NAME is set), leaving it alone');
  }

  // Set once the operator has been shown the token. It is what the exit hook
  // below checks before printing it as a last resort.
  let tokenDelivered = false;

  // An owner token is minted only for a vault that has none. The question is
  // whether the vault has been initialized rather than whether the app exists,
  // because a first deploy that fails leaves the app behind: on the next
  // attempt the app is not new but the vault still is, and that retry should
  // end with a usable owner token like any other first deploy. Whether a
  // machine has ever run is as close to that question as Fly can be asked.
  //
  // The secret already being set is deliberately not part of it. A Fly secret
  // can be written and not read, so a token from an abandoned attempt is a
  // token nobody has; overwriting it with one this run knows is the only way
  // the retry can end with a token the operator holds.
  //
  // Minting here rather than on the server is what makes that possible: the
  // server adopts this token when it initializes the vault, stores only its
  // hash, and never prints it.
  const ownerToken = existed && (await machines(app)).length > 0 ? null : mintToken().token;
  if (ownerToken) {
    console.log('==> Setting the one-time owner token as a Fly secret');
    // `secrets import` reads KEY=VALUE lines from stdin, which keeps the token
    // off the child's argv and so out of `ps`.
    const r = await fly(['secrets', 'import', '-a', app, '--stage'], `${OWNER_TOKEN_SECRET}=${ownerToken}\n`);
    if (r.code !== 0) die(`Could not set the owner token secret:\n${r.stderr.trim() || r.stdout.trim()}`);
    // From here the token exists in two places: this process, and a Fly secret
    // that can be written but never read back. So every way out of the rest of
    // this command has to end with the operator looking at it, and an exit hook
    // is the one place that covers them all, including a `die()` from deeper
    // down and an unexpected throw.
    process.on('exit', () => {
      if (tokenDelivered) return;
      // Written with writeSync rather than console.error, which is the whole
      // point of doing it here: on Linux a write to a pipe is asynchronous, so
      // console.error from an exit handler is discarded when the output is
      // piped into a file or a pager, which is a plausible thing to do with a
      // deploy. The one message that must not be lost cannot go out that way.
      fs.writeSync(
        2,
        '\nThe owner token this run staged as a Fly secret, shown here because nothing\n' +
          'else has a copy of it. A Fly secret can be written but not read back, and this\n' +
          'token is the owner of the vault if this app initialized one:\n' +
          `\n  ${ownerToken}\n` +
          `\nKeep it, then: mochi login ${appUrl(app)} --token ${ownerToken}\n`
      );
    });
  }

  const config = writeTempConfig(app, settings);
  // A source build runs fly in the checkout, so the build context is the checkout
  // and fly finds its Dockerfile without being told where it is. --config still
  // points at the generated fly.toml in a temporary directory, which is why there
  // is no fly.toml in the repository for a build to pick up by accident.
  //
  // Without --local-only, flyctl builds on a Fly builder machine, which needs no
  // Docker here and provisions a builder app on first use. --local-build asks for
  // the local daemon instead and pushes the result to Fly's registry.
  const source = buildRoot !== null;
  if (source) {
    console.log(`==> Building ${buildRoot} ${a.localBuild ? 'with the local Docker' : "on Fly's builder"}`);
  } else {
    console.log(`==> Deploying ${image}`);
  }
  const code = await flyStream(
    [
      'deploy',
      '--app',
      app,
      '--config',
      config,
      ...(source ? (a.localBuild ? ['--local-only'] : []) : ['--image', image as string]),
      '--ha=false',
      '--yes',
    ],
    buildRoot ?? undefined
  );
  fs.rmSync(path.dirname(config), { recursive: true, force: true });
  if (code !== 0) {
    console.error('');
    console.error('The deploy failed. The app and the volume survive, so fix the cause and run the');
    console.error('same command again.');
    if (ownerToken) {
      // The retry will not mint a second token if a machine was left behind by
      // this attempt, and it could not overwrite a secret it cannot read even
      // if it did. So this run's token is the one the vault ends up with, and
      // the exit hook is about to print it.
      console.error('');
      console.error('The retry may not mint a token of its own, because the one shown at the end of');
      console.error('this output is already the token the vault will be initialized with. Keep it,');
      console.error('and log in with it once a deploy succeeds.');
    }
    if (source) {
      console.error('');
      console.error('If the build is the problem, `npm run build` in the checkout reproduces it locally');
      console.error(a.localBuild
        ? 'without Fly in the way; check that the Docker daemon here is running.'
        : "without Fly in the way. --local-build uses this machine's Docker instead of Fly's builder.");
    } else if (a.image === null) {
      console.error('');
      console.error(`If the image is the problem, check that ${image} exists,`);
      console.error('or deploy another tag with --image <ref>, or build this checkout with --from-source.');
    }
    process.exit(1);
  }

  const url = appUrl(app);
  console.log('');
  if (!ownerToken) {
    console.log(`==> Deployed: ${url}`);
    console.log('');
    console.log('The vault it serves is whichever vault was already on the volume, users and all.');
    // No token was minted because a machine had run before, which usually means
    // a vault that has been in use and an operator who is already logged in.
    // With nothing stored here, the other reading is possible: an earlier
    // attempt staged a token and left a machine behind, and this deploy has
    // just initialized the vault with it. Saying so costs a line only in the
    // case where it might be the answer.
    if (!(await readCredential(credentialTarget(url)))) {
      console.log('');
      console.log('No token for it is stored on this machine, so log in with one the vault knows:');
      console.log('');
      console.log(`  mochi login ${url}`);
      console.log('');
      console.log('If an earlier deploy of this app failed, the vault was initialized just now with');
      console.log('the owner token that run printed, and that is the token to use.');
      console.log('');
    }
    console.log(`  fly logs -a ${app}`);
    return;
  }

  console.log('==> Waiting for the vault to answer');
  const ready = await waitForVault(url, ownerToken);
  if (!ready.ok) {
    console.error('');
    console.error(`Deployed, but ${ready.reason}.`);
    console.error(`Look at what the server said: fly logs -a ${app}`);
    if (existed) {
      // The likeliest cause when the app was already there: a volume carrying
      // a vault that was initialized by an earlier machine. Its own tokens are
      // still the way in, and no token minted here will ever work on it.
      console.error('');
      console.error('If this app has served a vault before, that vault keeps the users and tokens it');
      console.error('already had, and a token minted now is not one of them. Log in with one of those:');
      console.error('');
      console.error(`  mochi login ${url}`);
    }
    // The token this run minted is printed on the way out by the exit hook,
    // since a vault that has not answered yet may still adopt it.
    process.exit(1);
  }

  // The token is shown rather than stored. A deploy that logged you in quietly
  // left the operator holding a vault whose token they had never seen, which is
  // no way to sign in to the web UI and nothing to keep anywhere; and the token
  // cannot be recovered later, since the server keeps only its hash and a Fly
  // secret cannot be read back. So it is printed once, with the two ways to use
  // it, and `mochi login` stays the one thing that stores a credential.
  console.log('');
  console.log(`==> Ready: ${url}`);
  console.log('');
  console.log(`The vault is initialized, and '${ready.username}' owns it. This is its token, shown`);
  console.log('here once and nowhere else: the server keeps only its hash, and the Fly secret it');
  console.log('was staged in cannot be read back. Keep it somewhere safe now.');
  console.log('');
  console.log(`  ${ownerToken}`);
  // Only now: the exit hook is the backstop for a token that never reached the
  // operator, and stdout can fail (a closed pipe) between here and there.
  tokenDelivered = true;
  console.log('');
  console.log(`To administer the vault in a browser, open its sign-in page and give that token as`);
  console.log(`'${ready.username}':`);
  console.log('');
  console.log(`  ${url}/login`);
  console.log('');
  console.log('The form asks for a username and a token, since a vault has no passwords. From');
  console.log('there the Admin page creates the users and the repositories, which is the usual');
  console.log('way to bootstrap a fresh vault.');
  console.log('');
  console.log('To use the CLI and git instead, hand the same token to git\'s credential store,');
  console.log('which is what login is for:');
  console.log('');
  console.log(`  mochi login ${url}`);
  console.log('');
  console.log('It asks for the token without echoing it, checks it, and remembers this vault, so');
  console.log('these need no arguments afterwards and git stops asking on a push:');
  console.log('');
  console.log('  mochi whoami');
  console.log("  mochi user add alice --scope 'alice/*'");
  console.log(`  mochi import https://github.com/someone/something.git mine`);
  console.log('');
  console.log('Deploy an update, or change a setting, with the same command:');
  console.log('');
  console.log(`  mochi deploy fly ${app}`);
  console.log(`  mochi deploy fly ${app} --volume 50 --vm-memory 1gb`);
}

export async function deployShowCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseDeployArgs(args, usage);
  if (!a.app) die('Which app? Usage: mochi deploy fly show <app>');
  rejectFlyFlags(a, 'mochi deploy fly show <app>', false);
  const app = a.app;
  await requireFly();
  if (!(await appExists(app))) {
    die(`No Fly app named '${app}' that you can see. Check the name, or: fly apps list`);
  }

  const url = appUrl(app);
  const vol = await vaultVolume(app);
  const ms = await machines(app);
  const secrets = await secretNames(app);

  console.log(`${app}  ${url}`);
  console.log('');
  if (ms.length === 0) {
    console.log('  machines  none, so nothing is serving this vault');
  } else {
    // More than one machine is worth naming rather than summarizing: it means
    // two volumes and two vaults, which is the failure --ha=false prevents.
    if (ms.length > 1) console.log(`  machines  ${ms.length}, which is one too many for a single-volume vault`);
    for (const m of ms) {
      const g = m.config?.guest;
      const shape = g ? `${g.cpu_kind}-cpu-${g.cpus}x, ${g.memory_mb}mb` : 'unknown shape';
      console.log(`  machine   ${m.id}  ${m.state ?? '?'}  ${m.region ?? '?'}  ${shape}`);
      console.log(`  image     ${m.config?.image ?? 'unknown'}`);
    }
  }
  console.log(vol ? `  volume    ${vol.size_gb}GB in ${vol.region} (${vol.state ?? 'created'})` : '  volume    none');
  console.log(`  lfs       ${secrets.includes('BUCKET_NAME') ? 'objects in a bucket (BUCKET_NAME is set)' : 'objects on the volume'}`);

  // Whether it works, which is the question `fly status` cannot answer. A
  // stored credential turns this into a report of who you are on it.
  const target = credentialTarget(url);
  const stored = await readCredential(target);
  let vault = 'not reachable';
  try {
    const resp = await fetch(`${url}/api/whoami`, {
      headers: stored ? { authorization: `Bearer ${stored.password}` } : {},
    });
    if (resp.ok) {
      const data = (await resp.json()) as { username?: unknown };
      vault = `answering, and you are '${String(data.username)}' on it`;
    } else if (resp.status === 401) {
      vault = stored ? 'answering, but your stored token is not valid on it' : 'answering (no token stored here)';
    } else {
      vault = `answering with HTTP ${resp.status}`;
    }
  } catch (e) {
    vault = `not reachable: ${e instanceof Error ? e.message : e}`;
  }
  console.log(`  vault     ${vault}`);
  const saved = loadLogin();
  if (saved && saved.host.replace(/\/+$/, '') === url) console.log('  login     this is the vault mochi commands use');
  // Fly's own volume snapshots live at the same provider as the volume, so they
  // are a complement to a backup on a disk of your own rather than a substitute
  // for one. Whether this machine keeps such a copy is worth one line.
  //
  // Both names are offered, because a vault with a domain of its own was almost
  // certainly backed up by that name rather than by <app>.fly.dev, and a report
  // that said "none" in that case would be worse than no report at all.
  const backup = backupLineFor([url, ...(await certHostnames(app)).map((h) => `https://${h}`)]);
  console.log(backup ? `  backup    ${backup}` : '  backup    none on this machine (mochi backup <dir>)');
  console.log('');
  console.log(`  fly logs -a ${app}`);
}

export function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Nothing to ask on: not a terminal. Pass --yes to confirm.'));
      return;
    }
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(chunk.trim());
    };
    process.stdin.on('data', onData);
  });
}

export async function deployDestroyCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseDeployArgs(args, usage);
  if (!a.app) die('Which app? Usage: mochi deploy fly destroy <app> [--yes]');
  rejectFlyFlags(a, 'mochi deploy fly destroy <app> [--yes]', true);
  const app = a.app;
  await requireFly();
  if (!(await appExists(app))) {
    die(`No Fly app named '${app}' that you can see. Check the name, or: fly apps list`);
  }

  const vol = await vaultVolume(app);
  const hadBucket = (await secretNames(app)).includes('BUCKET_NAME');

  if (!a.yes) {
    console.log(`This destroys the Fly app '${app}' and its ${vol ? `${vol.size_gb}GB ` : ''}volume.`);
    console.log('Everything in the vault goes with it: repositories, issues, pull requests, users.');
    console.log('There is no undo, and Fly keeps no backup of a destroyed volume.');
    console.log('');
    const answer = await promptLine(`Type the app name to confirm: `);
    if (answer !== app) die('Not destroyed.');
  }

  const code = await flyStream(['apps', 'destroy', app, '--yes']);
  if (code !== 0) die('\nCould not destroy the app.');

  // A credential for a vault that no longer exists is litter, and a saved
  // login pointing at it would send the next command nowhere.
  const url = appUrl(app);
  const target = credentialTarget(url);
  const stored = await readCredential(target);
  if (stored) {
    await rejectCredential(target, stored.username);
    console.log(`Removed the stored credential for ${url}.`);
  }
  clearLogin(url);

  if (hadBucket) {
    console.log('');
    console.log('The Tigris bucket that held this vault\'s LFS objects is a separate resource and');
    console.log('was not destroyed. Remove it, and its contents, with:');
    console.log('');
    console.log('  fly storage list');
    console.log('  fly storage destroy <name>');
  }
}
