import { ChildProcess, execFile, spawn } from 'child_process';

// The Docker surface the runner needs, as thin wrappers over the CLI rather
// than the Engine API socket. Shelling out keeps the runner dependency-free
// and works with anything that provides the docker command set; `podman`
// answers the same arguments, so the binary is a setting rather than a fact.

export class DockerError extends Error {}

// Which binary carries the commands below. Set once at startup by whichever
// CLI is running (see setContainerEngine); every wrapper reads it, so a
// runner told to use podman uses it for everything or for nothing.
let engineBin = 'docker';

export function setContainerEngine(bin: 'docker' | 'podman'): void {
  engineBin = bin;
}

export function containerEngine(): string {
  return engineBin;
}

function run(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(engineBin, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new DockerError(`${engineBin} ${args[0]} failed: ${(stderr || err.message).trim()}`));
      else resolve({ stdout, stderr });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export async function dockerAvailable(): Promise<string | null> {
  try {
    const { stdout } = await run(['version', '--format', '{{.Server.Version}}']);
    return stdout.trim() || 'unknown';
  } catch {
    return null;
  }
}

/**
 * What a given binary would report as its server version, without changing
 * which one this process uses. The CLIs ask this of both `docker` and
 * `podman` to offer a choice; a binary that is missing, or present with no
 * working daemon behind it, answers null either way, since a runner cares
 * only whether containers can actually be started.
 */
export function probeEngine(bin: 'docker' | 'podman'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['version', '--format', '{{.Server.Version}}'], { timeout: 15000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.toString().trim() || 'unknown');
    });
  });
}

export async function imagePresent(image: string): Promise<boolean> {
  try {
    await run(['image', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}

export function pullImage(image: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(engineBin, ['pull', image]);
    const feed = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.trim() !== '') onLine(line.replace(/\r/g, ''));
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => reject(new DockerError(`docker pull failed: ${e.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new DockerError(`docker pull ${image} exited ${code}`))
    );
  });
}

/**
 * What one job's container may consume of the machine. A runner serves every
 * repository its allow list names, and their jobs take turns on one daemon,
 * so a job that forks without end or allocates until the kernel intervenes
 * is not only its own failure: it is the next repository's job not running.
 * The wall-clock timeout bounds how long a job may take, and these bound how
 * much of the machine it may take while it does.
 */
export interface ContainerLimits {
  /** As docker's --memory takes it: "2g", "512m". */
  memory?: string;
  /** As docker's --cpus takes it: "2", "0.5". */
  cpus?: string;
  /** The most processes the container may hold at once. */
  pids?: number;
}

/**
 * Processes without a bound are the cheapest way to take a machine down and
 * the one no job legitimately needs, so the ceiling is on unless the operator
 * says otherwise; a build that wants more than this many at once is rare
 * enough to be asked for by name. Memory and CPU have no default: what a job
 * may reasonably want depends on the machine, and a cap that is wrong for it
 * fails honest builds rather than protecting anything.
 */
export const DEFAULT_PIDS_LIMIT = 4096;

/** The label every job container carries, so a runner can find the ones a crash left behind. */
export const JOB_CONTAINER_LABEL = 'mochi.job';

export interface ContainerOptions {
  image: string;
  name: string;
  binds: { host: string; container: string; readonly?: boolean }[];
  env: Record<string, string>;
  workdir: string;
  network?: string;
  limits?: ContainerLimits;
}

// One container per job, kept alive by a sleep so each step can exec into
// it. This is how a container job behaves on GitHub: steps share a
// filesystem and a process namespace, and anything a step installs is there
// for the next one.
export async function startContainer(opts: ContainerOptions): Promise<string> {
  const args = ['run', '--detach', '--name', opts.name, '--workdir', opts.workdir, '--entrypoint', ''];
  args.push('--label', `${JOB_CONTAINER_LABEL}=1`);
  for (const b of opts.binds) {
    args.push('--volume', `${b.host}:${b.container}${b.readonly ? ':ro' : ''}`);
  }
  for (const [k, v] of Object.entries(opts.env)) {
    args.push('--env', `${k}=${v}`);
  }
  if (opts.network) args.push('--network', opts.network);
  const limits = opts.limits ?? {};
  const pids = limits.pids ?? DEFAULT_PIDS_LIMIT;
  if (pids > 0) args.push('--pids-limit', String(pids));
  if (limits.memory) args.push('--memory', limits.memory);
  if (limits.cpus) args.push('--cpus', limits.cpus);
  args.push(opts.image, 'sh', '-c', 'while true; do sleep 3600; done');
  const { stdout } = await run(args);
  return stdout.trim();
}

/**
 * Remove every job container on this daemon, and say how many there were.
 *
 * A job's container is removed when the job finishes or times out, and by
 * nothing else: a runner killed mid-job, or a machine that lost power, leaves
 * a container running its idle sleep for good, and on a machine whose docker
 * directory is a persistent volume, they accumulate across restarts. This
 * runs when a runner starts, when by construction no job of its own is in
 * flight. A daemon shared with a second runner would lose that runner's
 * running job here, which is one more reason not to share one.
 */
export async function removeStaleJobContainers(): Promise<number> {
  const { stdout } = await run(['ps', '--all', '--quiet', '--filter', `label=${JOB_CONTAINER_LABEL}`]);
  const ids = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  for (const id of ids) await removeContainer(id);
  return ids.length;
}

export async function removeContainer(id: string): Promise<void> {
  try {
    await run(['rm', '--force', '--volumes', id]);
  } catch {
    // a container that is already gone is the desired state
  }
}

export interface ExecOptions {
  workdir?: string;
  env?: Record<string, string>;
  user?: string;
}

export interface ExecHandle {
  child: ChildProcess;
  done: Promise<number>;
}

// Exec a command in a running container, streaming combined output. stdout
// and stderr are interleaved into one callback because that is what a build
// log is: their relative order matters more than their separation.
export function execInContainer(
  id: string,
  argv: string[],
  onLine: (line: string) => void,
  opts: ExecOptions = {}
): ExecHandle {
  const args = ['exec'];
  if (opts.workdir) args.push('--workdir', opts.workdir);
  if (opts.user) args.push('--user', opts.user);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push('--env', `${k}=${v}`);
  args.push(id, ...argv);
  const child = spawn(engineBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Split on newlines across chunk boundaries, and cap any single line so a
  // program printing a gigabyte without a newline cannot exhaust memory.
  const makeFeeder = () => {
    let buffer = '';
    return (buf: Buffer) => {
      buffer += buf.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\n')) !== -1) {
        onLine(buffer.slice(0, i).replace(/\r$/, ''));
        buffer = buffer.slice(i + 1);
      }
      if (buffer.length > 64 * 1024) {
        onLine(buffer.slice(0, 64 * 1024));
        buffer = buffer.slice(64 * 1024);
      }
    };
    };
  const outFeed = makeFeeder();
  const errFeed = makeFeeder();
  child.stdout?.on('data', outFeed);
  child.stderr?.on('data', errFeed);

  const done = new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    child.on('error', (e) => {
      onLine(`docker exec failed: ${e.message}`);
      finish(126);
    });
    child.on('close', (code) => finish(code === null ? 143 : code));
  });
  return { child, done };
}

// Copy a file into a container. `docker cp` from stdin needs a tar stream, so
// the simpler route for the small files the runner writes (step scripts, the
// environment files) is to pipe the bytes through a shell redirect.
export function writeFileInContainer(id: string, containerPath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      engineBin,
      ['exec', '--interactive', id, 'sh', '-c', `cat > "$0"`, containerPath],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (e) => reject(new DockerError(e.message)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new DockerError(`writing ${containerPath} failed: ${stderr.trim()}`))
    );
    child.stdin?.write(content);
    child.stdin?.end();
  });
}

export async function readFileInContainer(id: string, containerPath: string): Promise<string> {
  try {
    const { stdout } = await run(['exec', id, 'sh', '-c', `cat "$0" 2>/dev/null || true`, containerPath]);
    return stdout;
  } catch {
    return '';
  }
}
