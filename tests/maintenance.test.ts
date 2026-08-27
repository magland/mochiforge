import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { repoNeedsGc } from '../src/maintenance';
import { migratePushPolicy } from '../src/migrate';
import { makeBareRepo, makeVaultDir } from './helpers';

// The sweep's decision, and the upgrade that unfreezes force pushes. Neither
// needs a git binary: the first reads mtimes, and the second only reaches for
// git on a repository whose config still carries the old setting.

const STAMP = 'mochi-last-gc';

/** Stamp a repository as collected, optionally at a time in the past. */
function stamp(dir: string, agoMs = 0): void {
  const file = path.join(dir, STAMP);
  fs.writeFileSync(file, '');
  if (agoMs > 0) {
    const when = new Date(Date.now() - agoMs);
    fs.utimesSync(file, when, when);
  }
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

test('a repository never collected is collected', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  assert.ok(repoNeedsGc(dir));
});

test('a repository untouched since its last collection is left alone', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  touch(path.join(dir, 'refs', 'heads', 'main'));
  stamp(dir);
  assert.ok(!repoNeedsGc(dir));
});

test('a branch written since the last collection brings the repository back', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  stamp(dir, 60 * 60 * 1000);
  touch(path.join(dir, 'refs', 'heads', 'topic'));
  assert.ok(repoNeedsGc(dir));
});

test('a push that only added objects brings the repository back', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  stamp(dir, 60 * 60 * 1000);
  touch(path.join(dir, 'objects', 'pack', 'pack-abc.pack'));
  assert.ok(repoNeedsGc(dir));
});

test('packed refs count as a change, and a stamp alone does not', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  touch(path.join(dir, 'packed-refs'));
  stamp(dir);
  assert.ok(!repoNeedsGc(dir));
  const later = new Date(Date.now() + 1000);
  fs.utimesSync(path.join(dir, 'packed-refs'), later, later);
  assert.ok(repoNeedsGc(dir));
});

test('the push policy upgrade names only the repositories that still refuse force pushes', () => {
  const root = makeVaultDir();
  const frozen = makeBareRepo(root, 'demo', 'old');
  const current = makeBareRepo(root, 'demo', 'new');
  fs.writeFileSync(
    path.join(frozen, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tbare = true\n[receive]\n\tdenyNonFastForwards = true\n\tdenyDeletes = true\n'
  );
  fs.writeFileSync(path.join(current, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n[receive]\n\tdenyDeletes = true\n');

  const changed = migratePushPolicy(root);

  assert.deepEqual(changed, ['demo/old']);
  const after = fs.readFileSync(path.join(frozen, 'config'), 'utf8');
  assert.ok(!/denyNonFastForwards/i.test(after), 'the setting is gone');
  assert.ok(/denyDeletes/i.test(after), 'and deletes are still refused on push');
  // Idempotent: the second start of the server has nothing left to say.
  assert.deepEqual(migratePushPolicy(root), []);
});
