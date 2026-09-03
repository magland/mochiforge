import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { ExprEnv, render } from '../ci/expr';
import { JobSpec } from '../ci/protocol';
import { Conclusion, StepState } from '../ci/runs';
import { ActionStore } from './actions';
import {
  ACTIONS_MOUNT,
  FILE_COMMAND_DIR,
  JobRuntime,
  Masker,
  RUNNER_TEMP,
  RUNNER_TOOL_CACHE,
  Scope,
  WORKSPACE,
  baseEnv,
  contextsFor,
  newScope,
  statusFunctions,
  stepLabel,
} from './context';
import { execInContainer, imagePresent, pullImage, removeContainer, startContainer, ContainerLimits } from './docker';
import { EXTERNALS_MOUNT, Externals } from './externals';
import { StepExecContext, runPostHooks, runSteps } from './steps';

// Running one job: prepare the workspace, start the container, drive the
// steps, run whatever post hooks the steps registered, and decide the
// conclusion. Everything below the step boundary lives in steps.ts.

export interface JobHooks {
  log: (stepIndex: number, line: string) => void;
  progress: (steps: StepState[]) => void;
  cancelled: () => boolean;
}

export interface RunnerContext {
  imageFor: (labels: string[]) => string;
  cloneUrl: (collection: string, repo: string) => string;
  workDir: string;
  network?: string;
  limits?: ContainerLimits;
  actions: ActionStore;
  externals: Externals;
  serverUrl: string;
  runnerToken: string;
}

export interface JobResult {
  conclusion: Conclusion;
  steps: StepState[];
  outputs: Record<string, string>;
  summaries: string[];
}

// Step index -1 carries the runner's own setup, post-step, and teardown
// output, so anything happening outside the workflow's steps still has
// somewhere to be reported.
const RUNNER_STEP = -1;

function nowIso(): string {
  return new Date().toISOString();
}

function execFileAsync(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim()));
      else resolve(stdout.toString());
    });
  });
}

export async function runJob(spec: JobSpec, ctx: RunnerContext, hooks: JobHooks): Promise<JobResult> {
  const image = ctx.imageFor(spec.runsOn);
  const masker = new Masker();
  const env = baseEnv(spec);
  const stepStates: StepState[] = spec.steps.map((s, i) => ({ name: stepLabel(s, i), status: 'pending' }));
  const rt: JobRuntime = { env: {}, extraPath: [], summaries: [], postHooks: [] };
  const scope: Scope = newScope(0);

  let currentStep = RUNNER_STEP;
  let failed = false;
  const log = (line: string) => hooks.log(currentStep, masker.apply(line));

  // The work directory is made per job rather than once at startup. A runner
  // is a long-lived process and its default work directory is under /tmp,
  // where a tmp cleaner or an operator can remove it between jobs; recreating
  // it here costs nothing and turns a run that failed before its first step
  // with a bare ENOENT into one that simply runs.
  fs.mkdirSync(ctx.workDir, { recursive: true });
  const hostWork = fs.mkdtempSync(path.join(ctx.workDir, 'job-'));
  const hostRepo = path.join(hostWork, 'workspace');
  const hostTemp = path.join(hostWork, 'temp');
  const hostFiles = path.join(hostWork, 'files');
  const hostActions = path.join(hostWork, 'actions');
  for (const d of [hostRepo, hostTemp, hostFiles, hostActions]) fs.mkdirSync(d, { recursive: true });

  let containerId: string | null = null;
  // `timeout-minutes` is enforced here rather than by the server: the lease
  // sweep only notices a runner that has stopped heartbeating, and a job stuck
  // inside a step heartbeats perfectly well. Cancellation is cooperative and
  // checked between steps, so a deadline that only set the flag would never
  // interrupt the step that is actually hanging; removing the container is what
  // makes the in-flight exec fail and the loop unwind.
  let timedOut = false;
  let deadline: NodeJS.Timeout | null = null;
  const cancelled = () => hooks.cancelled() || timedOut;

  const finish = async (conclusion: Conclusion): Promise<JobResult> => {
    currentStep = RUNNER_STEP;
    if (deadline) clearTimeout(deadline);
    if (containerId) {
      log('Cleaning up the job container');
      await removeContainer(containerId);
    }
    try {
      fs.rmSync(hostWork, { recursive: true, force: true });
    } catch {
      // a leftover directory is not worth failing the job over
    }
    return {
      conclusion,
      steps: stepStates,
      outputs: resolveJobOutputs(spec, scope, conclusion === 'failure', conclusion === 'cancelled'),
      summaries: rt.summaries,
    };
  };

  try {
    // mochi checks the repository out before the job starts, rather than
    // leaving an empty workspace for actions/checkout to fill. See the README:
    // it makes run: steps useful on their own, and it means checkout is a
    // re-sync rather than the first clone.
    log(`Job ${spec.name} on ${spec.runsOn.join(', ')}`);
    log(`Checking out ${spec.github.repository} at ${spec.sha.slice(0, 8)}`);
    // A private repository's job carries an ephemeral token for it, which
    // rides in the remote URL the way actions/checkout persists credentials:
    // steps that fetch or pull from origin then work unchanged. It expires
    // with the job either way.
    const url = ctx.cloneUrl(spec.address.collection, spec.address.repo);
    const remote = spec.cloneToken
      ? url.replace('://', `://x-job:${encodeURIComponent(spec.cloneToken)}@`)
      : url;
    await execFileAsync('git', ['init', '--quiet', hostRepo]);
    await execFileAsync('git', ['-C', hostRepo, 'remote', 'add', 'origin', remote]);
    await execFileAsync('git', ['-C', hostRepo, 'fetch', '--quiet', '--depth', '1', 'origin', spec.sha]);
    await execFileAsync('git', ['-C', hostRepo, 'checkout', '--quiet', 'FETCH_HEAD']);

    fs.writeFileSync(path.join(hostTemp, 'event.json'), JSON.stringify(spec.github.event ?? {}, null, 1));

    if (!(await imagePresent(image))) {
      log(`Pulling ${image}`);
      await pullImage(image, log);
    }
    const externalsDir = ctx.externals.hostDir();
    fs.mkdirSync(externalsDir, { recursive: true });
    containerId = await startContainer({
      image,
      name: containerName(spec),
      binds: [
        { host: hostRepo, container: WORKSPACE },
        { host: hostTemp, container: RUNNER_TEMP },
        { host: hostFiles, container: FILE_COMMAND_DIR },
        { host: hostActions, container: ACTIONS_MOUNT },
        // Read-only: the provided node binaries are shared by every job on
        // this runner, so nothing a job does may change them.
        { host: externalsDir, container: EXTERNALS_MOUNT, readonly: true },
      ],
      env,
      workdir: WORKSPACE,
      network: ctx.network,
      limits: ctx.limits,
    });
    await execInContainer(containerId, ['mkdir', '-p', RUNNER_TOOL_CACHE], () => {}).done;
    log(`Container started from ${image}`);

    const id = containerId;
    // A runner and its server are separate long-running processes and need not
    // be the same version, so a spec that carries no usable timeout falls back
    // to GitHub's six hours rather than to NaN, which setTimeout would treat as
    // zero and fire against every job immediately.
    const minutes = Number(spec.timeoutMinutes);
    const limit = Number.isFinite(minutes) && minutes > 0 ? minutes : 360;
    // setTimeout counts in a signed 32-bit millisecond field and fires at once
    // on anything larger, so an absurd timeout-minutes has to be capped rather
    // than passed through: uncapped, it would do the opposite of what it asks.
    const delay = Math.min(limit * 60_000, 2 ** 31 - 1);
    deadline = setTimeout(() => {
      timedOut = true;
      log(`Job exceeded its timeout of ${limit} minute${limit === 1 ? '' : 's'}`);
      void removeContainer(id);
    }, delay);

    const exec: StepExecContext = {
      containerId,
      spec,
      env,
      rt,
      masker,
      actions: ctx.actions,
      externals: ctx.externals,
      hostPaths: { workspace: hostRepo, temp: hostTemp, files: hostFiles, actions: hostActions },
      cloneUrl: ctx.cloneUrl,
      serverUrl: ctx.serverUrl,
      runnerToken: ctx.runnerToken,
      hostPath: (p) => {
        if (!path.isAbsolute(p)) return path.resolve(hostRepo, p);
        for (const [mount, host] of [
          [WORKSPACE, hostRepo],
          [RUNNER_TEMP, hostTemp],
          [FILE_COMMAND_DIR, hostFiles],
          [ACTIONS_MOUNT, hostActions],
        ] as const) {
          if (p === mount) return host;
          if (p.startsWith(mount + '/')) return path.join(host, p.slice(mount.length + 1));
        }
        return null;
      },
      log: (line) => log(line),
      status: () => ({ failed, cancelled: cancelled() }),
    };

    const result = await runSteps(spec.steps, scope, exec, {
      onStart: (i, label) => {
        currentStep = i;
        stepStates[i].status = 'running';
        stepStates[i].startedAt = nowIso();
        stepStates[i].name = label;
        hooks.progress(stepStates);
        log(`▸ ${label}`);
      },
      onEnd: (i, outcome) => {
        const state = stepStates[i];
        state.status = 'completed';
        state.completedAt = state.completedAt ?? nowIso();
        state.conclusion = outcome.skipped ? 'skipped' : outcome.failed ? 'failure' : 'success';
        if (outcome.failed) failed = true;
        currentStep = RUNNER_STEP;
        hooks.progress(stepStates);
      },
      checkCancelled: () => cancelled(),
    });
    failed = failed || result.failed;

    // Post steps run even when the job failed or was cancelled, which is what
    // makes them useful for cleanup. A timeout is the exception: the container
    // they would run in is the thing that was torn down to stop the job, so
    // attempting them would only add a failure for each one to the log.
    if (rt.postHooks.length && !timedOut) {
      currentStep = RUNNER_STEP;
      await runPostHooks(exec, failed);
    }

    // A job that ran out of time is a failure, as it is on GitHub; only the
    // server asking for the job back is a cancellation.
    if (timedOut) return await finish('failure');
    if (result.cancelled || hooks.cancelled()) return await finish('cancelled');
    return await finish(failed ? 'failure' : 'success');
  } catch (e) {
    currentStep = RUNNER_STEP;
    log(`Job failed to run: ${e instanceof Error ? e.message : String(e)}`);
    return await finish(!timedOut && hooks.cancelled() ? 'cancelled' : 'failure');
  }
}

function containerName(spec: JobSpec): string {
  const raw = `mochi-${spec.address.collection}-${spec.address.repo}-${spec.runNumber}-${spec.address.job}-${crypto
    .randomBytes(4)
    .toString('hex')}`;
  return raw.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
}

function resolveJobOutputs(
  spec: JobSpec,
  scope: Scope,
  jobFailed: boolean,
  jobCancelled: boolean
): Record<string, string> {
  const out: Record<string, string> = {};
  if (Object.keys(spec.outputsTemplate).length === 0) return out;
  // The job's own outcome, not a placeholder: an output written as
  // `${{ success() && ... }}` is a common way to hand a downstream job
  // something only when this one worked, and a hardcoded success() would
  // hand it over after a failure too.
  const env: ExprEnv = {
    contexts: contextsFor({ spec, scope, stepEnv: {}, jobFailed, jobCancelled }),
    functions: statusFunctions(jobFailed, jobCancelled),
  };
  for (const [k, template] of Object.entries(spec.outputsTemplate)) {
    try {
      out[k] = render(template, env);
    } catch {
      out[k] = '';
    }
  }
  return out;
}

export function defaultWorkDir(): string {
  const dir = path.join(os.tmpdir(), 'mochi-runner');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export { parseWorkflowCommand, parseKeyValueFile } from './context';
