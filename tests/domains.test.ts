import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import {
  clearRepoDomain,
  domainRepoFor,
  domainsFilePath,
  dropCollectionDomains,
  isSiteRequest,
  loadDomains,
  moveCollectionDomains,
  moveRepoDomains,
  repoDomain,
  setRepoDomain,
} from '../src/domains';
import { makeVaultDir } from './helpers';

test('a vault with no domains.json maps nothing and is not a site request', () => {
  const root = makeVaultDir();
  assert.deepEqual(loadDomains(root), {});
  assert.equal(domainRepoFor(root, 'docs.example.org'), null);
  assert.equal(isSiteRequest(root, 'docs.example.org'), false);
});

test('setRepoDomain attaches, replaces, and refuses what it should', () => {
  const root = makeVaultDir();
  assert.equal(setRepoDomain(root, 'alice', 'webapp', 'Docs.Example.Org.'), null);
  assert.deepEqual(domainRepoFor(root, 'docs.example.org'), { collection: 'alice', repo: 'webapp' });
  assert.equal(repoDomain(root, 'alice', 'webapp'), 'docs.example.org');
  assert.ok(isSiteRequest(root, 'docs.example.org'));
  // One domain per repository: a second attach replaces the first.
  assert.equal(setRepoDomain(root, 'alice', 'webapp', 'www.example.org'), null);
  assert.equal(domainRepoFor(root, 'docs.example.org'), null);
  assert.equal(repoDomain(root, 'alice', 'webapp'), 'www.example.org');
  // A domain another repository holds is a conflict, not a takeover.
  const taken = setRepoDomain(root, 'bob', 'other', 'www.example.org');
  assert.equal(taken?.kind, 'conflict');
  assert.match(taken?.message ?? '', /alice\/webapp/);
  // A value that is not a hostname is invalid.
  assert.equal(setRepoDomain(root, 'alice', 'webapp', 'not a host')?.kind, 'invalid');
  assert.equal(setRepoDomain(root, 'alice', 'webapp', 'single-label')?.kind, 'invalid');
});

test('clearRepoDomain detaches, and an empty map removes the file', () => {
  const root = makeVaultDir();
  setRepoDomain(root, 'alice', 'webapp', 'docs.example.org');
  clearRepoDomain(root, 'alice', 'webapp');
  assert.equal(repoDomain(root, 'alice', 'webapp'), null);
  assert.ok(!fs.existsSync(domainsFilePath(root)));
});

test('domains follow renames and are dropped with deletions', () => {
  const root = makeVaultDir();
  setRepoDomain(root, 'alice', 'webapp', 'docs.example.org');
  moveRepoDomains(root, 'alice', 'webapp', 'team', 'site');
  assert.deepEqual(domainRepoFor(root, 'docs.example.org'), { collection: 'team', repo: 'site' });
  moveCollectionDomains(root, 'team', 'group');
  assert.deepEqual(domainRepoFor(root, 'docs.example.org'), { collection: 'group', repo: 'site' });
  dropCollectionDomains(root, 'group');
  assert.equal(domainRepoFor(root, 'docs.example.org'), null);
});

test('an unreadable or hand-mangled domains.json maps only what it can prove', () => {
  const root = makeVaultDir();
  fs.writeFileSync(
    domainsFilePath(root),
    JSON.stringify({
      domains: {
        'ok.example.org': 'alice/webapp',
        'bad-target.example.org': 'no-slash',
        'not a hostname': 'alice/webapp',
      },
    })
  );
  assert.deepEqual(loadDomains(root), { 'ok.example.org': 'alice/webapp' });
  fs.writeFileSync(domainsFilePath(root), 'not json { at all');
  assert.deepEqual(loadDomains(root), {});
});
