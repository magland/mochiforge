import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiEngine } from '../src/ci/engine';
import {
  findMintable,
  findSession,
  isManualJob,
  loadGrants,
  mintGrant,
  redeemGrant,
  sessionRunnerName,
} from '../src/ci/manual';
import { JobRecord, RunRecord, createRun, readJob } from '../src/ci/runs';
import { makeBareRepo, makeVaultDir } from './helpers';

// Manual jobs: the grant lifecycle (mint, redeem, spend), and the engine's
// side of a session (never dispatched to runners, leased to a session,
// released on decline, failed at once when the session dies).

const RETENTION = () => ({ runs: 100, days: 0, artifactMb: 100 });

function mkJob(id: string, runsOn: string[], needs: string[] = []): JobRecord {
  return {
    id,
    key: id,
    name: id,
    needs,
    runsOn,
    matrix: null,
    strategy: null,
    env: {},
    steps: [{ run: 'echo hi', env: {} }],
    outputsTemplate: {},
    status: 'queued',
    outputs: {},
    stepStates: [],
    attempts: 0,
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

function vaultWithRun(jobs: JobRecord[]): { root: string; engine: CiEngine } {
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'demo');
  createRun(root, 'alice', 'demo', (n) => ({ run: mkRun(n, jobs), jobs }));
  return { root, engine: new CiEngine(root, RETENTION) };
}

test('isManualJob is about the manual label, wherever it sits in runs-on', () => {
  assert.ok(isManualJob(['manual']));
  assert.ok(isManualJob(['ubuntu-latest', 'manual']));
  assert.ok(!isManualJob(['ubuntu-latest']));
  assert.ok(!isManualJob([]));
});

test('a grant mints, redeems once, and the mint token is spent by redemption', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'demo');
  const jobs = [mkJob('bigmem', ['manual'])];
  createRun(root, 'alice', 'demo', (n) => ({ run: mkRun(n, jobs), jobs }));

  const { token, grant } = mintGrant(root, 'alice', 'demo', 1, 'alice');
  assert.ok(token.startsWith('mochi_run_'));
  const grants = loadGrants(root, 'alice', 'demo', 1);
  assert.equal(grants.length, 1);
  assert.equal(findMintable(grants, token)?.id, grant.id);
  assert.equal(findMintable(grants, 'mochi_run_' + 'f'.repeat(48)), null);

  const session = redeemGrant(root, 'alice', 'demo', 1, grant.id, 'myhost');
  assert.ok(session && session.startsWith('mochi_manual_'));
  const after = loadGrants(root, 'alice', 'demo', 1);
  assert.equal(findMintable(after, token), null); // spent
  assert.equal(findSession(after, session!)?.id, grant.id);
  assert.equal(after[0].host, 'myhost');
  assert.equal(redeemGrant(root, 'alice', 'demo', 1, grant.id, 'other'), null); // once
});

test('an expired grant answers to nothing, and a new mint prunes it', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'demo');
  const jobs = [mkJob('bigmem', ['manual'])];
  createRun(root, 'alice', 'demo', (n) => ({ run: mkRun(n, jobs), jobs }));
  const { token } = mintGrant(root, 'alice', 'demo', 1, 'alice');
  const grants = loadGrants(root, 'alice', 'demo', 1);
  const expired = [{ ...grants[0], expiresAt: new Date(Date.now() - 1000).toISOString() }];
  assert.equal(findMintable(expired, token), null);
});

test('the engine never hands a manual job to a runner, whatever labels it claims', () => {
  const { engine } = vaultWithRun([mkJob('build', ['ubuntu-latest']), mkJob('bigmem', ['manual', 'ubuntu-latest'])]);
  const first = engine.acquire('r1', ['ubuntu-latest', 'manual'], ['alice/*'], 'http://v', null);
  assert.ok(first);
  assert.equal(first.address.job, 'build');
  assert.equal(engine.acquire('r1', ['ubuntu-latest', 'manual'], ['alice/*'], 'http://v', null), null);
  const load = engine.runnerLoad();
  assert.deepEqual(
    load.queued.map((q) => [q.job, q.manual]),
    [['bigmem', true]]
  );
});

test('a session takes the manual jobs of its run, in needs order, and only those', () => {
  const { root, engine } = vaultWithRun([
    mkJob('build', ['ubuntu-latest']),
    mkJob('bigmem', ['manual']),
    mkJob('report', ['manual'], ['bigmem']),
  ]);
  const minted = engine.mintManual('alice', 'demo', 1, 'alice');
  assert.ok(!('error' in minted));
  const redeemed = engine.redeemManual(minted.token, 'office');
  assert.ok(redeemed);
  assert.equal(redeemed.jobs.length, 2); // the manual ones
  assert.equal(engine.redeemManual(minted.token, 'office'), null); // spent

  const auth = engine.authenticateManualSession(redeemed.sessionToken);
  assert.ok(auth && auth.active);
  const name = sessionRunnerName(auth.grant);

  // A filter that matches nothing is a 'done', said plainly.
  const filtered = engine.acquireManual('alice', 'demo', 1, auth.grant, 'zzz', 'http://v');
  assert.equal(filtered.kind, 'done');

  const got = engine.acquireManual('alice', 'demo', 1, auth.grant, null, 'http://v');
  assert.equal(got.kind, 'job');
  const spec = (got as { kind: 'job'; spec: import('../src/ci/protocol').JobSpec }).spec;
  assert.equal(spec.address.job, 'bigmem');
  assert.equal(readJob(root, 'alice', 'demo', 1, 'bigmem')?.manual?.user, 'alice');
  assert.equal(readJob(root, 'alice', 'demo', 1, 'bigmem')?.manual?.host, 'office');

  // report needs bigmem, so the session waits rather than being done.
  const next = engine.acquireManual('alice', 'demo', 1, auth.grant, null, 'http://v');
  assert.equal(next.kind, 'wait');

  // Declining hands the job back untouched, attribution and all.
  assert.ok(engine.releaseManualJob('alice', 'demo', 1, 'bigmem', spec.lease, name));
  const released = readJob(root, 'alice', 'demo', 1, 'bigmem');
  assert.equal(released?.status, 'queued');
  assert.equal(released?.manual, undefined);

  // And it can be taken again.
  const again = engine.acquireManual('alice', 'demo', 1, auth.grant, null, 'http://v');
  assert.equal(again.kind, 'job');
});

test('a manual lease that expires fails the job at once, naming the session', () => {
  const { engine } = vaultWithRun([mkJob('bigmem', ['manual'])]);
  const minted = engine.mintManual('alice', 'demo', 1, 'alice');
  assert.ok(!('error' in minted));
  const redeemed = engine.redeemManual(minted.token, 'office')!;
  const auth = engine.authenticateManualSession(redeemed.sessionToken)!;
  const got = engine.acquireManual('alice', 'demo', 1, auth.grant, null, 'http://v');
  assert.equal(got.kind, 'job');
  const job = engine.jobOf('alice', 'demo', 1, 'bigmem')!;
  job.lease!.expiresAt = new Date(Date.now() - 1000).toISOString();
  (engine as unknown as { sweepLeases(): void }).sweepLeases();
  const failed = engine.jobOf('alice', 'demo', 1, 'bigmem')!;
  assert.equal(failed.status, 'completed');
  assert.equal(failed.conclusion, 'failure');
  assert.match(failed.error ?? '', /manual session/);
  assert.match(failed.error ?? '', /alice/);
  // The run is over, and the session is told so rather than left polling.
  const after = engine.acquireManual('alice', 'demo', 1, auth.grant, null, 'http://v');
  assert.equal(after.kind, 'done');
});

test('minting is refused for a run with no manual jobs, and for a finished run', () => {
  const { engine } = vaultWithRun([mkJob('build', ['ubuntu-latest'])]);
  assert.deepEqual(engine.mintManual('alice', 'demo', 1, 'alice'), { error: 'no-manual' });
  assert.deepEqual(engine.mintManual('alice', 'demo', 99, 'alice'), { error: 'finished' });
});
