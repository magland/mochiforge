import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import {
  COLLECTION_SITE_FILE,
  SITE_SETTINGS_FILE,
  collectionAliasConflict,
  collectionForSiteAlias,
  collectionSiteAlias,
  collectionSiteAliases,
  editSiteSettings,
  findRepoBySiteLabel,
  isUsableCollectionAlias,
  isUsableSiteLabel,
  listSiteLabels,
  setCollectionAlias,
  siteHostFor,
  siteLabelConflict,
  siteSettings,
  storedCollectionAlias,
} from '../src/sitesettings';
import { reservedSiteLabels } from '../src/siteshost';
import { makeBareRepo, makeVaultDir } from './helpers';

test('a repository with no site.json publishes nothing: the strict opt-in default', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'webapp');
  assert.deepEqual(siteSettings(dir), { enabled: false, source: 'copy', label: '' });
});

test('normalization keeps only what it recognises, and fails closed on garbage', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'webapp');
  const file = path.join(dir, SITE_SETTINGS_FILE);
  fs.writeFileSync(file, JSON.stringify({ enabled: 'yes', source: 'branch', label: 'Bad_Label' }));
  assert.deepEqual(siteSettings(dir), { enabled: false, source: 'copy', label: '' });
  fs.writeFileSync(file, 'not json at all: an unreadable grant grants nothing');
  assert.deepEqual(siteSettings(dir), { enabled: false, source: 'copy', label: '' });
});

test('editSiteSettings round-trips, and the read sees the write immediately', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'webapp');
  editSiteSettings(dir, (s) => {
    s.enabled = true;
    s.source = 'actions';
    s.label = 'my-app';
  });
  assert.deepEqual(siteSettings(dir), { enabled: true, source: 'actions', label: 'my-app' });
  editSiteSettings(dir, (s) => {
    s.enabled = false;
  });
  assert.deepEqual(siteSettings(dir), { enabled: false, source: 'actions', label: 'my-app' });
});

test('a usable label is a single DNS label with no double hyphen', () => {
  assert.ok(isUsableSiteLabel('webapp'));
  assert.ok(isUsableSiteLabel('my-app-2'));
  assert.ok(!isUsableSiteLabel(''));
  assert.ok(!isUsableSiteLabel('My-App'));
  assert.ok(!isUsableSiteLabel('a--b'), 'a double hyphen would collide with derived labels');
  assert.ok(!isUsableSiteLabel('-lead'));
  assert.ok(!isUsableSiteLabel('trail-'));
  assert.ok(!isUsableSiteLabel('dot.ted'));
  assert.ok(isUsableSiteLabel('a'.repeat(63)));
  assert.ok(!isUsableSiteLabel('a'.repeat(64)));
});

test('findRepoBySiteLabel scans the vault, and the conflict check spares the holder itself', () => {
  const root = makeVaultDir();
  const a = makeBareRepo(root, 'alice', 'webapp');
  makeBareRepo(root, 'bob', 'other');
  editSiteSettings(a, (s) => {
    s.label = 'docs';
  });
  assert.deepEqual(findRepoBySiteLabel(root, 'docs'), { collection: 'alice', repo: 'webapp' });
  assert.equal(findRepoBySiteLabel(root, 'nothing'), null);
  assert.equal(siteLabelConflict(root, 'docs', 'alice', 'webapp'), null);
  assert.equal(siteLabelConflict(root, 'docs', 'bob', 'other'), 'alice/webapp');
  assert.equal(siteLabelConflict(root, 'free', 'bob', 'other'), null);
});

test('a reserved label is not usable, so the operator keeps the names under the sites host', () => {
  assert.ok(!isUsableSiteLabel('www'));
  assert.ok(!isUsableSiteLabel('api'));
  assert.ok(isUsableSiteLabel('wwww'), 'only the exact names are reserved');
  assert.ok(reservedSiteLabels().includes('www'));
  // A stored label that is reserved reads as none, so the site falls back to
  // its derived hostname rather than holding a name it may not have.
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'webapp');
  fs.writeFileSync(path.join(dir, SITE_SETTINGS_FILE), JSON.stringify({ enabled: true, label: 'www' }));
  assert.equal(siteSettings(dir).label, '');
});

test('listSiteLabels reads the whole flat namespace, sorted', () => {
  const root = makeVaultDir();
  const a = makeBareRepo(root, 'alice', 'webapp');
  const b = makeBareRepo(root, 'bob', 'notes');
  makeBareRepo(root, 'bob', 'plain');
  editSiteSettings(a, (s) => {
    s.label = 'zebra';
  });
  editSiteSettings(b, (s) => {
    s.label = 'apple';
  });
  assert.deepEqual(listSiteLabels(root), [
    { label: 'apple', collection: 'bob', repo: 'notes' },
    { label: 'zebra', collection: 'alice', repo: 'webapp' },
  ]);
});

test('a collection usable as a label is its own alias, at a tier nothing can take away', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'webapp');
  assert.equal(collectionSiteAlias(root, 'alice'), 'alice');
  assert.equal(collectionForSiteAlias(root, 'alice'), 'alice');
  assert.equal(siteHostFor(root, 'v-sites.example.org', 'alice', 'webapp'), 'webapp--alice.v-sites.example.org');
  // A second collection whose name rewrites to `alice` must not shadow it.
  makeBareRepo(root, 'Alice', 'other');
  assert.equal(collectionSiteAlias(root, 'alice'), 'alice');
  assert.equal(collectionForSiteAlias(root, 'alice'), 'alice');
  assert.equal(collectionSiteAlias(root, 'Alice'), null);
  assert.equal(siteHostFor(root, 'v-sites.example.org', 'Alice', 'other'), null);
});

test('a name no hostname label may carry is rewritten, which is what gives it a derived hostname', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'simulated_instruments', 'cymbal2');
  assert.equal(collectionSiteAlias(root, 'simulated_instruments'), 'simulated-instruments');
  assert.equal(collectionForSiteAlias(root, 'simulated-instruments'), 'simulated_instruments');
  assert.equal(
    siteHostFor(root, 'v-sites.example.org', 'simulated_instruments', 'cymbal2'),
    'cymbal2--simulated-instruments.v-sites.example.org'
  );
});

test('two names rewriting to one label leave it unused, symmetrically', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'a_b', 'one');
  makeBareRepo(root, 'a.b', 'two');
  assert.equal(collectionSiteAlias(root, 'a_b'), null);
  assert.equal(collectionSiteAlias(root, 'a.b'), null);
  assert.equal(collectionForSiteAlias(root, 'a-b'), null);
  const rows = collectionSiteAliases(root);
  assert.deepEqual(
    rows.map((r) => [r.collection, r.alias, r.taken]),
    [
      ['a_b', null, 'a-b'],
      ['a.b', null, 'a-b'],
    ]
  );
  // Storing one breaks the tie, and the other keeps nothing it did not have.
  setCollectionAlias(root, 'a_b', 'a-b');
  assert.equal(collectionSiteAlias(root, 'a_b'), 'a-b');
  assert.equal(collectionForSiteAlias(root, 'a-b'), 'a_b');
  assert.equal(collectionSiteAlias(root, 'a.b'), null);
});

test('a stored alias overrides the name, round-trips, and is cleared with the empty string', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'webapp');
  setCollectionAlias(root, 'alice', 'ali');
  assert.equal(storedCollectionAlias(root, 'alice'), 'ali');
  assert.equal(collectionSiteAlias(root, 'alice'), 'ali');
  assert.equal(collectionForSiteAlias(root, 'ali'), 'alice');
  assert.equal(collectionForSiteAlias(root, 'alice'), null, 'the name it no longer answers to');
  assert.equal(siteHostFor(root, 'v-sites.example.org', 'alice', 'webapp'), 'webapp--ali.v-sites.example.org');
  setCollectionAlias(root, 'alice', '');
  assert.equal(storedCollectionAlias(root, 'alice'), '');
  assert.equal(collectionSiteAlias(root, 'alice'), 'alice');
  assert.ok(!fs.existsSync(path.join(root, 'collections', 'alice', COLLECTION_SITE_FILE)));
});

test('an alias conflicts with every tier, and never with the collection storing it', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'webapp');
  makeBareRepo(root, 'bob', 'notes');
  makeBareRepo(root, 'sim_1', 'one');
  assert.equal(collectionAliasConflict(root, 'alice', 'bob'), 'alice', 'a name held at tier 2');
  assert.equal(collectionAliasConflict(root, 'sim-1', 'bob'), 'sim_1', 'a rewritten name held at tier 3');
  assert.equal(collectionAliasConflict(root, 'free', 'bob'), null);
  setCollectionAlias(root, 'bob', 'notes-site');
  assert.equal(collectionAliasConflict(root, 'notes-site', 'alice'), 'bob', 'a stored alias');
  assert.equal(collectionAliasConflict(root, 'notes-site', 'bob'), null, 'the holder itself');
});

test('an alias is a single label with no doubled hyphen, and an unreadable one stores nothing', () => {
  assert.ok(isUsableCollectionAlias('simulated-instruments'));
  assert.ok(!isUsableCollectionAlias('a--b'), 'it would break the <repo>--<alias> grammar');
  assert.ok(!isUsableCollectionAlias('Sim'));
  assert.ok(!isUsableCollectionAlias(''));
  assert.ok(isUsableCollectionAlias('www'), 'reserving names is about the labels a repository claims');
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'webapp');
  const file = path.join(root, 'collections', 'alice', COLLECTION_SITE_FILE);
  fs.writeFileSync(file, JSON.stringify({ alias: 'Not_A_Label' }));
  assert.equal(storedCollectionAlias(root, 'alice'), '');
  assert.equal(collectionSiteAlias(root, 'alice'), 'alice', 'the tiers below still answer');
  fs.writeFileSync(file, 'not json at all');
  assert.equal(storedCollectionAlias(root, 'alice'), '');
});

test('a repository name that is not a label has no derived hostname, alias or not', () => {
  const root = makeVaultDir();
  makeBareRepo(root, 'alice', 'My_App');
  assert.equal(siteHostFor(root, 'v-sites.example.org', 'alice', 'My_App'), null);
  assert.equal(siteHostFor(root, '', 'alice', 'webapp'), null, 'no sites host, no hostname');
});
