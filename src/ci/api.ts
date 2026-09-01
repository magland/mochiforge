import express, { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AuthLimiter } from '../limit';
import { findRepo, isValidName } from '../scan';
import { siteSettings } from '../sitesettings';
import { siteHostUrl } from '../site';
import { canAdminRunnerGlobs, isSiteAdmin } from '../perms';
import { AuthResult, authenticateToken, loadVault } from '../vault';
import { baseUrlOf } from '../web';
import { ArtifactError, artifactPath, artifactsDir, deploySite, isValidArtifactName, listArtifacts } from './artifacts';
import { CiEngine } from './engine';
import { MANUAL_LABEL, looksLikeSessionToken, sessionRunnerName } from './manual';
import { LogLine } from './protocol';
import { Conclusion, StepState } from './runs';
import {
  DEFAULT_JOB_TIMEOUT_MINUTES,
  MAX_JOB_TIMEOUT_MINUTES,
  RunnerAuth,
  authenticateRunner,
  isUsableJobTimeout,
  loadRunners,
  noteRunnerSeen,
  regenerateRunnerToken,
  registerRunner,
  removeRunner,
  runnerJobTimeout,
  runnerLastSeen,
  setRunnerJobTimeout,
  setRunnerWake,
} from './runners';
import { sendWake, wakeOf } from './wake';

// The runner-facing API and the admin API for runner registration.
//
// Runner endpoints are authenticated by a runner token (Bearer), never by a
// session cookie and never by a user token. Registration endpoints are the
// mirror image: a user token with standing over the runner, never a runner token. The two
// credential kinds do not overlap at any endpoint.

const ACQUIRE_TIMEOUT_MS = 25 * 1000;
const MAX_LOG_BODY = 4 * 1024 * 1024;

export function registerCiApi(app: Express, root: string, engine: CiEngine, authLimiter: AuthLimiter): void {
  const json = express.json({ limit: '1mb' });

  function apiError(res: Response, status: number, message: string) {
    res.status(status).json({ error: message });
  }

  /**
   * Where a repository's site is served, which only the vault knows: with a
   * sites hostname configured each site has an origin of its own and sits at
   * its root, and without one it is a path under the forge host. A runner
   * computing this from the server URL gets the second answer always, and a
   * build told the wrong base path produces a site whose every asset URL is
   * wrong, so the answer travels with the job rather than being guessed.
   */
  function siteOf(req: Request, collection: string, repo: string): { url: string; basePath: string } {
    const own = siteHostUrl(root, req, collection, repo);
    if (own) return { url: `${own}/`, basePath: '/' };
    const p = `/${encodeURIComponent(collection)}/${encodeURIComponent(repo)}/site`;
    return { url: `${baseUrlOf(req)}${p}/`, basePath: p };
  }

  // A missing header is not a failed attempt and is not charged; a wrong token
  // is. Nothing here throttles a working credential, which matters because the
  // runner calls these endpoints continuously with a valid one.
  function denyTooMany(res: Response, retryAfter: number) {
    res.setHeader('Retry-After', String(retryAfter));
    apiError(res, 429, 'too many failed authentication attempts; try again later');
  }

  function requireAdmin(req: Request, res: Response): AuthResult | null {
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return null;
    }
    const m = (req.get('authorization') ?? '').match(/^bearer\s+(.+)$/i);
    if (!m) {
      apiError(res, 401, 'missing bearer token: send Authorization: Bearer <token>');
      return null;
    }
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      denyTooMany(res, allowed.retryAfter);
      return null;
    }
    const auth = authenticateToken(state.vault, m[1].trim());
    if (!auth) {
      authLimiter.fail(req, null);
      apiError(res, 401, 'invalid token');
      return null;
    }
    return auth;
  }

  function requireRunner(req: Request, res: Response): RunnerAuth | null {
    const m = (req.get('authorization') ?? '').match(/^bearer\s+(.+)$/i);
    if (!m) {
      apiError(res, 401, 'missing runner token');
      return null;
    }
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      denyTooMany(res, allowed.retryAfter);
      return null;
    }
    const token = m[1].trim();
    // A manual session speaks these endpoints too, once it holds a job: the
    // lease plus the runner name `manual:<id>` scope it to exactly that job,
    // the same way a registered runner is scoped, so the endpoints need not
    // know which kind is talking.
    if (looksLikeSessionToken(token)) {
      const session = engine.authenticateManualSession(token);
      if (!session) {
        authLimiter.fail(req, null);
        apiError(res, 401, 'this manual session is no longer recognized; the run has likely finished');
        return null;
      }
      return {
        name: sessionRunnerName(session.grant),
        runner: {
          hash: '',
          labels: [],
          allow: [`${session.collection}/${session.repo}`],
          createdBy: session.grant.mintedBy,
          createdAt: session.grant.mintedAt,
        },
      };
    }
    const auth = authenticateRunner(root, token);
    if (!auth) {
      authLimiter.fail(req, null);
      apiError(res, 401, 'invalid runner token');
      return null;
    }
    // Every runner endpoint passes through here, so this is the one place that
    // sees a runner alive, whether it is polling for work or reporting on a
    // job it already has.
    noteRunnerSeen(auth.name);
    return auth;
  }

  // ---- runner registration (admin) ----

  app.get('/api/runners', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    // A site admin sees every runner; anyone else sees the runners they could
    // administer, which are the ones confined to collections they own.
    const registry = loadRunners(root);
    const visible = Object.entries(registry.runners).filter(
      ([, r]) => isSiteAdmin(auth) || canAdminRunnerGlobs(root, auth, r.allow)
    );
    const load = engine.runnerLoad();
    res.json({
      runners: visible.map(([name, r]) => ({
        name,
        labels: r.labels,
        allow: r.allow,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        // What was set and what is in force, the two differing for a runner
        // left on the default: a caller wanting to know how long a job may run
        // there should not have to know what the default is.
        jobTimeoutMinutes: r.jobTimeoutMinutes ?? null,
        jobTimeout: runnerJobTimeout(r),
        // Registration says what a runner may do; these two say whether it is
        // there at all and what it is doing, which is what a caller looking at
        // a run that has not started actually wants to know.
        lastSeen: runnerLastSeen(name),
        running: load.running[name] ?? null,
        // The address, never the secret: a caller deciding whether a runner
        // can be started needs to know that it can be, not what to send.
        wakeUrl: r.wakeUrl ?? null,
      })),
      queued: load.queued,
    });
  });

  /**
   * The wake address in a request body, or a message saying what is wrong.
   *
   * Both halves or neither: an address with no secret is one the vault cannot
   * authenticate itself to, and a secret with no address is nowhere to send
   * it. The URL is checked for being a URL and for being HTTP, which is as
   * far as this can go: where it points is the administrator's business, and
   * they are already trusted with a runner that executes repository code.
   */
  function wakeFrom(body: Record<string, unknown>): { wake: { url: string; secret: string } | null } | { error: string } {
    const url = body.wakeUrl;
    const secret = body.wakeSecret;
    if (url === undefined && secret === undefined) return { wake: null };
    if (typeof url !== 'string' || typeof secret !== 'string' || !url || !secret) {
      return { error: '"wakeUrl" and "wakeSecret" must be given together, as non-empty strings' };
    }
    if (secret.length > 500) return { error: '"wakeSecret" is too long' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `"wakeUrl" is not a URL: ${url}` };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { error: '"wakeUrl" must be an http or https URL' };
    }
    return { wake: { url, secret } };
  }

  app.post('/api/runners', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (!isValidName(name)) {
      apiError(res, 400, 'a valid "name" is required');
      return;
    }
    const strings = (v: unknown): string[] | null => {
      if (v === undefined) return [];
      if (Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0 && s.length < 200)) {
        return v as string[];
      }
      return null;
    };
    const labels = strings(body.labels);
    const allow = strings(body.allow);
    if (!labels || !allow) {
      apiError(res, 400, '"labels" and "allow" must be lists of strings');
      return;
    }
    if (allow.length === 0) {
      apiError(res, 400, 'a runner needs at least one --allow glob saying which repositories it serves');
      return;
    }
    if (labels.includes(MANUAL_LABEL)) {
      apiError(
        res,
        400,
        `'${MANUAL_LABEL}' is a reserved label: a job that names it runs only through a command pasted from its run page, never on a registered runner`
      );
      return;
    }
    // A runner may take jobs for every repository its allow list covers, and
    // those jobs execute repository-controlled code on the runner's machine.
    // Registering one therefore demands ownership of every collection in that set.
    if (!canAdminRunnerGlobs(root, auth, allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    if (loadRunners(root).runners[name]) {
      apiError(res, 409, `a runner named ${name} is already registered; remove it first`);
      return;
    }
    const wake = wakeFrom(body);
    if ('error' in wake) {
      apiError(res, 400, wake.error);
      return;
    }
    const timeout = jobTimeoutFrom(body);
    if ('error' in timeout) {
      apiError(res, 400, timeout.error);
      return;
    }
    const { token, runner } = registerRunner(root, name, {
      labels: labels.length ? labels : ['ubuntu-latest'],
      allow,
      createdBy: auth.username,
      jobTimeoutMinutes: timeout.minutes,
      wake: wake.wake,
    });
    res.json({
      name,
      token,
      labels: runner.labels,
      allow: runner.allow,
      jobTimeout: runnerJobTimeout(runner),
      wakeUrl: runner.wakeUrl ?? null,
    });
  });

  /**
   * Issue a new token for a runner, invalidating the one it had.
   *
   * The web interface has had this since runners did, and the API not having
   * it meant that the one way to give a runner a token nobody holds any more
   * was a browser. `mochi deploy fly runner` needs exactly that: a runner
   * registered by an earlier deploy has a token that only the machine knows,
   * and a machine being rebuilt has to be given one it can hold.
   */
  app.post('/api/runners/:name/token', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    const issued = regenerateRunnerToken(root, name);
    if (!issued) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    res.json({ name, token: issued.token, labels: issued.runner.labels, allow: issued.runner.allow });
  });

  /**
   * The job timeout in a request body, or a message saying what is wrong.
   *
   * Absent and null both read as the default, which is what registration
   * wants; the PATCH route below tells the two apart itself, because there an
   * absent field is a caller who asked for nothing. A value that is not a
   * usable number of minutes is refused rather than rounded: an operator who
   * typed 0 meant something, and it was not "no limit".
   */
  function jobTimeoutFrom(
    body: Record<string, unknown>
  ): { minutes: number | null } | { minutes?: undefined; error: string } {
    const v = body.jobTimeoutMinutes;
    if (v === undefined) return { minutes: null };
    if (v === null) return { minutes: null };
    if (typeof v !== 'number' || !isUsableJobTimeout(v)) {
      return {
        error: `"jobTimeoutMinutes" must be a whole number of minutes from 1 to ${MAX_JOB_TIMEOUT_MINUTES}, or null for the default of ${DEFAULT_JOB_TIMEOUT_MINUTES}`,
      };
    }
    return { minutes: v };
  }

  /**
   * The longest a job may run on this runner. A ceiling rather than a default:
   * a job's own `timeout-minutes` applies when it asks for less, and is cut
   * down to this when it asks for more or asks for nothing.
   *
   * A change applies to the next job the runner takes, not to one already
   * running: the runner enforces the timeout it was handed with the job, and
   * reaching into a job in flight to shorten it would be a cancellation
   * wearing a setting's clothes.
   */
  app.patch('/api/runners/:name', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.jobTimeoutMinutes === undefined) {
      apiError(res, 400, 'nothing to change; provide "jobTimeoutMinutes"');
      return;
    }
    const timeout = jobTimeoutFrom(body);
    if ('error' in timeout) {
      apiError(res, 400, timeout.error);
      return;
    }
    const runner = setRunnerJobTimeout(root, name, timeout.minutes);
    if (!runner) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    res.json({
      name,
      jobTimeoutMinutes: runner.jobTimeoutMinutes ?? null,
      jobTimeout: runnerJobTimeout(runner),
    });
  });

  /**
   * Point a runner's wake address somewhere, or clear it with an empty body.
   *
   * Separate from registration because the app that will run a runner usually
   * does not exist until after the runner is registered: `mochi deploy fly
   * runner` needs the token to put in the machine's secrets before it can know
   * the URL that starts the machine.
   */
  app.put('/api/runners/:name/wake', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    const wake = wakeFrom((req.body ?? {}) as Record<string, unknown>);
    if ('error' in wake) {
      apiError(res, 400, wake.error);
      return;
    }
    const runner = setRunnerWake(root, name, wake.wake);
    res.json({ name, wakeUrl: runner?.wakeUrl ?? null });
  });

  /**
   * Send this runner's wake request now, and report what came back.
   *
   * The vault sends it rather than the caller because the vault is the only
   * party that has the secret; and it is worth being able to ask for, since
   * the alternative way to test a wake address is to queue a job and watch
   * whether anything happens.
   */
  app.post('/api/runners/:name/wake', json, async (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    const wake = wakeOf(existing);
    if (!wake) {
      apiError(res, 400, `runner ${name} has no wake address, so there is nothing to start it`);
      return;
    }
    const started = Date.now();
    try {
      await sendWake(wake);
    } catch (e) {
      apiError(res, 502, `${wake.url} did not answer: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    res.json({ name, wakeUrl: wake.url, woke: true, seconds: Math.round((Date.now() - started) / 1000) });
  });

  app.delete('/api/runners/:name', (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const registry = loadRunners(root);
    const existing = registry.runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    removeRunner(root, name);
    res.json({ name, removed: true });
  });

  // ---- the runner protocol ----

  app.post('/api/runner/acquire', json, async (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requested = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l) => typeof l === 'string') : [];
    // A runner may narrow its registered labels per call but never widen
    // them: the registry is the authority on what it may claim to be.
    const labels = (requested as string[]).filter((l) => auth.runner.labels.includes(l));
    if (labels.length === 0) {
      res.status(204).end();
      return;
    }
    // Detect a runner that hangs up while we hold the poll open. Note that
    // this must watch the response, not the request: a request whose body has
    // been fully read emits 'close' immediately, long before the client goes
    // away, and treating that as a disconnect would cancel every job at the
    // moment it was leased.
    let closed = false;
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        closed = true;
        gone.abort();
      }
    });
    const spec = await engine.waitForJob(
      auth.name,
      labels,
      auth.runner.allow,
      baseUrlOf(req),
      // The registry decides how long a job may run on this machine, so the
      // limit is read here rather than trusted from the runner's own request.
      runnerJobTimeout(auth.runner),
      ACQUIRE_TIMEOUT_MS,
      gone.signal
    );
    if (!spec) {
      if (!closed) res.status(204).end();
      return;
    }
    spec.site = siteOf(req, spec.address.collection, spec.address.repo);
    if (closed) {
      // The runner hung up while we were leasing; release it immediately so
      // the job does not wait out a lease expiry with nobody running it.
      engine.reportStatus(spec.address.collection, spec.address.repo, spec.address.run, spec.address.job, {
        lease: spec.lease,
        runner: auth.name,
        status: 'completed',
        conclusion: 'cancelled',
      });
      return;
    }
    res.json(spec);
  });

  // ---- the manual protocol ----
  //
  // Three endpoints carry what is particular to a pasted command: redeeming
  // it, acquiring the run's manual jobs, and handing one back unrun. The rest
  // of a manual session's traffic (heartbeats, logs, status, artifacts) goes
  // through the job endpoints below, authenticated by the session token that
  // requireRunner also accepts.

  function runSummary(run: { number: number; workflowName: string; status: string; conclusion?: string } | null) {
    if (!run) return null;
    return {
      number: run.number,
      workflowName: run.workflowName,
      status: run.status,
      conclusion: run.conclusion ?? null,
    };
  }

  app.post('/api/manual/redeem', json, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const host = typeof body.host === 'string' ? body.host : '';
    if (!token) {
      apiError(res, 400, 'a "token" is required: the one the pasted command carries');
      return;
    }
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      denyTooMany(res, allowed.retryAfter);
      return;
    }
    const redeemed = engine.redeemManual(token, host);
    if (!redeemed) {
      authLimiter.fail(req, null);
      apiError(
        res,
        401,
        'this command has expired, was already used, or its run has finished; mint a fresh one from the run page'
      );
      return;
    }
    res.json({
      sessionToken: redeemed.sessionToken,
      collection: redeemed.collection,
      repo: redeemed.repo,
      run: {
        number: redeemed.run.number,
        workflowName: redeemed.run.workflowName,
        refName: redeemed.run.refName,
        sha: redeemed.run.sha,
        status: redeemed.run.status,
      },
      jobs: redeemed.jobs.map((j) => ({
        id: j.id,
        key: j.key,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion ?? null,
        runsOn: j.runsOn,
      })),
    });
  });

  function requireManualSession(req: Request, res: Response): ReturnType<CiEngine['authenticateManualSession']> {
    const m = (req.get('authorization') ?? '').match(/^bearer\s+(.+)$/i);
    if (!m) {
      apiError(res, 401, 'missing session token');
      return null;
    }
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      denyTooMany(res, allowed.retryAfter);
      return null;
    }
    const session = engine.authenticateManualSession(m[1].trim());
    if (!session) {
      authLimiter.fail(req, null);
      apiError(res, 401, 'this manual session is no longer recognized; the run has likely finished');
      return null;
    }
    return session;
  }

  app.post('/api/manual/acquire', json, async (req, res) => {
    const session = requireManualSession(req, res);
    if (!session) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filter = typeof body.job === 'string' && body.job !== '' ? body.job : null;
    if (!session.active) {
      res.status(410).json({
        reason:
          session.run?.status === 'completed'
            ? `the run finished: ${session.run.conclusion ?? 'completed'}`
            : 'the run no longer exists',
        run: runSummary(session.run),
      });
      return;
    }
    // Same disconnect-watching as the runner acquire above, released the
    // manual way: a job leased to a session that hung up before hearing about
    // it goes back to waiting for a command, since nothing has executed.
    let closed = false;
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        closed = true;
        gone.abort();
      }
    });
    const result = await engine.waitForManualJob(
      session.collection,
      session.repo,
      session.n,
      session.grant,
      filter,
      baseUrlOf(req),
      ACQUIRE_TIMEOUT_MS,
      gone.signal
    );
    if (result.kind === 'wait') {
      if (!closed) res.status(204).end();
      return;
    }
    if (result.kind === 'done') {
      if (!closed) res.status(410).json({ reason: result.reason, run: runSummary(result.run) });
      return;
    }
    const spec = result.spec;
    spec.site = siteOf(req, spec.address.collection, spec.address.repo);
    if (closed) {
      engine.releaseManualJob(
        spec.address.collection,
        spec.address.repo,
        spec.address.run,
        spec.address.job,
        spec.lease,
        sessionRunnerName(session.grant)
      );
      return;
    }
    res.json(spec);
  });

  app.post('/api/manual/jobs/:collection/:repo/:run/:job/release', json, (req, res) => {
    const session = requireManualSession(req, res);
    if (!session) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    const ok = engine.releaseManualJob(
      a.collection,
      a.repo,
      a.run,
      a.job,
      leaseOf(req),
      sessionRunnerName(session.grant)
    );
    if (!ok) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    res.json({ released: true });
  });

  // Every job-scoped endpoint checks the lease token, so a runner can only
  // touch the job it currently holds, whatever else it is allowed to run.
  function addressOf(req: Request): { collection: string; repo: string; run: number; job: string } | null {
    const collection = req.params.collection;
    const repo = req.params.repo;
    const run = parseInt(req.params.run, 10);
    const job = req.params.job;
    if (!isValidName(collection) || !isValidName(repo)) return null;
    if (!Number.isInteger(run) || run <= 0) return null;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(job)) return null;
    return { collection, repo, run, job };
  }

  function leaseOf(req: Request): string {
    const v = req.get('x-mochi-lease');
    return typeof v === 'string' ? v : '';
  }

  app.post('/api/runner/jobs/:collection/:repo/:run/:job/heartbeat', json, (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    const result = engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name);
    if (!result) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    res.json(result);
  });

  app.post(
    '/api/runner/jobs/:collection/:repo/:run/:job/logs',
    express.text({ type: '*/*', limit: MAX_LOG_BODY }),
    (req, res) => {
      const auth = requireRunner(req, res);
      if (!auth) return;
      const a = addressOf(req);
      if (!a) {
        apiError(res, 400, 'invalid job address');
        return;
      }
      const body = typeof req.body === 'string' ? req.body : '';
      // Validate every line before appending: the log file is read back as
      // ndjson by the UI, so a malformed line would corrupt the stream.
      const lines: string[] = [];
      for (const raw of body.split('\n')) {
        if (raw.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const p = parsed as Partial<LogLine>;
        if (typeof p.l !== 'string' || typeof p.s !== 'number') continue;
        lines.push(JSON.stringify({ s: p.s, t: typeof p.t === 'string' ? p.t : new Date().toISOString(), l: p.l }));
      }
      if (lines.length === 0) {
        res.json({ ok: true });
        return;
      }
      const ok = engine.appendLogs(
        a.collection,
        a.repo,
        a.run,
        a.job,
        leaseOf(req),
        auth.name,
        lines.join('\n') + '\n'
      );
      if (!ok) {
        apiError(res, 409, 'the lease on this job is no longer valid');
        return;
      }
      res.json({ ok: true });
    }
  );

  app.post('/api/runner/jobs/:collection/:repo/:run/:job/status', json, (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status === 'completed' ? 'completed' : 'running';
    const conclusion =
      typeof body.conclusion === 'string' &&
      ['success', 'failure', 'cancelled', 'skipped'].includes(body.conclusion)
        ? (body.conclusion as Conclusion)
        : undefined;
    const stepStates = Array.isArray(body.stepStates) ? (body.stepStates as StepState[]) : undefined;
    const outputs =
      typeof body.outputs === 'object' && body.outputs !== null
        ? (Object.fromEntries(
            Object.entries(body.outputs as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string])
          ) as Record<string, string>)
        : undefined;
    const summaries = Array.isArray(body.summaries)
      ? (body.summaries as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;
    const ok = engine.reportStatus(a.collection, a.repo, a.run, a.job, {
      lease: leaseOf(req),
      runner: auth.name,
      status,
      conclusion,
      stepStates,
      outputs,
      summaries,
    });
    if (!ok) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    res.json({ ok: true });
  });

  // ---- artifacts ----
  //
  // A job uploads under a name and a later job in the same run downloads by
  // that name. Authorization is the job's lease, so an artifact can only be
  // written by a job that is actually running, and only into its own run.

  app.put('/api/runner/jobs/:collection/:repo/:run/:job/artifacts/:name', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    const name = req.params.name;
    if (!isValidArtifactName(name)) {
      apiError(res, 400, 'invalid artifact name');
      return;
    }
    if (!engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name)) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    const dir = artifactsDir(root, a.collection, a.repo, a.run);
    const file = artifactPath(root, a.collection, a.repo, a.run, name);
    if (!dir || !file) {
      apiError(res, 400, 'invalid artifact target');
      return;
    }
    const limit = engine.artifactLimitBytes();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const out = fs.createWriteStream(tmp);
    let written = 0;
    let failed = false;
    const abort = (status: number, message: string) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rmSync(tmp, { force: true });
      req.unpipe(out);
      req.resume();
      apiError(res, status, message);
    };
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > limit) {
        abort(413, `artifact ${name} exceeds the ${Math.round(limit / (1024 * 1024))} MB limit for this vault`);
      }
    });
    req.on('error', () => abort(400, 'the upload was interrupted'));
    out.on('error', () => abort(500, 'could not store the artifact'));
    out.on('finish', () => {
      if (failed) return;
      try {
        fs.renameSync(tmp, file);
      } catch {
        apiError(res, 500, 'could not store the artifact');
        return;
      }
      res.json({ name, size: written });
    });
    req.pipe(out);
  });

  app.get('/api/runner/jobs/:collection/:repo/:run/:job/artifacts/:name', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    if (!engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name)) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    const file = artifactPath(root, a.collection, a.repo, a.run, req.params.name);
    if (!file || !fs.existsSync(file)) {
      apiError(res, 404, `no artifact named ${req.params.name} in this run`);
      return;
    }
    res.type('application/x-tar').sendFile(path.resolve(file));
  });

  app.get('/api/runner/jobs/:collection/:repo/:run/:job/artifacts', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    if (!engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name)) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    res.json({ artifacts: listArtifacts(root, a.collection, a.repo, a.run) });
  });

  // Publishing an artifact as the repository's site. The extraction happens
  // here rather than on the runner because the site directory is vault
  // state; artifacts.ts treats the archive as untrusted.
  app.post('/api/runner/jobs/:collection/:repo/:run/:job/site', json, async (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    if (!engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name)) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    // The repository's own settings gate the write, not the runner's standing:
    // a site that is not enabled is not deployed to, and one published by
    // copying files is not deployed to either, so a workflow cannot overwrite
    // what somebody maintains by hand. The refusal names the setting to change.
    const repo = findRepo(root, a.collection, a.repo);
    const settings = repo ? siteSettings(repo.dir) : null;
    if (!settings || !settings.enabled) {
      apiError(res, 403, `the site for ${a.collection}/${a.repo} is not enabled; a repository admin can enable it in the repository's settings`);
      return;
    }
    if (settings.source !== 'actions') {
      apiError(res, 403, `the site for ${a.collection}/${a.repo} is published by copying files, not by workflow deploys; set its site source to workflow deploys first`);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.artifact === 'string' ? body.artifact : 'github-pages';
    if (!isValidArtifactName(name)) {
      apiError(res, 400, 'invalid artifact name');
      return;
    }
    try {
      const result = await deploySite(root, a.collection, a.repo, a.run, name);
      res.json({
        deployed: true,
        files: result.files,
        url: siteOf(req, a.collection, a.repo).url,
      });
    } catch (e) {
      apiError(res, e instanceof ArtifactError ? 400 : 500, e instanceof Error ? e.message : String(e));
    }
  });

  // Runner-side liveness check, so `mochi runner run` can fail fast with a
  // clear message rather than long-polling against a bad token or host.
  app.get('/api/runner/whoami', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    res.json({ name: auth.name, labels: auth.runner.labels, allow: auth.runner.allow });
  });
}
