import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import {
  SITE_SETTINGS_FILE,
  editSiteSettings,
  findRepoBySiteLabel,
  isUsableSiteLabel,
  siteLabelConflict,
  siteSettings,
} from '../src/sitesettings';
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
