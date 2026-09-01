import { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { stripAnsi } from '../ansi';
import { canReadRepo } from '../perms';
import { findRepo, isValidName } from '../scan';
import { Viewer, getViewer, viewerIsAdmin } from '../session';
import { ah, baseUrlOf, fail, field, loadRepo, makeCtx, requireViewerPost, send404, urlencodedForm } from '../web';
import { artifactPath, isValidArtifactName, listArtifacts } from './artifacts';
import { CiEngine, listWorkflowsAt } from './engine';
import { JobRecord, RunRecord, jobLogPath, listRuns } from './runs';
import {
  DEFAULT_JOB_TIMEOUT_MINUTES,
  MAX_JOB_TIMEOUT_MINUTES,
  isUsableJobTimeout,
  loadRunners,
  regenerateRunnerToken,
  registerRunner,
  removeRunner,
  runnerJobTimeout,
  runnerLastSeen,
  setRunnerJobTimeout,
  setRunnerWake,
} from './runners';
import { MANUAL_LABEL, MINT_TTL_MS } from './manual';
import { newWakeSecret, sendWake, wakeOf } from './wake';
import { dispatchWorkflow } from './dispatch';
import { packageVersion } from '../version';
import * as ciViews from './views';

// The Actions pages and their operations. Reading follows the repository's
// visibility, as everywhere else in a vault; cancelling, re-running, and
// dispatching require the write role, and runner management is the site
// admin's, on the web.

const RUNS_PER_PAGE = 50;
const MAX_LOG_RENDER_BYTES = 4 * 1024 * 1024;

// Nothing posted here is long: a workflow dispatch names a ref and its inputs,
// and a runner registration names a runner.
const form = urlencodedForm('1mb');

// Read a job log as ndjson from a byte offset. Returning the new offset lets
// the tailer poll without re-reading, and lets a huge log render its tail
// rather than exhausting memory.
export function readLog(
  file: string,
  offset: number
): { lines: { s: number; l: string }[]; offset: number } {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], offset: 0 };
  }
  let start = Math.max(0, Math.min(offset, size));
  let truncated = false;
  if (size - start > MAX_LOG_RENDER_BYTES) {
    start = size - MAX_LOG_RENDER_BYTES;
    truncated = true;
  }
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], offset };
  }
  // A trailing partial line means the writer is mid-append; leave it for the
  // next poll by reporting an offset before it.
  const lastNewline = text.lastIndexOf('\n');
  let consumed = size;
  if (lastNewline === -1) {
    return { lines: [], offset: start };
  }
  if (lastNewline !== text.length - 1) {
    consumed = start + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
    text = text.slice(0, lastNewline + 1);
  }
  const lines: { s: number; l: string }[] = [];
  if (truncated) lines.push({ s: 0, l: '[earlier output omitted]' });
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    try {
      const p = JSON.parse(raw) as { s?: number; l?: string };
      if (typeof p.l === 'string') lines.push({ s: typeof p.s === 'number' ? p.s : 0, l: p.l });
    } catch {
      // skip a damaged line rather than failing the page
    }
  }
  return { lines, offset: consumed };
}

export function registerCiWeb(app: Express, root: string, engine: CiEngine): void {
  // ---- the runs list ----

  app.get(
    '/:collection/:repo/actions',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const filter = typeof req.query.workflow === 'string' ? req.query.workflow : null;
      let runs = listRuns(root, loaded.repo.collection, loaded.repo.name);
      if (filter) runs = runs.filter((r) => r.workflowPath === filter);
      runs = runs.slice(0, RUNS_PER_PAGE);
      // Live runs are held in memory; prefer those records so a listing
      // refreshed mid-run shows the current status rather than the last write.
      runs = runs.map((r) => engine.activeRun(loaded.repo.collection, loaded.repo.name, r.number) ?? r);

      let workflows: Awaited<ReturnType<typeof listWorkflowsAt>> = [];
      const tip = loaded.branches.find((b) => b.name === loaded.defaultBranch);
      if (tip) {
        try {
          workflows = await listWorkflowsAt(loaded.repo, tip.sha);
        } catch {
          workflows = [];
        }
      }
      const flash = typeof req.query.flash === 'string' ? req.query.flash : undefined;
      res.type('html').send(ciViews.runsPage(ctx, runs, workflows, filter, flash));
    })
  );

  // ---- one run ----

  async function loadRunPage(
    req: Request,
    res: Response
  ): Promise<{ viewer: Viewer | null; loaded: Awaited<ReturnType<typeof loadRepo>>; run: RunRecord } | null> {
    const viewer = getViewer(req, root);
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    const n = parseInt(req.params.run, 10);
    if (!Number.isInteger(n) || n <= 0) {
      send404(res, 'No such run', viewer);
      return null;
    }
    const run = engine.runOf(loaded.repo.collection, loaded.repo.name, n);
    if (!run) {
      send404(res, `Run #${n} not found`, viewer);
      return null;
    }
    return { viewer, loaded, run };
  }

  app.get(
    '/:collection/:repo/actions/runs/:run',
    ah(async (req, res) => {
      const page = await loadRunPage(req, res);
      if (!page) return;
      const { viewer, loaded, run } = page;
      const repo = loaded!.repo;
      const ctx = await makeCtx(root, req, loaded!, run.refName || (loaded!.defaultBranch ?? ''), viewer);

      const jobs: JobRecord[] = [];
      for (const id of run.jobs) {
        const j = engine.jobOf(repo.collection, repo.name, run.number, id);
        if (j) jobs.push(j);
      }
      const wanted = typeof req.query.job === 'string' ? req.query.job : null;
      const selected =
        (wanted ? jobs.find((j) => j.id === wanted) : undefined) ??
        jobs.find((j) => j.status === 'running') ??
        jobs.find((j) => j.conclusion === 'failure') ??
        jobs[0] ??
        null;

      let lines: { s: number; l: string }[] = [];
      let offset = 0;
      if (selected) {
        const r = readLog(jobLogPath(root, repo.collection, repo.name, run.number, selected.id), 0);
        lines = r.lines;
        offset = r.offset;
      }
      const artifacts = listArtifacts(root, repo.collection, repo.name, run.number);
      res.type('html').send(ciViews.runPage(ctx, run, jobs, selected, lines, offset, artifacts));
    })
  );

  // Artifact download. A repository's build output is exactly as visible as
  // its source: anonymous on a public repository, and gone with the rest of a
  // private one for anyone without the read role. These three routes resolve
  // the repository themselves rather than through loadRepo, so each makes the
  // same check.
  app.get(
    '/:collection/:repo/actions/runs/:run/artifacts/:name',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const repo = findRepo(root, req.params.collection, req.params.repo);
      if (!repo || !canReadRepo(root, viewer?.auth ?? null, repo)) {
        send404(res, 'Repository not found', viewer);
        return;
      }
      const n = parseInt(req.params.run, 10);
      if (!Number.isInteger(n) || n <= 0 || !isValidArtifactName(req.params.name)) {
        send404(res, 'No such artifact', viewer);
        return;
      }
      const file = artifactPath(root, repo.collection, repo.name, n, req.params.name);
      if (!file || !fs.existsSync(file)) {
        send404(res, `No artifact named ${req.params.name} in run #${n}`, viewer);
        return;
      }
      res
        .type('application/x-tar')
        .set('Content-Disposition', `attachment; filename="${req.params.name}.tar"`)
        .sendFile(path.resolve(file));
    })
  );

  // The whole log as plain text, exactly as the runner wrote it: escape
  // sequences and all, since "raw" that has been cleaned up is not raw. The
  // step view renders; this preserves. Streamed, because a log can be larger
  // than anything worth buffering.
  app.get(
    '/:collection/:repo/actions/runs/:run/log/:job/raw',
    ah(async (req, res) => {
      const repo = findRepo(root, req.params.collection, req.params.repo);
      const readable = repo !== null && canReadRepo(root, getViewer(req, root)?.auth ?? null, repo);
      const n = parseInt(req.params.run, 10);
      const job = repo && readable && Number.isInteger(n) && n > 0 ? engine.jobOf(repo.collection, repo.name, n, req.params.job) : null;
      if (!repo || !readable || !job) {
        res.status(404).type('text').send('not found\n');
        return;
      }
      const file = jobLogPath(root, repo.collection, repo.name, n, job.id);
      if (!fs.existsSync(file)) {
        res.status(404).type('text').send('no log\n');
        return;
      }
      res
        .type('text/plain; charset=utf-8')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Disposition', `attachment; filename="${job.id}.log"`);
      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const raw of rl) {
        if (raw === '') continue;
        try {
          const p = JSON.parse(raw) as { l?: string };
          if (typeof p.l === 'string') {
            if (!res.write(p.l + '\n')) await new Promise((resolve) => res.once('drain', resolve));
          }
        } catch {
          // skip a damaged line rather than failing the download
        }
      }
      res.end();
    })
  );

  // The tailer's endpoint: new log lines since an offset, plus whether the
  // job has finished (at which point the page reloads into the step view).
  app.get(
    '/:collection/:repo/actions/runs/:run/log/:job',
    ah(async (req, res) => {
      const collection = req.params.collection;
      const repoName = req.params.repo;
      const repo = findRepo(root, collection, repoName);
      if (!repo || !canReadRepo(root, getViewer(req, root)?.auth ?? null, repo)) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const n = parseInt(req.params.run, 10);
      if (!Number.isInteger(n) || n <= 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const job = engine.jobOf(repo.collection, repo.name, n, req.params.job);
      if (!job) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
      const r = readLog(jobLogPath(root, repo.collection, repo.name, n, job.id), offset);
      res.set('Cache-Control', 'no-store').json({
        done: job.status === 'completed',
        offset: r.offset,
        // Stripped of terminal escapes, since the tailer appends these as
        // plain text; the log file itself keeps the bytes as written.
        lines: r.lines.map((l) => stripAnsi(l.l)),
      });
    })
  );

  // ---- operations ----

  function repoActor(req: Request, res: Response): { viewer: Viewer; collection: string; repo: string } | null {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return null;
    const collection = req.params.collection;
    const repoName = req.params.repo;
    if (!isValidName(collection) || !isValidName(repoName)) {
      fail(res, 404, 'No such repository', viewer);
      return null;
    }
    return { viewer, collection, repo: repoName };
  }

  app.post(
    '/:collection/:repo/actions/runs/:run/cancel',
    form,
    ah(async (req, res) => {
      const actor = repoActor(req, res);
      if (!actor) return;
      const loaded = await loadRepo(root, req, res, actor.viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', actor.viewer);
      if (!ctx.canPush) {
        fail(res, 403, 'You do not have permission to cancel runs in this repository.', actor.viewer);
        return;
      }
      const n = parseInt(req.params.run, 10);
      engine.cancelRun(loaded.repo.collection, loaded.repo.name, n);
      res.redirect(
        `/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(loaded.repo.name)}/actions/runs/${n}`
      );
    })
  );

  app.post(
    '/:collection/:repo/actions/runs/:run/rerun',
    form,
    ah(async (req, res) => {
      const actor = repoActor(req, res);
      if (!actor) return;
      const loaded = await loadRepo(root, req, res, actor.viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', actor.viewer);
      if (!ctx.canPush) {
        fail(res, 403, 'You do not have permission to run workflows in this repository.', actor.viewer);
        return;
      }
      const n = parseInt(req.params.run, 10);
      const base = `/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(loaded.repo.name)}/actions`;
      try {
        const fresh = await engine.rerun(loaded.repo.collection, loaded.repo.name, n);
        if (!fresh) {
          fail(res, 404, `Run #${n} not found`, actor.viewer, base);
          return;
        }
        res.redirect(`${base}/runs/${fresh.number}`);
      } catch (e) {
        fail(res, 400, e instanceof Error ? e.message : String(e), actor.viewer, base);
      }
    })
  );

  // Mint the pasted command for a run's manual jobs. Write role, like every
  // other way of causing a workflow to execute; the page the token lands on
  // is the only place it ever appears, as with runner tokens.
  app.post(
    '/:collection/:repo/actions/runs/:run/exec-command',
    form,
    ah(async (req, res) => {
      const actor = repoActor(req, res);
      if (!actor) return;
      const loaded = await loadRepo(root, req, res, actor.viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', actor.viewer);
      if (!ctx.canPush) {
        fail(res, 403, 'You do not have permission to run workflows in this repository.', actor.viewer);
        return;
      }
      const n = parseInt(req.params.run, 10);
      const back = `/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(loaded.repo.name)}/actions/runs/${n}`;
      if (!Number.isInteger(n) || n <= 0) {
        send404(res, 'No such run', actor.viewer);
        return;
      }
      const minted = engine.mintManual(loaded.repo.collection, loaded.repo.name, n, actor.viewer.auth.username);
      if ('error' in minted) {
        const why =
          minted.error === 'finished'
            ? `Run #${n} has finished; there is nothing left to run.`
            : `Run #${n} has no manual jobs.`;
        fail(res, minted.error === 'finished' ? 409 : 400, why, actor.viewer, back);
        return;
      }
      const command = `npx @magland/mochi@${packageVersion()} job run ${baseUrlOf(req)} ${minted.token}`;
      res
        .type('html')
        .send(ciViews.execCommandPage(ctx, n, command, Math.round(MINT_TTL_MS / 60000), back));
    })
  );

  app.post(
    '/:collection/:repo/actions/dispatch',
    form,
    ah(async (req, res) => {
      const actor = repoActor(req, res);
      if (!actor) return;
      const loaded = await loadRepo(root, req, res, actor.viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', actor.viewer);
      const base = `/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(loaded.repo.name)}/actions`;
      if (!ctx.canPush) {
        fail(res, 403, 'You do not have permission to run workflows in this repository.', actor.viewer);
        return;
      }
      // The form's own business is reading the form: the input.* fields become
      // the inputs, and everything after that is dispatchWorkflow's, which the
      // API dispatch route calls too.
      const inputs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
        if (k.startsWith('input.') && typeof v === 'string') inputs[k.slice(6)] = v;
      }
      try {
        const run = await dispatchWorkflow(
          engine,
          loaded.repo,
          loaded.branches,
          loaded.defaultBranch,
          actor.viewer.auth.username,
          { workflow: field(req, 'workflow'), ref: field(req, 'ref'), inputs }
        );
        res.redirect(`${base}/runs/${run.number}`);
      } catch (e) {
        fail(res, 400, e instanceof Error ? e.message : String(e), actor.viewer, base);
      }
    })
  );

  // ---- runners, under Admin ----

  // Registration says what a runner may do; the engine and the last-seen map
  // say whether it is there and what it is doing, which is what an operator
  // looking at a runner actually wants to know.
  function runnerViews(): ciViews.RunnerView[] {
    const load = engine.runnerLoad();
    return Object.entries(loadRunners(root).runners).map(([name, r]) => ({
      name,
      labels: r.labels,
      allow: r.allow,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      tokenUpdatedAt: r.tokenUpdatedAt,
      jobTimeout: runnerJobTimeout(r),
      jobTimeoutSet: r.jobTimeoutMinutes !== undefined,
      lastSeen: runnerLastSeen(name),
      running: load.running[name] ?? null,
      wakeUrl: r.wakeUrl ?? null,
    }));
  }

  app.get('/admin/runners', (req, res) => {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    const flash = typeof req.query.flash === 'string' ? req.query.flash : undefined;
    res.type('html').send(ciViews.runnersPage(viewer, runnerViews(), flash));
  });

  app.get('/admin/runners/:name', (req, res) => {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    const view = runnerViews().find((r) => r.name === req.params.name);
    if (!view) {
      send404(res, `No runner named ${req.params.name} is registered.`, viewer);
      return;
    }
    const flash = typeof req.query.flash === 'string' ? req.query.flash : undefined;
    res.type('html').send(ciViews.runnerPage(viewer, view, baseUrlOf(req), flash));
  });

  app.post('/admin/runners', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to register runners.', viewer);
      return;
    }
    const name = field(req, 'name');
    const labels = field(req, 'labels')
      .split(/[\s,]+/)
      .filter((s) => s.length > 0 && s.length < 200);
    const allow = field(req, 'allow')
      .split(/[\s,]+/)
      .filter((s) => s.length > 0 && s.length < 200);
    const registry = loadRunners(root);
    const showError = (msg: string) => {
      res.status(400).type('html').send(ciViews.runnersPage(viewer, runnerViews(), undefined, msg));
    };
    if (!isValidName(name)) {
      showError('A runner needs a simple name (letters, digits, dot, dash, underscore).');
      return;
    }
    if (registry.runners[name]) {
      showError(`A runner named ${name} is already registered; remove it first.`);
      return;
    }
    if (allow.length === 0) {
      showError('Say which repositories this runner may take jobs for, as globs over collection/repo.');
      return;
    }
    if (labels.includes(MANUAL_LABEL)) {
      showError(
        `'${MANUAL_LABEL}' is a reserved label: a job that names it runs only through a command pasted from its run page, never on a registered runner.`
      );
      return;
    }
    const minutes = jobTimeoutField(req);
    if (minutes === 'bad') {
      showError(
        `A job timeout is a whole number of minutes from 1 to ${MAX_JOB_TIMEOUT_MINUTES}, or empty for the default of ${DEFAULT_JOB_TIMEOUT_MINUTES}.`
      );
      return;
    }
    const { token } = registerRunner(root, name, {
      labels: labels.length ? labels : ['ubuntu-latest'],
      allow,
      createdBy: viewer.auth.username,
      jobTimeoutMinutes: minutes,
    });
    res.type('html').send(ciViews.runnerTokenPage(viewer, name, token, baseUrlOf(req)));
  });

  app.post('/admin/runners/:name/token', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      send404(res, `No runner named ${name} is registered.`, viewer);
      return;
    }
    const issued = regenerateRunnerToken(root, name);
    if (!issued) {
      send404(res, `No runner named ${name} is registered.`, viewer);
      return;
    }
    res.type('html').send(ciViews.runnerTokenPage(viewer, name, issued.token, baseUrlOf(req), true));
  });

  /**
   * The job timeout a form carried: a number of minutes, null for the default
   * when the field is empty, or 'bad' for anything else. Empty is a real
   * answer here rather than a missing one, since the field is always rendered.
   */
  function jobTimeoutField(req: Request): number | null | 'bad' {
    const raw = field(req, 'minutes').trim();
    if (raw === '') return null;
    if (!/^\d{1,7}$/.test(raw)) return 'bad';
    const n = parseInt(raw, 10);
    return isUsableJobTimeout(n) ? n : 'bad';
  }

  app.post('/admin/runners/:name/job-timeout', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      send404(res, `No runner named ${name} is registered.`, viewer);
      return;
    }
    const back = `/admin/runners/${encodeURIComponent(name)}`;
    const minutes = jobTimeoutField(req);
    if (minutes === 'bad') {
      fail(
        res,
        400,
        `A job timeout is a whole number of minutes from 1 to ${MAX_JOB_TIMEOUT_MINUTES}, or empty for the default of ${DEFAULT_JOB_TIMEOUT_MINUTES}.`,
        viewer,
        back
      );
      return;
    }
    setRunnerJobTimeout(root, name, minutes);
    const flash =
      minutes === null
        ? `${name} is back on the default job timeout of ${DEFAULT_JOB_TIMEOUT_MINUTES} minutes.`
        : `Jobs on ${name} now stop after ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    res.redirect(`${back}?flash=${encodeURIComponent(flash)}`);
  });

  // Setting the address and sending a request to it are separate posts
  // because they are separate acts: one changes what is stored, the other
  // starts a machine and waits for it. A single form doing both would make
  // the slow one unavoidable.
  app.post('/admin/runners/:name/wake', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      send404(res, `No runner named ${name} is registered.`, viewer);
      return;
    }
    const url = field(req, 'wakeUrl').trim();
    const back = `/admin/runners/${encodeURIComponent(name)}`;
    if (!url) {
      setRunnerWake(root, name, null);
      res.redirect(`${back}?flash=${encodeURIComponent('Wake address removed; nothing will start this runner.')}`);
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail(res, 400, `That is not a URL: ${url}`, viewer, back);
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      fail(res, 400, 'A wake address must be an http or https URL.', viewer, back);
      return;
    }
    // The secret is generated rather than asked for, and shown once here, for
    // the same reason a runner token is: it is the runner's copy that has to
    // match, and there is nothing to be gained by having an operator invent
    // one. Keeping the old secret when only the URL changed would be worse,
    // since the address that was trusted with it is no longer the address
    // being written.
    const secret = newWakeSecret();
    setRunnerWake(root, name, { url, secret });
    res.type('html').send(ciViews.runnerWakePage(viewer, name, url, secret));
  });

  app.post('/admin/runners/:name/wake/send', form, async (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      send404(res, `No runner named ${name} is registered.`, viewer);
      return;
    }
    const back = `/admin/runners/${encodeURIComponent(name)}`;
    const wake = wakeOf(existing);
    if (!wake) {
      fail(res, 400, `${name} has no wake address, so there is nothing to start it.`, viewer, back);
      return;
    }
    const started = Date.now();
    try {
      await sendWake(wake);
    } catch (e) {
      fail(res, 502, `${wake.url} did not answer: ${e instanceof Error ? e.message : String(e)}`, viewer, back);
      return;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    res.redirect(`${back}?flash=${encodeURIComponent(`${name} answered the wake request in ${secs}s.`)}`);
  });

  app.post('/admin/runners/:name/remove', form, (req, res) => {
    const viewer = requireViewerPost(root, req, res);
    if (!viewer) return;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    // viewerIsAdmin above is the whole check: on the web, runners are the
    // site admin's to manage.
    removeRunner(root, req.params.name);
    res.redirect('/admin/runners?flash=' + encodeURIComponent(`Runner ${req.params.name} removed.`));
  });
}
