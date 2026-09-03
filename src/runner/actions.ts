import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { ActionRef, actionCacheKey, commitPrefix, refIsImmutable } from '../ci/actionref';
import { WorkflowStep } from '../ci/workflow';
import { downloadTo } from './download';

// Fetching actions and reading their definitions. Actions come from a forge
// over HTTPS (github.com by default) as a source tarball, and are cached on
// the runner's disk so a repeated job does not re-download them.
//
// Nothing here executes anything: the store hands back a directory and a
// parsed action.yml, and steps.ts decides what to do with them.

// The most an action's source archive may be. The largest actions in common
// use are a few megabytes of bundled JavaScript; this is a ceiling on what a
// `uses:` line can make the runner hold, not a budget anyone should approach.
const MAX_ACTION_BYTES = 256 * 1024 * 1024;

export class ActionError extends Error {}

export interface ActionInput {
  default?: string;
  required: boolean;
  description?: string;
}

export interface CompositeStep extends WorkflowStep {
  // Composite steps carry the same shape as workflow steps; `shell` is
  // required by GitHub for `run` steps here, and we keep that requirement
  // because a composite that omits it behaves differently on every runner.
  with?: Record<string, string>;
}

export interface ActionDef {
  name?: string;
  description?: string;
  inputs: Record<string, ActionInput>;
  outputs: Record<string, { value?: string; description?: string }>;
  runs:
    | { using: 'node'; nodeMajor: number; main: string; pre?: string; preIf?: string; post?: string; postIf?: string }
    | { using: 'composite'; steps: CompositeStep[] }
    | { using: 'docker'; image: string; entrypoint?: string; args?: string[]; env?: Record<string, string> };
}

export interface ResolvedAction {
  // Where the action's files are on the runner's disk.
  dir: string;
  def: ActionDef;
  key: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function parseActionDef(source: string, where: string): ActionDef {
  let doc: unknown;
  try {
    doc = YAML.parse(source);
  } catch (e) {
    throw new ActionError(`${where}: could not parse action.yml: ${e instanceof Error ? e.message : e}`);
  }
  if (!isObj(doc)) throw new ActionError(`${where}: action.yml is not a YAML map`);
  const runsRaw = doc.runs;
  if (!isObj(runsRaw)) throw new ActionError(`${where}: action.yml has no "runs"`);
  const using = asString(runsRaw.using);
  if (!using) throw new ActionError(`${where}: action.yml has no "runs.using"`);

  const inputs: Record<string, ActionInput> = {};
  if (isObj(doc.inputs)) {
    for (const [name, def] of Object.entries(doc.inputs)) {
      const d = isObj(def) ? def : {};
      inputs[name] = {
        default: asString(d.default),
        required: d.required === true,
        description: asString(d.description),
      };
    }
  }
  const outputs: Record<string, { value?: string; description?: string }> = {};
  if (isObj(doc.outputs)) {
    for (const [name, def] of Object.entries(doc.outputs)) {
      const d = isObj(def) ? def : {};
      outputs[name] = { value: asString(d.value), description: asString(d.description) };
    }
  }

  const name = asString(doc.name);
  const description = asString(doc.description);

  const nodeMatch = using.match(/^node(\d+)$/);
  if (nodeMatch) {
    const main = asString(runsRaw.main);
    if (!main) throw new ActionError(`${where}: a ${using} action needs "runs.main"`);
    return {
      name,
      description,
      inputs,
      outputs,
      runs: {
        using: 'node',
        nodeMajor: parseInt(nodeMatch[1], 10),
        main,
        pre: asString(runsRaw.pre),
        preIf: asString(runsRaw['pre-if']),
        post: asString(runsRaw.post),
        postIf: asString(runsRaw['post-if']),
      },
    };
  }

  if (using === 'composite') {
    const stepsRaw = runsRaw.steps;
    if (!Array.isArray(stepsRaw)) throw new ActionError(`${where}: a composite action needs "runs.steps"`);
    const steps: CompositeStep[] = stepsRaw.map((s, i) => {
      if (!isObj(s)) throw new ActionError(`${where}: composite step ${i + 1} is not a map`);
      const step: CompositeStep = { env: {} };
      if (isObj(s.env)) {
        for (const [k, v] of Object.entries(s.env)) {
          const val = asString(v);
          if (val !== undefined) step.env[k] = val;
        }
      }
      step.id = asString(s.id);
      step.name = asString(s.name);
      step.if = asString(s.if);
      step.run = asString(s.run);
      step.uses = asString(s.uses);
      step.shell = asString(s.shell);
      step.workingDirectory = asString(s['working-directory']);
      step.continueOnError = asString(s['continue-on-error']);
      if (isObj(s.with)) {
        step.with = {};
        for (const [k, v] of Object.entries(s.with)) {
          const val = asString(v);
          if (val !== undefined) step.with[k] = val;
        }
      }
      if (!step.run && !step.uses) {
        throw new ActionError(`${where}: composite step ${i + 1} needs "run" or "uses"`);
      }
      if (step.run && !step.shell) {
        // GitHub requires this and it is worth keeping: a composite whose
        // shell depends on the caller's defaults behaves differently
        // depending on who calls it.
        throw new ActionError(`${where}: composite step ${i + 1} has "run" but no "shell"`);
      }
      return step;
    });
    return { name, description, inputs, outputs, runs: { using: 'composite', steps } };
  }

  if (using === 'docker') {
    const image = asString(runsRaw.image);
    if (!image) throw new ActionError(`${where}: a docker action needs "runs.image"`);
    const env: Record<string, string> = {};
    if (isObj(runsRaw.env)) {
      for (const [k, v] of Object.entries(runsRaw.env)) {
        const val = asString(v);
        if (val !== undefined) env[k] = val;
      }
    }
    return {
      name,
      description,
      inputs,
      outputs,
      runs: {
        using: 'docker',
        image,
        entrypoint: asString(runsRaw.entrypoint),
        args: Array.isArray(runsRaw.args)
          ? runsRaw.args.map((a) => asString(a) ?? '').filter((a) => a !== '')
          : undefined,
        env,
      },
    };
  }

  throw new ActionError(`${where}: unsupported "runs.using": ${using}`);
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) reject(new ActionError((stderr || err.message).toString().trim()));
        else resolve(stdout.toString());
      }
    );
  });
}

export function defaultActionCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'mochi', 'actions');
}

// The fallback when a ref could not be resolved to a commit: the entry is
// keyed by a name, and a name moves, so it is re-fetched after a day. A key
// that names a commit needs none of this, since the bytes cannot change.
const STALE_MS = 24 * 60 * 60 * 1000;

// Which ref `uses: owner/repo@thing` means, when a tag and a branch share the
// name. This is git's own precedence (rev-parse tries refs/<name>, then tags,
// then heads), and an annotated tag is peeled to the commit it points at,
// since that is what a tarball can be built from.
export function pickCommit(lsRemote: string, ref: string): string | null {
  const byName = new Map<string, string>();
  for (const line of lsRemote.split('\n')) {
    const m = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
    if (m) byName.set(m[2], m[1]);
  }
  const candidates = [ref, `${ref}^{}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`];
  for (const name of candidates) {
    const sha = byName.get(name);
    if (sha) return sha;
  }
  return null;
}

function describeRef(ref: Extract<ActionRef, { kind: 'repo' }>, commit: string | null): string {
  return `${ref.owner}/${ref.repo}@${ref.ref}${commit ? ` (${commit.slice(0, 12)})` : ''}`;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return hours < 24 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

export class ActionStore {
  // Refs resolved during the current job. A job whose steps all use the same
  // action then asks the forge once rather than once per step. Cleared
  // between jobs (see `beginJob`), so nothing here outlives the job that
  // learned it and a branch that moves is seen on the next run.
  private resolved = new Map<string, string>();

  constructor(
    private cacheDir: string = defaultActionCacheDir(),
    private forgeUrl: string = process.env.MOCHI_ACTIONS_URL ?? 'https://github.com',
    // Reusing a download between jobs is what the cache is for; turning it
    // off is for when something about an action itself is being debugged.
    private useCache: boolean = process.env.MOCHI_ACTIONS_NO_CACHE !== '1'
  ) {}

  // Called at the start of every job: what a ref pointed at during the last
  // job says nothing about where it points now.
  beginJob(): void {
    this.resolved.clear();
  }

  // Fetch (or reuse) an action's source and read its definition. The
  // workspace path is needed for local (`./…`) actions, which live in the
  // repository being built rather than being downloaded.
  async resolve(
    ref: ActionRef,
    workspaceDir: string,
    onLine: (line: string) => void
  ): Promise<ResolvedAction> {
    if (ref.kind === 'docker') {
      throw new ActionError(
        `docker actions are not supported yet (uses: ${ref.raw}); rewrite the step as a run: step or use a JavaScript or composite action`
      );
    }
    if (ref.kind === 'local') {
      const dir = path.join(workspaceDir, ref.path);
      const real = fs.realpathSync(dir);
      const wsReal = fs.realpathSync(workspaceDir);
      if (real !== wsReal && !real.startsWith(wsReal + path.sep)) {
        throw new ActionError(`local action ${ref.raw} resolves outside the workspace`);
      }
      return { dir, def: this.readDef(dir, ref.raw), key: actionCacheKey(ref) };
    }

    const commit = await this.resolveCommit(ref, onLine);
    const key = actionCacheKey(ref, commit ?? undefined);
    const dest = path.join(this.cacheDir, key);
    const stamp = path.join(dest, '.mochi-fetched');
    let fetchedAt: number | null = null;
    try {
      fetchedAt = fs.statSync(stamp).mtimeMs;
    } catch {
      fetchedAt = null;
    }
    // A key that names a commit identifies the bytes, so a hit is always
    // good. Without one the key is a name, which moves.
    const age = fetchedAt === null ? Infinity : Date.now() - fetchedAt;
    const usable = fetchedAt !== null && (commit !== null || age < STALE_MS);
    if (usable && this.useCache) {
      // Say so: a run that quietly used a day-old copy of an action is hard
      // to tell from one that used the tip, which is the whole trap.
      const why = commit ? '' : ` (fetched ${ago(age)} ago, by name)`;
      onLine(`Using cached ${describeRef(ref, commit)}${why}`);
    } else {
      onLine(`Downloading ${describeRef(ref, commit)}${!this.useCache ? ' (cache disabled)' : ''}`);
      await this.download(ref, dest, commit);
      fs.writeFileSync(stamp, new Date().toISOString());
      if (commit) this.pruneOtherCommits(ref, key);
    }
    const dir = ref.subpath ? path.join(dest, ref.subpath) : dest;
    if (!fs.existsSync(dir)) {
      throw new ActionError(`${ref.raw}: ${ref.subpath || '.'} does not exist in ${ref.owner}/${ref.repo}@${ref.ref}`);
    }
    return { dir, def: this.readDef(dir, ref.raw), key };
  }

  // Resolve a ref to the commit it names, so the cache is keyed by the object
  // rather than by a name. One `git ls-remote` is a small request, needs no
  // token against a public forge, and costs far less than the tarball it
  // saves re-downloading. When it fails (no network, a private repository, a
  // forge that does not speak git over HTTP) we say so and fall back to the
  // older behavior of keying by name and re-fetching after a day.
  private async resolveCommit(
    ref: Extract<ActionRef, { kind: 'repo' }>,
    onLine: (line: string) => void
  ): Promise<string | null> {
    if (refIsImmutable(ref)) return ref.ref.toLowerCase();
    const memoKey = `${ref.owner}/${ref.repo}@${ref.ref}`;
    const hit = this.resolved.get(memoKey);
    if (hit !== undefined) return hit;
    const url = `${this.forgeUrl.replace(/\/+$/, '')}/${ref.owner}/${ref.repo}`;
    let out: string;
    try {
      // No ref patterns: git filters them on the client anyway, after the
      // server has advertised everything, and a pattern would hide the
      // peeled entry (refs/tags/v1^{}) that an annotated tag needs.
      out = await run('git', ['ls-remote', url], {
        timeout: 20000,
        // Never stop for a credential prompt: a private or missing
        // repository must fail rather than hang the job.
        env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' },
      });
    } catch (e) {
      onLine(
        `Could not resolve ${ref.owner}/${ref.repo}@${ref.ref} (${e instanceof Error ? e.message : e}); ` +
          `caching it by name instead`
      );
      return null;
    }
    const commit = pickCommit(out, ref.ref);
    if (!commit) {
      onLine(`${ref.owner}/${ref.repo} has no ref named ${ref.ref}; caching it by name instead`);
      return null;
    }
    this.resolved.set(memoKey, commit);
    return commit;
  }

  // A ref that moves would otherwise leave its old commit behind on every
  // move. Removing the entries for the same owner/repo/ref keeps the cache
  // at one copy per ref, the footprint it had when keys were names.
  private pruneOtherCommits(ref: Extract<ActionRef, { kind: 'repo' }>, keep: string): void {
    const prefix = `${commitPrefix(ref)}__`;
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (name === keep || !name.startsWith(prefix)) continue;
        fs.rmSync(path.join(this.cacheDir, name), { recursive: true, force: true });
      }
    } catch {
      // A cache we cannot tidy is not a reason to fail the job.
    }
  }

  private readDef(dir: string, where: string): ActionDef {
    for (const name of ['action.yml', 'action.yaml']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return parseActionDef(fs.readFileSync(file, 'utf8'), where);
    }
    throw new ActionError(`${where}: no action.yml or action.yaml in the action directory`);
  }

  private async download(
    ref: Extract<ActionRef, { kind: 'repo' }>,
    dest: string,
    commit: string | null
  ): Promise<void> {
    // Ask for the commit when it is known, so the tarball is the one the key
    // promises even if the ref moves between resolving and downloading.
    const url = `${this.forgeUrl.replace(/\/+$/, '')}/${ref.owner}/${ref.repo}/archive/${encodeURIComponent(
      commit ?? ref.ref
    )}.tar.gz`;
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow' });
    } catch (e) {
      throw new ActionError(`could not fetch ${ref.raw}: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) {
      throw new ActionError(
        `could not fetch ${ref.raw}: ${url} answered ${res.status}${
          res.status === 404 ? ' (check the owner, repository, and ref)' : ''
        }`
      );
    }
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const tarball = path.join(tmp, 'source.tar.gz');
    try {
      await downloadTo(res, tarball, MAX_ACTION_BYTES);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new ActionError(`could not fetch ${ref.raw}: ${e instanceof Error ? e.message : e}`);
    }
    const extracted = path.join(tmp, 'src');
    fs.mkdirSync(extracted);
    try {
      // The archive holds a single top-level directory named for the repo and
      // ref, which --strip-components removes.
      await run('tar', ['-xzf', tarball, '-C', extracted, '--strip-components=1']);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new ActionError(`could not unpack ${ref.raw}: ${e instanceof Error ? e.message : e}`);
    }
    fs.rmSync(tarball, { force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(extracted, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Turn an action's declared inputs plus a step's `with:` into the INPUT_*
// environment an action reads. GitHub uppercases the name and replaces
// spaces with underscores, and leaves everything else alone.
export function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

export function resolveInputs(
  def: ActionDef,
  provided: Record<string, string>
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(def.inputs)) {
    if (provided[name] !== undefined) values[name] = provided[name];
    else if (spec.default !== undefined) values[name] = spec.default;
    else if (spec.required) missing.push(name);
  }
  // Inputs a step passes that the action does not declare are still exported,
  // which matches the runner's behavior and is relied on by actions that read
  // undeclared inputs.
  for (const [name, value] of Object.entries(provided)) {
    if (values[name] === undefined) values[name] = value;
  }
  return { values, missing };
}
