import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { api } from './cli-api';
import { RemoteTarget, remoteTarget } from './cli-api';
import { newWakeSecret } from './ci/wake';
import {
  IMAGE_REPO,
  appExists,
  appUrl,
  die,
  fly,
  flyStream,
  machines,
  namedVolume,
  normalizeMemory,
  ownVersion,
  parseVmSize,
  promptLine,
  requireFly,
  secretNames,
  sourceRoot,
} from './deploy-cli';
import { MAX_JOB_TIMEOUT_MINUTES, isUsableJobTimeout } from './ci/runners';
import { isValidName } from './scan';

// `mochi deploy fly runner`: put a workflow runner on Fly.io, beside a
// vault that is already there or anywhere else.
//
// A runner is not a second vault. It keeps nothing worth keeping, it serves no
// requests, and it is worth money only while it is executing a job. So the
// arrangement here is the opposite of the vault's: the machine stops as soon
// as it has been idle for a few minutes, and the vault starts it again by
// sending a request to it when a job is waiting. Between runs the app costs
// nothing but its volume.
//
// The volume is mounted at /var/lib/docker, which is what makes stopping
// affordable: a job image pulled once stays pulled, so a cold start is a boot
// and not a download.

const RUNNER_IMAGE_REPO = `${IMAGE_REPO}-runner`;
const VOLUME_NAME = 'docker';
const INTERNAL_PORT = 3000;
const HOST_SECRET = 'MOCHI_HOST';
const TOKEN_SECRET = 'MOCHI_RUNNER_TOKEN';
const WAKE_SECRET = 'MOCHI_WAKE_SECRET';

interface Settings {
  region: string;
  volumeGb: number;
  cpuKind: string;
  cpus: number;
  memory: string;
  idle: string;
}

// Bigger than the vault's defaults, because the work is the other way round: a
// vault serves small requests from a disk, and a runner compiles things. The
// volume holds job images rather than anything of the operator's, so it is
// sized for a few of those and no more.
const DEFAULTS: Settings = {
  region: 'ewr',
  volumeGb: 20,
  cpuKind: 'shared',
  cpus: 2,
  memory: '2gb',
  idle: '5m',
};

interface RunnerDeployArgs {
  app: string | null;
  name: string | null;
  allow: string[];
  labels: string[];
  jobTimeout: number | null;
  region: string | null;
  volumeGb: number | null;
  vmSize: string | null;
  memory: string | null;
  idle: string | null;
  image: string | null;
  imageOnly: boolean;
  fromSource: boolean;
  localBuild: boolean;
  org: string | null;
  host: string | null;
  token: string | null;
  yes: boolean;
}

function parseArgs(args: string[], usage: () => never): RunnerDeployArgs {
  const out: RunnerDeployArgs = {
    app: null,
    name: null,
    allow: [],
    labels: [],
    jobTimeout: null,
    region: null,
    volumeGb: null,
    vmSize: null,
    memory: null,
    idle: null,
    image: null,
    imageOnly: false,
    fromSource: false,
    localBuild: false,
    org: null,
    host: null,
    token: null,
    yes: false,
  };
  const list = (v: string): string[] => v.split(/[\s,]+/).filter((s) => s.length > 0);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--name') out.name = args[++i];
    else if (a === '--allow') out.allow.push(...list(args[++i] ?? ''));
    else if (a === '--labels' || a === '--label') out.labels.push(...list(args[++i] ?? ''));
    else if (a === '--job-timeout') {
      const raw = (args[++i] ?? '').trim();
      const m = /^(\d+)\s*(m|h)?$/i.exec(raw);
      if (!m) die('--job-timeout takes minutes, or a duration like 45m or 2h');
      const n = parseInt(m![1], 10) * ((m![2] ?? 'm').toLowerCase() === 'h' ? 60 : 1);
      if (!isUsableJobTimeout(n)) die(`--job-timeout takes 1 to ${MAX_JOB_TIMEOUT_MINUTES} minutes`);
      out.jobTimeout = n;
    }
    else if (a === '--region') out.region = args[++i];
    else if (a === '--volume') {
      const gb = parseInt(args[++i], 10);
      if (!Number.isInteger(gb) || gb < 1) die('--volume takes a size in whole gigabytes, e.g. --volume 20');
      out.volumeGb = gb;
    } else if (a === '--vm-size') out.vmSize = args[++i];
    else if (a === '--vm-memory') out.memory = args[++i];
    else if (a === '--idle') out.idle = args[++i];
    else if (a === '--image') out.image = args[++i];
    else if (a === '--image-only') out.imageOnly = true;
    else if (a === '--from-source') out.fromSource = true;
    else if (a === '--local-build') out.localBuild = true;
    else if (a === '--org') out.org = args[++i];
    else if (a === '--host') out.host = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '-y' || a === '--yes') out.yes = true;
    else if (a.startsWith('-')) die(`Unknown option: ${a}`);
    else if (!out.app) out.app = a;
    else die(`Unexpected argument: ${a}`);
  }
  return out;
}

/**
 * Refuse the flags that shape a deployment on the commands that deploy nothing.
 *
 * `show` and `destroy` share the parser with the deploy, so accepting
 * `--vm-size` here and ignoring it would look like it had been applied. Only
 * the first one found is named, since fixing it means dropping it and running
 * the command again either way.
 */
function rejectShapingFlags(a: RunnerDeployArgs, usage: string, allowYes: boolean): void {
  const used: [string, boolean][] = [
    ['--name', a.name !== null],
    ['--allow', a.allow.length > 0],
    ['--labels', a.labels.length > 0],
    ['--region', a.region !== null],
    ['--volume', a.volumeGb !== null],
    ['--vm-size', a.vmSize !== null],
    ['--vm-memory', a.memory !== null],
    ['--idle', a.idle !== null],
    ['--image', a.image !== null],
    ['--image-only', a.imageOnly],
    ['--from-source', a.fromSource],
    ['--local-build', a.localBuild],
    ['--org', a.org !== null],
    ['--yes', a.yes && !allowYes],
  ];
  const flag = used.find(([, given]) => given);
  if (!flag) return;
  if (flag[0] === '--yes') die(`--yes confirms a destroy, and there is nothing here to confirm.\nUsage: ${usage}`);
  die(`${flag[0]} says how to deploy, and this command deploys nothing.\nUsage: ${usage}`);
}

/** Checked here rather than by the runner, since a bad value would only be found after a deploy. */
function checkIdle(idle: string): string {
  if (!/^\d+\s*[smh]?$/i.test(idle.trim())) {
    die(`--idle takes a duration like 5m, 90s, or 1h, got: ${idle}`);
  }
  return idle.trim();
}

interface MachineGuest {
  cpu_kind?: string;
  cpus?: number;
  memory_mb?: number;
}

/** What Fly has now, so that a flag-less redeploy changes nothing and one flag changes one thing. */
async function liveSettings(app: string): Promise<Partial<Settings>> {
  const out: Partial<Settings> = {};
  const vol = await namedVolume(app, VOLUME_NAME);
  if (vol) {
    out.region = vol.region;
    out.volumeGb = vol.size_gb;
  }
  const config = (await machines(app)).find((m) => m.config)?.config;
  const guest = config?.guest as MachineGuest | undefined;
  if (guest) {
    if (guest.cpu_kind) out.cpuKind = guest.cpu_kind;
    if (guest.cpus) out.cpus = guest.cpus;
    if (guest.memory_mb) out.memory = `${guest.memory_mb}mb`;
  }
  // The machine's own idle timeout, so a redeploy keeps a tuned --idle rather
  // than quietly resetting it to the default.
  const idle = config?.env?.MOCHI_IDLE;
  if (idle) out.idle = idle;
  return out;
}

function resolveSettings(a: RunnerDeployArgs, live: Partial<Settings>): Settings {
  const base: Settings = { ...DEFAULTS, ...live };
  const vm = a.vmSize ? parseVmSize(a.vmSize) : null;
  return {
    region: a.region ?? base.region,
    volumeGb: a.volumeGb ?? base.volumeGb,
    cpuKind: vm?.cpuKind ?? base.cpuKind,
    cpus: vm?.cpus ?? base.cpus,
    memory: a.memory ? normalizeMemory(a.memory) : base.memory,
    idle: a.idle ? checkIdle(a.idle) : base.idle,
  };
}

/**
 * The generated fly.toml.
 *
 * Two settings carry the whole design. `auto_stop_machines = "off"` because
 * Fly stops a machine that has had no inbound traffic, and a runner's traffic
 * is all outbound: left on, it would stop a machine in the middle of a job.
 * The runner stops itself instead, by exiting when idle, which a restart
 * policy of "never" turns into a stopped machine rather than a restarted one.
 * `auto_start_machines` is what the vault's wake request then acts on.
 */
function flyToml(app: string, s: Settings): string {
  return `# Generated by mochi deploy fly runner for '${app}'. Written to a temporary
# directory for the length of one deploy; edit the deploy command, not this.
app = "${app}"
primary_region = "${s.region}"

[mounts]
  source = "${VOLUME_NAME}"
  destination = "/var/lib/docker"

[env]
  MOCHI_IDLE = "${s.idle}"
  MOCHI_WAKE_PORT = "${INTERNAL_PORT}"

# The runner exits when it has been idle, and a machine whose process exits
# stops. Restarting it here would defeat that entirely.
[[restart]]
  policy = "never"

# Nothing serves anything here: the only request this app ever receives is the
# vault's wake request, and the point of receiving it is that Fly starts the
# machine in order to deliver it.
[http_service]
  internal_port = ${INTERNAL_PORT}
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  cpu_kind = "${s.cpuKind}"
  cpus = ${s.cpus}
  memory = "${s.memory}"
`;
}

function writeTempConfig(app: string, s: Settings): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-runner-deploy-'));
  const file = path.join(dir, 'fly.toml');
  fs.writeFileSync(file, flyToml(app, s));
  return file;
}

function wakeUrlFor(app: string): string {
  return `${appUrl(app)}/wake`;
}

interface RegisteredRunner {
  name: string;
  labels: string[];
  allow: string[];
  wakeUrl: string | null;
}

async function registeredRunners(target: RemoteTarget): Promise<RegisteredRunner[]> {
  const data = await api(target, 'GET', '/api/runners');
  return ((data.runners ?? []) as RegisteredRunner[]) ?? [];
}

/**
 * The fly deploy itself, shared by the full deploy and --image-only. Exits
 * the process on failure, after saying what to try.
 */
async function flyDeploy(
  app: string,
  a: RunnerDeployArgs,
  settings: Settings,
  buildRoot: string | null,
  image: string | null
): Promise<void> {
  const config = writeTempConfig(app, settings);
  if (buildRoot !== null) {
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
      ...(buildRoot !== null
        ? ['--dockerfile', path.join(buildRoot, 'Dockerfile.runner'), ...(a.localBuild ? ['--local-only'] : [])]
        : ['--image', image as string]),
      '--ha=false',
      '--yes',
    ],
    buildRoot ?? undefined
  );
  fs.rmSync(path.dirname(config), { recursive: true, force: true });
  if (code !== 0) {
    console.error('');
    console.error('The deploy failed. The app, the volume, and the registration survive, so fix the');
    console.error('cause and run the same command again.');
    if (buildRoot === null && a.image === null) {
      // Named as the likely cause rather than as one possibility among many,
      // because it is the one every early deploy hits: the runner image is
      // published per release like the vault's, so a version of the CLI newer
      // than the newest release has no image to pull. Fly reports a package
      // that is absent, and one that is private, with the same message about
      // authentication, and a package newly published to GHCR is private
      // until someone says otherwise.
      console.error('');
      console.error(`If Fly could not fetch ${image}:`);
      console.error('');
      console.error('  - It may not be published. The runner image is built per release, so a CLI');
      console.error('    newer than the newest release asks for a tag that does not exist yet.');
      console.error('  - It may be private. A package newly published to GHCR is private until it');
      console.error('    is made public, and Fly reports that as an authentication error too.');
      console.error('');
      console.error('Either way, this deploys the checkout you are running instead:');
      console.error('');
      console.error(`  mochi deploy fly runner ${app} --from-source`);
      console.error('');
      console.error('or --image <ref> deploys some other tag.');
    }
    process.exit(1);
  }
}

export async function deployFlyRunnerCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.app) {
    die(
      'Which app? Fly app names are globally unique, and this one is the address the vault\n' +
        'will send its wake request to:\n\n' +
        '  mochi deploy fly runner my-runner --allow "mycollection/*"\n'
    );
  }
  const app = a.app;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) {
    die(`Not a valid Fly app name: ${app}\nUse lowercase letters, digits, and dashes.`);
  }
  const name = a.name ?? app;
  if (!isValidName(name)) {
    die(`Not a usable runner name: ${name}\nUse letters, digits, dot, dash, underscore.`);
  }
  if (a.fromSource && a.image !== null) {
    die('--image names an image to pull and --from-source builds one instead. Pass one or the other.');
  }
  if (a.localBuild && !a.fromSource) {
    die('--local-build says how to build, and without --from-source there is nothing to build.');
  }
  const buildRoot = a.fromSource ? sourceRoot() : null;
  const image = buildRoot === null ? a.image ?? `${RUNNER_IMAGE_REPO}:${ownVersion()}` : null;

  // --image-only: move the machine to a new image and touch nothing else (no
  // registration, no token, no wake rewrite, no secret staging), so it needs
  // flyctl and no vault login. That is the shape a pipeline wants: the runner
  // image is built beside the vault's, a runner and the vault it serves speak
  // one protocol, and a job holding only a Fly credential can do exactly this
  // much and no more.
  if (a.imageOnly) {
    if (a.allow.length > 0 || a.labels.length > 0) {
      die(
        `${a.allow.length > 0 ? '--allow' : '--labels'} changes the registration, which lives in the vault, and --image-only\n` +
          'deploys without touching the vault. Drop one or the other.'
      );
    }
    await requireFly();
    if (!(await appExists(app))) {
      die(
        `No Fly app named '${app}' that you can see, and --image-only updates one that\n` +
          'already exists. The full deploy creates it:\n\n' +
          `  mochi deploy fly runner ${app} --allow '<globs>'\n`
      );
    }
    const have = await secretNames(app);
    const missing = [HOST_SECRET, TOKEN_SECRET, WAKE_SECRET].filter((n) => !have.includes(n));
    if (missing.length > 0) {
      die(
        `The app is missing ${missing.join(', ')}, so the machine deployed\n` +
          'here could not serve any vault. The full deploy sets them:\n\n' +
          `  mochi deploy fly runner ${app}\n`
      );
    }
    if (!(await namedVolume(app, VOLUME_NAME))) {
      die(`The app has no '${VOLUME_NAME}' volume. The full deploy creates it:\n\n  mochi deploy fly runner ${app}\n`);
    }
    const settings = resolveSettings(a, await liveSettings(app));
    console.log(`==> Updating '${app}' (${appUrl(app)}), touching nothing but the machine`);
    await flyDeploy(app, a, settings, buildRoot, image);
    console.log('');
    console.log(`==> Deployed: ${appUrl(app)}`);
    console.log('');
    console.log('The registration, the runner token, and the wake address were left as they');
    console.log(`were. It stops after ${settings.idle} with no job, and the vault starts it again`);
    console.log('when one is waiting.');
    return;
  }

  // The vault first: a runner with no vault to serve is nothing, and finding
  // out that the login is missing after creating a Fly app would be a poor
  // trade. This is the same login every other admin command uses.
  const target = await remoteTarget(a);
  const existingRunners = await registeredRunners(target);
  const registered = existingRunners.find((r) => r.name === name) ?? null;

  await requireFly();
  const appIsThere = await appExists(app);
  const secrets = appIsThere ? await secretNames(app) : [];

  if (!registered && a.allow.length === 0) {
    die(
      `No runner named '${name}' is registered with ${target.host}, so this deploy would\n` +
        'register one, and a runner needs to be told which repositories it may take jobs\n' +
        'for. It executes whatever their workflows contain, on the machine deployed here:\n\n' +
        `  mochi deploy fly runner ${app} --allow 'mycollection/*'\n`
    );
  }
  // An --allow that repeats what the runner already serves is not a request to
  // change anything, and refusing it would be perverse: a first deploy that
  // registers the runner and then fails at the image leaves exactly that
  // situation, and this command's own advice is to run it again unchanged.
  // Only a different set is refused, because quietly ignoring that would leave
  // an operator believing they had widened or narrowed what the runner serves.
  const sameAllow =
    registered !== null &&
    a.allow.length === registered.allow.length &&
    [...a.allow].sort().join(' ') === [...registered.allow].sort().join(' ');
  if (registered && a.allow.length > 0 && !sameAllow) {
    die(
      `Runner '${name}' is already registered, serving ${registered.allow.join(', ')}.\n` +
        'This deploy does not change that. To change what it serves, remove and register it:\n\n' +
        `  mochi runner remove ${name}\n` +
        `  mochi deploy fly runner ${app} --allow '<globs>'\n`
    );
  }

  const live = appIsThere ? await liveSettings(app) : {};
  const settings = resolveSettings(a, live);
  if (appIsThere && live.region && a.region && a.region !== live.region) {
    die(
      `This runner's volume is in ${live.region}, and a volume cannot be moved to ${a.region}.\n` +
        'Deploy a runner in another region as a second app, or destroy this one first.'
    );
  }

  console.log(appIsThere ? `==> Updating '${app}' (${appUrl(app)})` : `==> Creating '${app}' in ${settings.region}`);
  if (!appIsThere) {
    const created = await flyStream(['apps', 'create', app, ...(a.org ? ['--org', a.org] : [])]);
    if (created !== 0) {
      die(
        `\nCould not create the Fly app '${app}'.\n` +
          'App names are globally unique, so a name in use by anyone stops this. Try another.'
      );
    }
  }

  const vol = await namedVolume(app, VOLUME_NAME);
  if (!vol) {
    console.log(`==> Creating a ${settings.volumeGb}GB volume '${VOLUME_NAME}' in ${settings.region}`);
    console.log('    It holds the images jobs run in, so that stopping when idle costs a boot');
    console.log('    on the next job rather than a download.');
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
    if (code !== 0) die('\nCould not create the volume.');
  } else if (settings.volumeGb > vol.size_gb) {
    console.log(`==> Extending volume '${VOLUME_NAME}' from ${vol.size_gb}GB to ${settings.volumeGb}GB`);
    const code = await flyStream(['volumes', 'extend', vol.id, '-a', app, '--size', String(settings.volumeGb)]);
    if (code !== 0) die('\nCould not extend the volume.');
  } else if (a.volumeGb !== null && a.volumeGb < vol.size_gb) {
    die(
      `The volume is ${vol.size_gb}GB and Fly volumes cannot be shrunk, so --volume ${a.volumeGb} cannot be applied.\n` +
        'Leave the flag off to keep the size it has.'
    );
  }

  // The token this machine will hold. A registration issues one; an existing
  // runner whose token is not already a secret on this app needs a new one,
  // because the old one is unrecoverable by design and there is no way to put
  // it back. Rotating it stops any other machine running as this runner,
  // which for a runner named after this app is the intended outcome.
  const wake = { url: wakeUrlFor(app), secret: newWakeSecret() };
  let runnerToken: string | null = null;
  if (!registered) {
    console.log(`==> Registering runner '${name}' with ${target.host}`);
    const data = await api(target, 'POST', '/api/runners', {
      name,
      labels: a.labels.length ? a.labels : ['ubuntu-latest'],
      allow: a.allow,
      ...(a.jobTimeout === null ? {} : { jobTimeoutMinutes: a.jobTimeout }),
      wakeUrl: wake.url,
      wakeSecret: wake.secret,
    });
    runnerToken = data.token as string;
  } else if (!secrets.includes(TOKEN_SECRET)) {
    console.log(`==> Issuing a token for the registered runner '${name}'`);
    console.log('    Its previous token cannot be read back from anywhere, so this deploy gives it');
    console.log('    a new one. Any other machine running as this runner will stop being able to.');
    const data = await api(target, 'POST', `/api/runners/${encodeURIComponent(name)}/token`, {});
    runnerToken = data.token as string;
  }

  // A timeout named by a flag applies to a runner that was already registered
  // too, on the terms the rest of this command sets: a flag changes the thing
  // it names, and a setting left unnamed keeps whatever the vault has.
  if (a.jobTimeout !== null && registered) {
    await api(target, 'PATCH', `/api/runners/${encodeURIComponent(name)}`, { jobTimeoutMinutes: a.jobTimeout });
  }

  // The wake address is rewritten on every deploy, not only on the first. The
  // secret is this run's, and the app it points at is this app; a redeploy
  // that left an older secret in place would leave the vault sending one the
  // machine has never been given.
  console.log(`==> Pointing the vault's wake request at ${wake.url}`);
  await api(target, 'PUT', `/api/runners/${encodeURIComponent(name)}/wake`, {
    wakeUrl: wake.url,
    wakeSecret: wake.secret,
  });

  // Staged rather than set, so that no machine restarts before the deploy
  // below, and over stdin so that no secret appears in this machine's `ps`.
  const staged = [`${HOST_SECRET}=${target.host}`, `${WAKE_SECRET}=${wake.secret}`];
  if (runnerToken) staged.push(`${TOKEN_SECRET}=${runnerToken}`);
  console.log('==> Setting the vault URL, the runner token, and the wake secret as Fly secrets');
  const set = await fly(['secrets', 'import', '-a', app, '--stage'], staged.join('\n') + '\n');
  if (set.code !== 0) die(`Could not set the secrets:\n${set.stderr.trim() || set.stdout.trim()}`);

  await flyDeploy(app, a, settings, buildRoot, image);
  // A machine is started by the deploy and will stop itself once it has been
  // idle for the configured time. Saying so is worth a line, because a
  // `deploy fly` that ends with a stopped machine looks like a failure to
  // anyone who has deployed a vault before.
  console.log('');
  console.log(`==> Deployed: ${appUrl(app)}`);
  console.log('');
  // Laid out as facts rather than as a sentence broken over three lines: the
  // globs and the labels are lists of unknown length, and wrapping around them
  // put a line break in the middle of a clause.
  const servedLabels = registered?.labels ?? (a.labels.length ? a.labels : ['ubuntu-latest']);
  console.log(`  runner   ${name}, registered with ${target.host}`);
  console.log(`  serving  ${(registered?.allow ?? a.allow).join(', ')}`);
  console.log(`  labels   ${servedLabels.join(', ')}, matched against a job's runs-on`);
  console.log('');
  console.log(`It stops after ${settings.idle} with no job, and the vault starts it again by`);
  console.log('requesting its wake address when a job is waiting. So a machine in the stopped');
  console.log('state is this working, not this broken; the first job after a stop waits about');
  console.log('half a minute for the boot.');
  console.log('');
  console.log('  mochi runner list');
  console.log(`  mochi runner wake ${name}      # start it now, and time how long that takes`);
  console.log(`  fly logs -a ${app}`);
  console.log('');
  console.log(`  mochi deploy fly runner ${app} --vm-size shared-cpu-4x --idle 15m`);
}

export async function deployFlyRunnerShowCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.app) die('Which app? Usage: mochi deploy fly runner show <app>');
  rejectShapingFlags(a, 'mochi deploy fly runner show <app>', false);
  const app = a.app;
  await requireFly();
  if (!(await appExists(app))) {
    die(`No Fly app named '${app}' that you can see. Check the name, or: fly apps list`);
  }
  const vol = await namedVolume(app, VOLUME_NAME);
  const ms = await machines(app);
  const secrets = await secretNames(app);

  console.log(`${app}  ${appUrl(app)}`);
  console.log('');
  if (ms.length === 0) {
    console.log('  machines  none');
  } else {
    for (const m of ms) {
      const g = m.config?.guest as MachineGuest | undefined;
      const shape = g ? `${g.cpu_kind}-cpu-${g.cpus}x, ${g.memory_mb}mb` : 'unknown shape';
      // A stopped runner is the normal resting state, so the state is
      // reported with what it means rather than on its own.
      const meaning = m.state === 'stopped' ? ' (idle; the vault starts it when a job is waiting)' : '';
      console.log(`  machine   ${m.id}  ${m.state ?? '?'}${meaning}  ${m.region ?? '?'}  ${shape}`);
      console.log(`  image     ${m.config?.image ?? 'unknown'}`);
    }
  }
  console.log(vol ? `  volume    ${vol.size_gb}GB in ${vol.region}, holding job images` : '  volume    none');
  console.log(`  vault     ${secrets.includes(HOST_SECRET) ? 'configured as a Fly secret' : 'not configured'}`);
  console.log(`  token     ${secrets.includes(TOKEN_SECRET) ? 'set' : 'not set, so this runner cannot poll'}`);
  console.log(`  wake      ${secrets.includes(WAKE_SECRET) ? wakeUrlFor(app) : 'no secret set, so wake requests are refused'}`);

  // Whether the vault agrees, which is the half Fly cannot answer: an app that
  // is perfectly healthy and a registration that was removed look identical
  // from here.
  try {
    const target = await remoteTarget(a);
    const runners = await registeredRunners(target);
    const mine = runners.filter((r) => r.wakeUrl === wakeUrlFor(app));
    if (mine.length === 0) {
      console.log(`  runner    no runner on ${target.host} is woken at this app`);
    } else {
      for (const r of mine) {
        console.log(`  runner    ${r.name} on ${target.host}, serving ${r.allow.join(', ')}`);
      }
    }
  } catch (e) {
    console.log(`  runner    could not ask the vault: ${e instanceof Error ? e.message : e}`);
  }
  console.log('');
  console.log(`  fly logs -a ${app}`);
}

export async function deployFlyRunnerDestroyCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.app) die('Which app? Usage: mochi deploy fly runner destroy <app> [--yes]');
  rejectShapingFlags(a, 'mochi deploy fly runner destroy <app> [--yes]', true);
  const app = a.app;
  await requireFly();
  if (!(await appExists(app))) {
    die(`No Fly app named '${app}' that you can see. Check the name, or: fly apps list`);
  }

  // Which registration this app was serving, asked before the app is gone,
  // since the wake address is the only thing tying the two together.
  let orphan: string | null = null;
  let target: RemoteTarget | null = null;
  try {
    target = await remoteTarget(a);
    const runners = await registeredRunners(target);
    orphan = runners.find((r) => r.wakeUrl === wakeUrlFor(app))?.name ?? null;
  } catch {
    // A destroy should not require a working login; it only makes the tidying
    // below unavailable.
  }

  if (!a.yes) {
    console.log(`This destroys the Fly app '${app}' and its volume of cached job images.`);
    console.log('Nothing of yours is on it: a runner keeps no state that matters between jobs.');
    if (orphan) console.log(`The runner '${orphan}' stays registered with the vault, and this offers to remove it.`);
    console.log('');
    const answer = await promptLine('Type the app name to confirm: ');
    if (answer !== app) die('Not destroyed.');
  }

  const code = await flyStream(['apps', 'destroy', app, '--yes']);
  if (code !== 0) die('\nCould not destroy the app.');

  if (orphan && target) {
    // A registration whose machine is gone is worse than useless: the vault
    // goes on trying to wake an app that no longer exists, and a queued job
    // waits for a runner that will never poll.
    await api(target, 'DELETE', `/api/runners/${encodeURIComponent(orphan)}`);
    console.log(`Removed the runner registration '${orphan}' from ${target.host}.`);
  } else if (orphan === null) {
    console.log('');
    console.log('No runner registration was found pointing at this app. If one is left behind,');
    console.log('it will keep a queued job waiting for a runner that cannot start:');
    console.log('');
    console.log('  mochi runner list');
    console.log('  mochi runner remove <name>');
  }
}
