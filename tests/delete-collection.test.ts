import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { OpError, createCollection, deleteCollection } from '../src/ops';
import { addCollectionOwner } from '../src/perms';
import { loadRedirects, recordCollectionRename } from '../src/redirects';
import { setCollectionAlias } from '../src/sitesettings';
import { makeBareRepo, makeVaultDir, removeBareRepo } from './helpers';

// Deleting a collection is allowed only when it is empty: no repository and
// nothing a repository keeps beside it. The collection's own metadata is not
// an obstacle - the owners file and the site alias describe the collection and
// go with it -
// but a file the server did not put there is, since deletion has no business
// removing what it does not recognize.

function collectionPath(root: string, name: string): string {
  return path.join(root, 'collections', name);
}

test('an empty collection is deleted, directory and all', () => {
  const root = makeVaultDir();
  createCollection(root, 'demo');
  deleteCollection(root, 'demo');
  assert.ok(!fs.existsSync(collectionPath(root, 'demo')));
});

test('the owners file goes with the collection rather than blocking it', () => {
  const root = makeVaultDir();
  createCollection(root, 'demo');
  addCollectionOwner(root, 'demo', 'alice');
  deleteCollection(root, 'demo');
  assert.ok(!fs.existsSync(collectionPath(root, 'demo')));
});

test('the site alias goes with the collection too', () => {
  const root = makeVaultDir();
  createCollection(root, 'demo');
  setCollectionAlias(root, 'demo', 'demo-sites');
  deleteCollection(root, 'demo');
  assert.ok(!fs.existsSync(collectionPath(root, 'demo')));
});

test('a collection holding a repository is refused, not emptied', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'demo', 'proj');
  assert.throws(() => deleteCollection(root, 'demo'), (e: unknown) => e instanceof OpError && e.kind === 'conflict');
  assert.ok(fs.existsSync(collectionPath(root, 'demo')));
  // Emptied of its repository, the same collection deletes.
  removeBareRepo(root, 'demo', 'proj');
  deleteCollection(root, 'demo');
  assert.ok(!fs.existsSync(collectionPath(root, 'demo')));
});

test('a sibling directory left in repos also counts as not empty', () => {
  const root = makeVaultDir();
  createCollection(root, 'demo');
  fs.mkdirSync(path.join(root, 'collections', 'demo', 'repos', 'proj.issues'));
  assert.throws(() => deleteCollection(root, 'demo'), /not empty/);
});

test('a file the server does not recognize is refused rather than deleted', () => {
  const root = makeVaultDir();
  createCollection(root, 'demo');
  fs.writeFileSync(path.join(collectionPath(root, 'demo'), 'notes.txt'), 'keep me');
  assert.throws(() => deleteCollection(root, 'demo'), /notes\.txt/);
  assert.ok(fs.existsSync(path.join(collectionPath(root, 'demo'), 'notes.txt')));
});

test('a missing collection is notfound, and an invalid name is refused', () => {
  const root = makeVaultDir();
  assert.throws(() => deleteCollection(root, 'gone'), (e: unknown) => e instanceof OpError && e.kind === 'notfound');
  assert.throws(() => deleteCollection(root, '../escape'), OpError);
});

test('redirects pointing at the deleted collection are forgotten', () => {
  const root = makeVaultDir();
  createCollection(root, 'newc');
  recordCollectionRename(root, 'oldc', 'newc');
  deleteCollection(root, 'newc');
  assert.deepEqual(loadRedirects(root).collections, {});
});
