import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ActionRef, parseActionRef } from '../ci/actionref';
import { ExprEnv, evalCondition, render, renderDeep, stringify } from '../ci/expr';
import { JobSpec } from '../ci/protocol';
import { WorkflowStep } from '../ci/workflow';
import { ActionDef, ActionError, ActionStore, ResolvedAction, inputEnvName, resolveInputs } from './actions';
import {
  ACTIONS_MOUNT,
  FILE_COMMAND_DIR,
  JobRuntime,
  MAX_ACTION_DEPTH,
  Masker,
  RUNNER_TEMP,
  Scope,
  WORKSPACE,
  contextsFor,
  newScope,
  parseKeyValueFile,
  parseWorkflowCommand,
  shellCommand,
  statusFunctions,
} from './context';
import { execInContainer } from './docker';
import { Externals } from './externals';
import { findOverride } from './overrides';

// Executing steps. One function, `runSteps`, serves both the job's own step
// list and the steps inside a composite action, which is what makes nesting
// work: a composite step is the same machinery with a fresh scope.
//
// A step is one of four things: a `run` script, a JavaScript action, a
// composite action, or an action mochi implements itself because the real
// one talks to a service only GitHub has (see overrides.ts).

export interface StepExecContext {
  containerId: string;
  spec: JobSpec;
  env: Record<string, string>; // the immutable base environment
  rt: JobRuntime;
  masker: Masker;
  actions: ActionStore;
  externals: Externals;
  hostPaths: { workspace: string; temp: string; files: string; actions: string };
  cloneUrl: (collection: string, repo: string) => string;
  // The vault's base URL and the runner's own token, so overrides that stand
  // in for GitHub-hosted services can call the vault's equivalents.
  serverUrl: string;
  runnerToken: string;
  // Translate a path as a step inside the container sees it into the path the
  // runner sees on the host. Actions that hand mochi a path (an artifact to
  // upload, a directory to download into) speak in container paths, while the
  // overrides that implement them work on the host side of the bind mounts.
  // Returns null for an absolute path that is not inside any mount.
  hostPath: (containerPath: string) => string | null;
  log: (line: string) => void;
  // Job-level status, read by success()/failure() and by the default gate.
  status: () => { failed: boolean; cancelled: boolean };
}

export interface StepOutcome {
  // Whether the step's own work succeeded, before continue-on-error.
  ok: boolean;
  // Whether the failure should be treated as one by the caller.
  failed: boolean;
  skipped: boolean;
}

// A step as it appears anywhere: workflow steps and composite steps share a
// shape, and `with` is present only on `uses` steps.
type AnyStep = WorkflowStep & { with?: Record<string, string> };

function envFileTag(index: number): string {
  return `${index}-${crypto.randomBytes(4).toString('hex')}`;
}

export interface RunStepsResult {
  failed: boolean;
  cancelled: boolean;
}

// Run a list of steps in one scope. `onStepState` is called for top-level
// workflow steps only; composite steps report through the log instead, since
// the run page's step list mirrors the workflow file rather than everything
// that executed.
export async function runSteps(
  steps: AnyStep[],
  scope: Scope,
  ctx: StepExecContext,
  hooks: {
    onStart?: (index: number, label: string) => void;
    onEnd?: (index: number, outcome: StepOutcome) => void;
    checkCancelled?: () => boolean;
  } = {}
): Promise<RunStepsResult> {
  let failed = false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const cancelled = hooks.checkCancelled?.() ?? false;
    if (cancelled) return { failed, cancelled: true };

    const stepEnv = buildStepEnv(step, scope, ctx, failed);
    if (stepEnv === null) {
      failed = true;
      hooks.onEnd?.(i, { ok: false, failed: true, skipped: false });
      continue;
    }

    const evalEnv = (): ExprEnv => ({
      contexts: contextsFor({
        spec: ctx.spec,
        scope,
        stepEnv,
        jobFailed: failed || ctx.status().failed,
        jobCancelled: ctx.status().cancelled,
      }),
      functions: statusFunctions(failed || ctx.status().failed, ctx.status().cancelled),
    });

    let shouldRun: boolean;
    try {
      shouldRun = step.if === undefined ? !failed : evalCondition(step.if, evalEnv());
    } catch (e) {
      ctx.log(`Error evaluating if: ${e instanceof Error ? e.message : String(e)}`);
      failed = true;
      hooks.onEnd?.(i, { ok: false, failed: true, skipped: false });
      continue;
    }
    if (!shouldRun) {
      if (step.id) scope.conclusions[step.id] = { outcome: 'skipped', conclusion: 'skipped' };
      hooks.onEnd?.(i, { ok: true, failed: false, skipped: true });
      continue;
    }

    const label = labelOf(step, i, evalEnv);
    hooks.onStart?.(i, label);
    if (scope.depth > 0) ctx.log(`▸ ${label}`);

    let outcome: StepOutcome;
    try {
      outcome = await executeStep(step, scope, ctx, stepEnv, evalEnv, i);
    } catch (e) {
      ctx.log(e instanceof Error ? e.message : String(e));
      outcome = { ok: false, failed: true, skipped: false };
    }

    let continued = false;
    if (!outcome.ok && step.continueOnError !== undefined) {
      try {
        continued = evalCondition(step.continueOnError, evalEnv());
      } catch {
        continued = false;
      }
    }
    if (continued) outcome = { ...outcome, failed: false };
    if (step.id) {
      scope.conclusions[step.id] = {
        outcome: outcome.ok ? 'success' : 'failure',
        conclusion: outcome.failed ? 'failure' : 'success',
      };
    }
    if (outcome.failed) failed = true;
    hooks.onEnd?.(i, outcome);

    // Inside a composite action, a failed step ends the action immediately.
    if (outcome.failed && scope.depth > 0) return { failed: true, cancelled: false };
  }
  return { failed, cancelled: hooks.checkCancelled?.() ?? false };
}

function labelOf(step: AnyStep, index: number, evalEnv: () => ExprEnv): string {
  const resolve = (s: string) => render(s, evalEnv());
  try {
    if (step.name) return resolve(step.name);
  } catch {
    return step.name!;
  }
  if (step.uses) return step.uses;
  if (step.run) {
    let text = step.run;
    try {
      text = resolve(step.run);
    } catch {
      // keep the literal
    }
    const first = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    return `Run ${first.length > 70 ? first.slice(0, 70) + '…' : first}`;
  }
  return `Step ${index + 1}`;
}

// Environment for one step: the base environment, then anything earlier steps
// exported through GITHUB_ENV, then the composite action's env, then the
// step's own. Only the values written in YAML are templates; values that came
// from GITHUB_ENV at runtime are data, and evaluating `${{ }}` found in them
// would let one step's output become an expression in another step's context.
function buildStepEnv(
  step: AnyStep,
  scope: Scope,
  ctx: StepExecContext,
  failedSoFar: boolean
): Record<string, string> | null {
  const stepEnv: Record<string, string> = { ...ctx.env, ...ctx.rt.env };
  const templates = { ...ctx.spec.env, ...scope.actionEnv, ...step.env };
  try {
    const rendered = renderDeep(templates, {
      contexts: contextsFor({
        spec: ctx.spec,
        scope,
        stepEnv,
        jobFailed: failedSoFar || ctx.status().failed,
        jobCancelled: ctx.status().cancelled,
      }),
    }) as Record<string, unknown>;
    // Workflow env first so a runtime value from GITHUB_ENV still wins over
    // it, then the action's and the step's, which win over everything.
    for (const k of Object.keys(ctx.spec.env)) {
      if (k in rendered) stepEnv[k] = stringify(rendered[k] as never);
    }
    for (const [k, v] of Object.entries(ctx.rt.env)) stepEnv[k] = v;
    for (const k of [...Object.keys(scope.actionEnv), ...Object.keys(step.env)]) {
      if (k in rendered) stepEnv[k] = stringify(rendered[k] as never);
    }
  } catch (e) {
    ctx.log(`Error evaluating env: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  return stepEnv;
}

async function executeStep(
  step: AnyStep,
  scope: Scope,
  ctx: StepExecContext,
  stepEnv: Record<string, string>,
  evalEnv: () => ExprEnv,
  index: number
): Promise<StepOutcome> {
  if (step.run !== undefined) {
    const ok = await runShellStep(step, scope, ctx, stepEnv, evalEnv, index);
    return { ok, failed: !ok, skipped: false };
  }
  if (step.uses !== undefined) {
    const ok = await runActionStep(step, scope, ctx, stepEnv, evalEnv, index);
    return { ok, failed: !ok, skipped: false };
  }
  ctx.log('a step needs either run: or uses:');
  return { ok: false, failed: true, skipped: false };
}

// ---- run: steps ----

interface FileCommandSet {
  output: string;
  envFile: string;
  pathFile: string;
  summary: string;
  state: string;
}

async function makeFileCommands(ctx: StepExecContext, tag: string): Promise<FileCommandSet> {
  const files: FileCommandSet = {
    output: `${FILE_COMMAND_DIR}/output-${tag}`,
    envFile: `${FILE_COMMAND_DIR}/env-${tag}`,
    pathFile: `${FILE_COMMAND_DIR}/path-${tag}`,
    summary: `${FILE_COMMAND_DIR}/summary-${tag}`,
    state: `${FILE_COMMAND_DIR}/state-${tag}`,
  };
  for (const f of Object.values(files)) writeJobFile(ctx, f, '');
  return files;
}

// The file-command directory is a bind mount of a directory the runner owns,
// so the files a step appends to are created and read back on the host. This
// used to go through `docker exec --interactive ... cat`, one exec per file,
// which has a race: when stdin is closed before the exec has attached, the
// EOF is lost and cat waits forever, and so did the job, until its timeout.
// An empty file is the widest case of that window, since there is no data
// write to sequence against. The files are world-writable because the step
// appends to them as whatever user the image runs, which need not be the
// runner's.
function writeJobFile(ctx: StepExecContext, containerPath: string, content: string): void {
  const host = ctx.hostPath(containerPath);
  if (host === null) throw new Error(`${containerPath} is not on a mount the runner can write`);
  fs.writeFileSync(host, content);
  try {
    fs.chmodSync(host, 0o666);
  } catch {
    // the runner and the container being the same user, which is the common
    // case, needs no wider mode
  }
}

function readJobFile(ctx: StepExecContext, containerPath: string): string {
  const host = ctx.hostPath(containerPath);
  if (host === null) return '';
  try {
    return fs.readFileSync(host, 'utf8');
  } catch {
    return '';
  }
}

function fileCommandEnv(files: FileCommandSet): Record<string, string> {
  return {
    GITHUB_OUTPUT: files.output,
    GITHUB_ENV: files.envFile,
    GITHUB_PATH: files.pathFile,
    GITHUB_STEP_SUMMARY: files.summary,
    GITHUB_STATE: files.state,
  };
}

// Read back everything a step wrote through the file commands, and fold it
// into the scope and the job runtime.
async function collectFileCommands(
  ctx: StepExecContext,
  scope: Scope,
  files: FileCommandSet,
  stepId: string | undefined
): Promise<void> {
  const outputText = readJobFile(ctx, files.output);
  const parsed = parseKeyValueFile(outputText);
  if (stepId && Object.keys(parsed).length) {
    scope.outputs[stepId] = { ...(scope.outputs[stepId] ?? {}), ...parsed };
  }
  const envText = readJobFile(ctx, files.envFile);
  Object.assign(ctx.rt.env, parseKeyValueFile(envText));
  const pathText = readJobFile(ctx, files.pathFile);
  for (const line of pathText.split('\n')) {
    const p = line.trim();
    if (p !== '' && !ctx.rt.extraPath.includes(p)) ctx.rt.extraPath.unshift(p);
  }
  const summaryText = readJobFile(ctx, files.summary);
  if (summaryText.trim() !== '') ctx.rt.summaries.push(summaryText);
}

function pathEnv(ctx: StepExecContext, stepEnv: Record<string, string>): Record<string, string> {
  if (ctx.rt.extraPath.length === 0) return {};
  const existing = stepEnv.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return { PATH: `${ctx.rt.extraPath.join(':')}:${existing}` };
}

function workdirFor(
  step: AnyStep,
  ctx: StepExecContext,
  scope: Scope,
  evalEnv: () => ExprEnv
): string {
  const wd = step.workingDirectory ?? (scope.depth === 0 ? ctx.spec.defaults?.workingDirectory : undefined);
  if (!wd) return WORKSPACE;
  try {
    const rendered = render(wd, evalEnv());
    return rendered.startsWith('/') ? rendered : `${WORKSPACE}/${rendered}`;
  } catch {
    return WORKSPACE;
  }
}

// Interpret one line of a step's output: either a workflow command, or text.
function makeLineHandler(
  ctx: StepExecContext,
  scope: Scope,
  stepId: string | undefined
): (raw: string) => void {
  return (raw: string) => {
    const cmd = parseWorkflowCommand(raw);
    if (!cmd) {
      ctx.log(raw);
      return;
    }
    switch (cmd.name) {
      case 'add-mask':
        ctx.masker.add(cmd.message);
        break;
      case 'group':
        ctx.log(`▾ ${cmd.message}`);
        break;
      case 'endgroup':
        break;
      case 'error':
      case 'warning':
      case 'notice': {
        const where = cmd.props.file ? ` (${cmd.props.file}${cmd.props.line ? `:${cmd.props.line}` : ''})` : '';
        ctx.log(`${cmd.name.toUpperCase()}${where}: ${cmd.message}`);
        break;
      }
      case 'debug':
        // Actions are chatty at debug level; GitHub hides these unless the
        // run was started with debug logging, and so does mochi.
        if (ctx.env.RUNNER_DEBUG === '1') ctx.log(`DEBUG: ${cmd.message}`);
        break;
      case 'set-output':
        if (stepId && cmd.props.name) {
          scope.outputs[stepId] = { ...(scope.outputs[stepId] ?? {}), [cmd.props.name]: cmd.message };
        }
        break;
      case 'set-env':
        if (cmd.props.name) ctx.rt.env[cmd.props.name] = cmd.message;
        break;
      case 'add-path':
        if (cmd.message && !ctx.rt.extraPath.includes(cmd.message)) ctx.rt.extraPath.unshift(cmd.message);
        break;
      case 'echo':
      case 'save-state':
      case 'stop-commands':
        break;
      // Problem matchers annotate a run's diff on GitHub. mochi has no
      // equivalent yet, so the commands are consumed rather than printed.
      case 'add-matcher':
      case 'remove-matcher':
        break;
      default:
        ctx.log(raw);
    }
  };
}

async function runShellStep(
  step: AnyStep,
  scope: Scope,
  ctx: StepExecContext,
  stepEnv: Record<string, string>,
  evalEnv: () => ExprEnv,
  index: number
): Promise<boolean> {
  let script: string;
  try {
    script = render(step.run ?? '', evalEnv());
  } catch (e) {
    ctx.log(`Error evaluating the step body: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  const tag = envFileTag(index);
  const files = await makeFileCommands(ctx, tag);
  const scriptPath = `${FILE_COMMAND_DIR}/step-${tag}`;
  writeJobFile(ctx, scriptPath, script.endsWith('\n') ? script : script + '\n');

  const shell = step.shell ?? (scope.depth === 0 ? ctx.spec.defaults?.shell : undefined);
  const env: Record<string, string> = {
    ...stepEnv,
    ...fileCommandEnv(files),
    ...pathEnv(ctx, stepEnv),
    GITHUB_ACTION: step.id ?? `__run_${index}`,
  };
  if (scope.actionPath) env.GITHUB_ACTION_PATH = scope.actionPath;

  const handle = execInContainer(ctx.containerId, shellCommand(shell, scriptPath), makeLineHandler(ctx, scope, step.id), {
    workdir: workdirFor(step, ctx, scope, evalEnv),
    env,
  });
  const code = await handle.done;
  await collectFileCommands(ctx, scope, files, step.id);
  if (code !== 0) ctx.log(`Process completed with exit code ${code}.`);
  return code === 0;
}

// ---- uses: steps ----

async function runActionStep(
  step: AnyStep,
  scope: Scope,
  ctx: StepExecContext,
  stepEnv: Record<string, string>,
  evalEnv: () => ExprEnv,
  index: number
): Promise<boolean> {
  if (scope.depth >= MAX_ACTION_DEPTH) {
    ctx.log(`actions are nested more than ${MAX_ACTION_DEPTH} deep; refusing to go further`);
    return false;
  }

  let ref: ActionRef;
  try {
    ref = parseActionRef(render(step.uses!, evalEnv()));
  } catch (e) {
    ctx.log(e instanceof Error ? e.message : String(e));
    return false;
  }

  // `with:` values are templates evaluated in the calling scope.
  const provided: Record<string, string> = {};
  try {
    for (const [k, v] of Object.entries(step.with ?? {})) provided[k] = render(v, evalEnv());
  } catch (e) {
    ctx.log(`Error evaluating with: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  // An override stands in for actions that talk to services only GitHub has.
  // It is chosen by the `uses:` string, so it applies at any nesting depth,
  // including inside someone else's composite action.
  const override = findOverride(ref);
  if (override) {
    ctx.log(`Using mochi's built-in ${override.name} (${ref.raw})`);
    try {
      const result = await override.run({
        ctx,
        ref,
        inputs: provided,
        stepEnv,
      });
      if (result.outputs && step.id) {
        scope.outputs[step.id] = { ...(scope.outputs[step.id] ?? {}), ...result.outputs };
      }
      return result.ok;
    } catch (e) {
      ctx.log(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  let resolved: ResolvedAction;
  try {
    resolved = await ctx.actions.resolve(ref, ctx.hostPaths.workspace, (l) => ctx.log(l));
  } catch (e) {
    ctx.log(e instanceof Error ? e.message : String(e));
    return false;
  }

  const { values, missing } = resolveInputs(resolved.def, provided);
  if (missing.length) {
    ctx.log(`${ref.raw} requires the input${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    return false;
  }

  const containerDir = await stageAction(ctx, ref, resolved);

  if (resolved.def.runs.using === 'composite') {
    return runCompositeAction(step, scope, ctx, resolved, containerDir, values, index);
  }
  if (resolved.def.runs.using === 'node') {
    return runNodeAction(step, scope, ctx, ref, resolved, containerDir, values, stepEnv, index);
  }
  ctx.log(`docker actions are not supported yet (uses: ${ref.raw})`);
  return false;
}

// Copy the action's files into the job's own directory. The cache holds the
// pristine download; the container sees a per-job copy, so an action that
// writes into its own directory cannot poison the next job's copy.
async function stageAction(ctx: StepExecContext, ref: ActionRef, resolved: ResolvedAction): Promise<string> {
  const name = `${resolved.key}${ref.kind === 'repo' && ref.subpath ? '__' + ref.subpath.replace(/\//g, '--') : ''}`;
  const hostDir = path.join(ctx.hostPaths.actions, name);
  if (!fs.existsSync(hostDir)) {
    fs.mkdirSync(path.dirname(hostDir), { recursive: true });
    fs.cpSync(resolved.dir, hostDir, { recursive: true, dereference: false });
  }
  return `${ACTIONS_MOUNT}/${name}`;
}

async function runNodeAction(
  step: AnyStep,
  scope: Scope,
  ctx: StepExecContext,
  ref: ActionRef,
  resolved: ResolvedAction,
  containerDir: string,
  inputs: Record<string, string>,
  stepEnv: Record<string, string>,
  index: number
): Promise<boolean> {
  const runs = resolved.def.runs;
  if (runs.using !== 'node') return false;
  const node = await ctx.externals.nodeFor(ctx.containerId, runs.nodeMajor, (l) => ctx.log(l));

  const runScript = async (script: string, label: string, stepId: string | undefined): Promise<boolean> => {
    const tag = envFileTag(index);
    const files = await makeFileCommands(ctx, tag);
    const env: Record<string, string> = {
      ...stepEnv,
      ...fileCommandEnv(files),
      ...pathEnv(ctx, stepEnv),
      GITHUB_ACTION: stepId ?? `__action_${index}`,
      GITHUB_ACTION_PATH: containerDir,
      GITHUB_ACTION_REPOSITORY: ref.kind === 'repo' ? `${ref.owner}/${ref.repo}` : '',
    };
    for (const [name, value] of Object.entries(inputs)) env[inputEnvName(name)] = value;
    const handle = execInContainer(
      ctx.containerId,
      [node, `${containerDir}/${script}`],
      makeLineHandler(ctx, scope, stepId),
      { workdir: WORKSPACE, env }
    );
    const code = await handle.done;
    await collectFileCommands(ctx, scope, files, stepId);
    if (code !== 0) ctx.log(`${label} completed with exit code ${code}.`);
    return code === 0;
  };

  if (runs.pre) {
    // A pre script runs before the action's main, and its failure is the
    // step's failure. `pre-if` gates it the way `post-if` gates the post
    // script; an unparseable condition runs the script, since skipping setup
    // silently is the worse of the two failures.
    let should = true;
    if (runs.preIf !== undefined) {
      const jobFailed = ctx.status().failed;
      const jobCancelled = ctx.status().cancelled;
      try {
        should = evalCondition(runs.preIf, {
          contexts: contextsFor({ spec: ctx.spec, scope, stepEnv: ctx.env, jobFailed, jobCancelled }),
          functions: statusFunctions(jobFailed, jobCancelled),
        });
      } catch {
        should = true;
      }
    }
    if (should && !(await runScript(runs.pre, 'The pre step', step.id))) return false;
  }

  const ok = await runScript(runs.main, 'Process', step.id);

  if (runs.post) {
    // Post steps run after every step in the job, in reverse order, which is
    // how cleanup (checkout's git config, a cache save) is expected to work.
    const label = step.name ?? step.uses ?? 'action';
    ctx.rt.postHooks.push({
      label: `Post ${label}`,
      condition: runs.postIf,
      run: async () => {
        ctx.log(`▸ Post ${label}`);
        await runScript(runs.post!, 'The post step', undefined);
      },
    });
  }
  return ok;
}

async function runCompositeAction(
  step: AnyStep,
  scope: Scope,
  ctx: StepExecContext,
  resolved: ResolvedAction,
  containerDir: string,
  inputs: Record<string, string>,
  index: number
): Promise<boolean> {
  const runs = resolved.def.runs;
  if (runs.using !== 'composite') return false;

  const inner = newScope(scope.depth + 1);
  inner.inputs = inputs;
  inner.actionPath = containerDir;

  const result = await runSteps(runs.steps, inner, ctx);
  if (result.failed) return false;

  // The action's outputs are expressions over its own steps.
  if (step.id && Object.keys(resolved.def.outputs).length) {
    const env: ExprEnv = {
      contexts: contextsFor({
        spec: ctx.spec,
        scope: inner,
        stepEnv: ctx.env,
        jobFailed: false,
        jobCancelled: false,
      }),
      functions: statusFunctions(false, false),
    };
    const outputs: Record<string, string> = {};
    for (const [name, def] of Object.entries(resolved.def.outputs)) {
      if (def.value === undefined) continue;
      try {
        outputs[name] = render(def.value, env);
      } catch {
        outputs[name] = '';
      }
    }
    scope.outputs[step.id] = { ...(scope.outputs[step.id] ?? {}), ...outputs };
  }
  void index;
  return true;
}

// ---- post hooks ----

export async function runPostHooks(ctx: StepExecContext, jobFailed: boolean): Promise<void> {
  const hooks = [...ctx.rt.postHooks].reverse();
  ctx.rt.postHooks.length = 0;
  for (const hook of hooks) {
    if (hook.condition !== undefined) {
      const env: ExprEnv = {
        contexts: contextsFor({
          spec: ctx.spec,
          scope: newScope(0),
          stepEnv: ctx.env,
          jobFailed,
          jobCancelled: ctx.status().cancelled,
        }),
        functions: statusFunctions(jobFailed, ctx.status().cancelled),
      };
      let should = true;
      try {
        should = evalCondition(hook.condition, env);
      } catch {
        should = true;
      }
      if (!should) continue;
    }
    try {
      await hook.run(jobFailed);
    } catch (e) {
      ctx.log(`${hook.label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export { ActionError, ActionDef, RUNNER_TEMP };
