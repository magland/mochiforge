import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { CiEngine } from '../src/ci/engine';
import { JobRecord, RunRecord, createRun } from '../src/ci/runs';
import {
  DEFAULT_JOB_TIMEOUT_MINUTES,
  MAX_JOB_TIMEOUT_MINUTES,
  RUNNERS_FILE,
  isUsableJobTimeout,
  loadRunners,
  registerRunner,
  runnerJobTimeout,
  setRunnerJobTimeout,
} from '../src/ci/runners';
import { setRepoPrivate } from '../src/perms';
import { makeBareRepo, makeVaultDir } from './helpers';

// How long a job may run: the per-runner setting in the registry, and the
// engine's use of it as a ceiling on what a workflow asked for.

const RETENTION = () => ({ runs: 100, days: 0, artifactMb: 100 });

function mkJob(id: string, timeoutMinutes?: string): JobRecord {
  return {
    id,
    key: id,
    name: id,
    needs: [],
    runsOn: ['ubuntu-latest'],
    matrix: null,
    strategy: null,
    env: {},
    steps: [{ run: 'echo hi', env: {} }],
    outputsTemplate: {},
    status: 'queued',
    outputs: {},
    stepStates: [],
    attempts: 0,
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
  };
}

function mkRun(n: number, jobs: JobRecord[]): RunRecord {
  return {
    number: n,
    workflowPath: '.github/workflows/ci.yml',
    workflowName: 'ci',
    event: 'push',
    ref: 'refs/heads/main',
    refName: 'main',
    sha: 'a'.repeat(40),
    actor: 'alice',
    message: '',
    payload: null,
    status: 'queued',
    createdAt: new Date().toISOString(),
    jobs: jobs.map((j) => j.id),
  };
}

/** A vault with one queued job, and an engine over it. */
function vaultWithJob(job: JobRecord): { root: string; engine: CiEngine } {
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'demo');
  createRun(root, 'alice', 'demo', (n) => ({ run: mkRun(n, [job]), jobs: [job] }));
  return { root, engine: new CiEngine(root, RETENTION) };
}

function take(engine: CiEngine, limit: number | null): number {
  const spec = engine.acquire('r1', ['ubuntu-latest'], ['alice/*'], 'http://v', limit);
  assert.ok(spec, 'the job should have been leased');
  return spec.timeoutMinutes;
}

test('a runner with no setting of its own runs jobs under the default', () => {
  const root = makeVaultDir();
  const { runner } = registerRunner(root, 'r1', { labels: ['ubuntu-latest'], allow: ['alice/*'], createdBy: 'alice' });
  assert.equal(runner.jobTimeoutMinutes, undefined, 'nothing is stored where nothing was asked for');
  assert.equal(runnerJobTimeout(runner), DEFAULT_JOB_TIMEOUT_MINUTES);
  assert.equal(DEFAULT_JOB_TIMEOUT_MINUTES, 20);
});

test('a timeout given at registration is stored, and set later replaces it', () => {
  const root = makeVaultDir();
  registerRunner(root, 'r1', {
    labels: ['ubuntu-latest'],
    allow: ['alice/*'],
    createdBy: 'alice',
    jobTimeoutMinutes: 45,
  });
  assert.equal(runnerJobTimeout(loadRunners(root).runners.r1), 45);
  setRunnerJobTimeout(root, 'r1', 90);
  assert.equal(runnerJobTimeout(loadRunners(root).runners.r1), 90);
  // Cleared, the field goes rather than holding a number equal to the default,
  // so a later change to the default reaches this runner.
  setRunnerJobTimeout(root, 'r1', null);
  assert.equal(loadRunners(root).runners.r1.jobTimeoutMinutes, undefined);
  assert.equal(runnerJobTimeout(loadRunners(root).runners.r1), DEFAULT_JOB_TIMEOUT_MINUTES);
  assert.equal(setRunnerJobTimeout(root, 'nosuch', 30), null);
});

test('a usable timeout is whole minutes within the bound a delay can hold', () => {
  assert.ok(isUsableJobTimeout(1) && isUsableJobTimeout(20) && isUsableJobTimeout(MAX_JOB_TIMEOUT_MINUTES));
  assert.ok(!isUsableJobTimeout(0));
  assert.ok(!isUsableJobTimeout(-5));
  assert.ok(!isUsableJobTimeout(1.5));
  assert.ok(!isUsableJobTimeout(MAX_JOB_TIMEOUT_MINUTES + 1));
  assert.ok(!isUsableJobTimeout(NaN));
});

test('a hand-edited timeout that is not usable leaves the runner on the default', () => {
  const root = makeVaultDir();
  registerRunner(root, 'r1', { labels: ['ubuntu-latest'], allow: ['alice/*'], createdBy: 'alice' });
  const file = path.join(root, RUNNERS_FILE);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.runners.r1.jobTimeoutMinutes = 'soon';
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(loadRunners(root).runners.r1.jobTimeoutMinutes, undefined);
  assert.equal(runnerJobTimeout(loadRunners(root).runners.r1), DEFAULT_JOB_TIMEOUT_MINUTES);
  assert.ok(loadRunners(root).runners.r1.hash, 'and the runner still works');
});

test("the runner's limit caps a job that asks for more, and GitHub's default too", () => {
  assert.equal(take(vaultWithJob(mkJob('build')).engine, 20), 20, 'no timeout-minutes: the six-hour default is cut');
  assert.equal(take(vaultWithJob(mkJob('build', '360')).engine, 20), 20);
  assert.equal(take(vaultWithJob(mkJob('build', '25')).engine, 20), 20);
});

test('a job asking for less than the limit keeps what it asked for', () => {
  assert.equal(take(vaultWithJob(mkJob('build', '5')).engine, 20), 5);
  assert.equal(take(vaultWithJob(mkJob('build', '5')).engine, null), 5);
});

test('a manual session has no limit, so the workflow decides alone', () => {
  assert.equal(take(vaultWithJob(mkJob('build')).engine, null), 360, "GitHub's default stands");
  assert.equal(take(vaultWithJob(mkJob('build', '90')).engine, null), 90);
});

test('the clone token a private job carries expires with the timeout it was given', () => {
  // A private repository's job carries an ephemeral read token minted for the
  // timeout plus half an hour, so capping the timeout has to shorten the
  // credential with it rather than leave one outliving every job it was for.
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'alice', 'demo');
  setRepoPrivate(dir, true);
  const job = mkJob('build', '360');
  createRun(root, 'alice', 'demo', (n) => ({ run: mkRun(n, [job]), jobs: [job] }));
  const engine = new CiEngine(root, RETENTION);
  const spec = engine.acquire('r1', ['ubuntu-latest'], ['alice/*'], 'http://v', 20);
  assert.ok(spec?.cloneToken, 'a private repository job carries one');
  const exp = tokenExpiry(spec.cloneToken);
  const minutes = (exp - Date.now()) / 60_000;
  assert.ok(minutes > 45 && minutes <= 50, `expected around 50 minutes, got ${Math.round(minutes)}`);
});

/** The expiry a job token carries: its signed body, read as src/jobtoken.ts writes it. */
function tokenExpiry(token: string): number {
  const rest = token.slice('mochijob_'.length);
  const body = rest.slice(0, rest.lastIndexOf('.'));
  return (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp: number }).exp;
}
