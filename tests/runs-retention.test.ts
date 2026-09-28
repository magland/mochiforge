import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { artifactPath, deploySite, pruneDeployedArtifacts } from '../src/ci/artifacts';
import { type JobRecord, listRuns, pruneRuns, runsDir, type RunRecord, writeJob, writeRun } from '../src/ci/runs';
import { runsSweep } from '../src/maintenance';
import { makeBareRepo, makeVaultDir } from './helpers';

// Run retention and the deleting of deployed site artifacts. Runs are written
// as the engine leaves them on disk, so none of this needs a runner.

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-28T12:00:00Z');

function iso(agoMs: number): string {
  return new Date(NOW - agoMs).toISOString();
}

function addRun(root: string, n: number, agoMs: number, jobs: JobRecord[] = []): void {
  const run = {
    number: n,
    workflowPath: '.github/workflows/deploy.yml',
    workflowName: 'Deploy',
    event: 'push',
    ref: 'refs/heads/main',
    refName: 'main',
    sha: '0'.repeat(40),
    actor: 'owner',
    message: `run ${n}`,
    payload: {},
    status: 'completed',
    conclusion: 'success',
    createdAt: iso(agoMs),
    completedAt: iso(agoMs),
    jobs: jobs.map((j) => j.id),
  } as RunRecord;
  fs.mkdirSync(path.join(runsDir(root, 'demo', 'proj')!, String(n), 'jobs'), { recursive: true });
  writeRun(root, 'demo', 'proj', run);
  for (const job of jobs) writeJob(root, 'demo', 'proj', n, job);
}

function job(steps: unknown[], conclusions: string[]): JobRecord {
  return {
    id: 'deploy',
    key: 'deploy',
    name: 'deploy',
    needs: [],
    runsOn: ['ubuntu-latest'],
    matrix: null,
    strategy: null,
    env: {},
    steps,
    outputsTemplate: {},
    status: 'completed',
    conclusion: conclusions.every((c) => c === 'success') ? 'success' : 'failure',
    outputs: {},
    stepStates: conclusions.map((c, i) => ({ name: `step ${i}`, status: 'completed', conclusion: c })),
    attempts: 1,
  } as JobRecord;
}

function putArtifact(root: string, n: number, name: string): string {
  const file = artifactPath(root, 'demo', 'proj', n, name)!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(1000));
  return file;
}

function numbers(root: string): number[] {
  return listRuns(root, 'demo', 'proj').map((r) => r.number);
}

test('runs beyond the count are pruned once they are a day old', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  for (let n = 1; n <= 5; n++) addRun(root, n, (6 - n) * 48 * HOUR);
  pruneRuns(root, 'demo', 'proj', { runs: 2, days: 0 }, NOW);
  assert.deepEqual(numbers(root), [5, 4]);
});

test('a run completed in the last day is kept whatever the count says', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  addRun(root, 1, 72 * HOUR);
  addRun(root, 2, 30 * HOUR);
  addRun(root, 3, 23 * HOUR);
  addRun(root, 4, 2 * HOUR);
  addRun(root, 5, 1 * HOUR);
  pruneRuns(root, 'demo', 'proj', { runs: 2, days: 0 }, NOW);
  assert.deepEqual(numbers(root), [5, 4, 3]);
});

test('the day is counted from completion, not creation', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  addRun(root, 1, 72 * HOUR);
  const run = listRuns(root, 'demo', 'proj')[0];
  writeRun(root, 'demo', 'proj', { ...run, completedAt: iso(HOUR) });
  addRun(root, 2, 48 * HOUR);
  pruneRuns(root, 'demo', 'proj', { runs: 0, days: 1 }, NOW);
  assert.deepEqual(numbers(root), [1]);
});

test('a deployed site artifact is deleted from a completed run', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  const steps = [{ uses: 'actions/upload-pages-artifact@v3' }, { uses: 'actions/deploy-pages@v4' }];
  addRun(root, 1, 48 * HOUR, [job(steps, ['success', 'success'])]);
  const tar = putArtifact(root, 1, 'github-pages');
  assert.equal(pruneDeployedArtifacts(root, 'demo', 'proj'), 1000);
  assert.ok(!fs.existsSync(tar));
});

test('an artifact whose deploy failed, or that was never deployed, is kept', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  const failed = [{ uses: 'actions/upload-pages-artifact@v3' }, { uses: 'actions/deploy-pages@v4' }];
  addRun(root, 1, 48 * HOUR, [job(failed, ['success', 'failure'])]);
  const kept = putArtifact(root, 1, 'github-pages');
  addRun(root, 2, 48 * HOUR, [job([{ uses: 'actions/upload-artifact@v4' }], ['success'])]);
  const plain = putArtifact(root, 2, 'site');
  assert.equal(pruneDeployedArtifacts(root, 'demo', 'proj'), 0);
  assert.ok(fs.existsSync(kept));
  assert.ok(fs.existsSync(plain));
});

test('a deploy of a named artifact deletes that one, and an expression name deletes nothing', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  addRun(root, 1, 48 * HOUR, [job([{ uses: 'actions/deploy-pages@v4', with: { artifact_name: 'docs' } }], ['success'])]);
  const docs = putArtifact(root, 1, 'docs');
  const pages = putArtifact(root, 1, 'github-pages');
  addRun(root, 2, 48 * HOUR, [
    job([{ uses: 'actions/deploy-pages@v4', with: { artifact_name: '${{ matrix.name }}' } }], ['success']),
  ]);
  const unresolved = putArtifact(root, 2, 'github-pages');
  pruneDeployedArtifacts(root, 'demo', 'proj');
  assert.ok(!fs.existsSync(docs));
  assert.ok(fs.existsSync(pages));
  assert.ok(fs.existsSync(unresolved));
});

test('the sweep applies retention and clears deployed artifacts across the vault', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ci: { runs: 1, days: 0 } }));
  const steps = [{ uses: 'actions/deploy-pages@v4' }];
  addRun(root, 1, 96 * HOUR);
  addRun(root, 2, 72 * HOUR, [job(steps, ['success'])]);
  const tar = putArtifact(root, 2, 'github-pages');
  assert.equal(runsSweep(root), 1000);
  assert.ok(!fs.existsSync(tar));
  assert.deepEqual(numbers(root), [2]);
});

test('deploying a site deletes the artifact it was deployed from', async () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  addRun(root, 1, HOUR);
  const src = path.join(root, 'src-site');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'index.html'), '<h1>hi</h1>');
  const tar = artifactPath(root, 'demo', 'proj', 1, 'github-pages')!;
  fs.mkdirSync(path.dirname(tar), { recursive: true });
  execFileSync('tar', ['-cf', tar, '-C', src, '.']);
  const result = await deploySite(root, 'demo', 'proj', 1, 'github-pages');
  assert.equal(result.files, 1);
  assert.ok(!fs.existsSync(tar));
  const site = path.join(path.dirname(runsDir(root, 'demo', 'proj')!), 'proj.site', 'index.html');
  assert.ok(fs.existsSync(site));
});
