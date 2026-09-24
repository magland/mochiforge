import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import { makeVaultDir } from './helpers';
import { createApp } from '../src/server';
import { GitRepo } from '../src/git';
import { editSiteSettings, isUsableSitePath, normalizeSitePath, siteSettings } from '../src/sitesettings';
import { SitePublishError, publishSiteFromRepository, siteFollowsRef } from '../src/sitepublish';
import { addUserToken } from '../src/vault';

// A site published from the repository: the server writes <repo>.site from
// the default branch's tree, on every push that moves the branch and whenever
// the settings say so. Driven against a real bare repository, and once over
// real HTTP so that the push path is the one exercised.

let server: Server;
let root: string;
let base: string;
let token: string;
let repoDir: string;
let siteDir: string;
let work: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function commitAll(message: string): void {
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', message);
}

function listSite(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(siteDir)) walk(siteDir, '');
  return out;
}

before(async () => {
  root = makeVaultDir();
  token = addUserToken(root, 'owner', { siteAdmin: true }).token;
  repoDir = path.join(root, 'collections', 'demo', 'repos', 'site.git');
  siteDir = path.join(root, 'collections', 'demo', 'repos', 'site.site');
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
  // Outside the vault: the server treats what it finds under root as its own.
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sitepublish-work-'));
  execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'ignore' });
  fs.writeFileSync(path.join(work, 'index.html'), '<h1>root</h1>\n');
  fs.mkdirSync(path.join(work, 'docs'));
  fs.writeFileSync(path.join(work, 'docs', 'index.html'), '<h1>docs</h1>\n');
  fs.writeFileSync(path.join(work, 'docs', 'style.css'), 'h1 {}\n');
  fs.writeFileSync(path.join(work, 'notes.txt'), 'kept out of the site\n');
  fs.writeFileSync(path.join(work, '.gitattributes'), 'notes.txt export-ignore\n');
  // A symlink that resolves outside the tree, which the publish must drop.
  fs.symlinkSync('/etc/hostname', path.join(work, 'escape'));
  commitAll('first');
  git(work, 'push', '-q', repoDir, 'main');

  const app = createApp(root);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('the site path grammar', () => {
  it('accepts the root and relative directories, and refuses what git could misread', () => {
    assert.ok(isUsableSitePath(''));
    assert.ok(isUsableSitePath('docs'));
    assert.ok(isUsableSitePath('build/site'));
    assert.ok(isUsableSitePath('_site'));
    assert.ok(!isUsableSitePath('..'));
    assert.ok(!isUsableSitePath('docs/../secret'));
    assert.ok(!isUsableSitePath('/docs'));
    assert.ok(!isUsableSitePath('.git'));
    assert.ok(!isUsableSitePath('-o'));
    assert.ok(!isUsableSitePath('docs:main'));
    assert.equal(normalizeSitePath(' /docs/ '), 'docs');
    assert.equal(normalizeSitePath('a//b'), 'a/b');
  });

  it('is what site.json normalization keeps, with the repository source', () => {
    editSiteSettings(repoDir, (s) => {
      s.source = 'repository';
      s.path = 'docs';
    });
    assert.deepEqual(siteSettings(repoDir), { enabled: false, source: 'repository', label: '', path: 'docs' });
    fs.writeFileSync(path.join(repoDir, 'site.json'), JSON.stringify({ enabled: true, source: 'repository', path: '../x' }));
    assert.deepEqual(siteSettings(repoDir), { enabled: true, source: 'repository', label: '', path: '' });
  });
});

describe('publishing from the repository', () => {
  it('does nothing unless the site is enabled with the repository source', async () => {
    const repo = new GitRepo(repoDir, 'demo', 'site');
    editSiteSettings(repoDir, (s) => {
      s.enabled = true;
      s.source = 'copy';
      s.path = '';
    });
    assert.equal(await publishSiteFromRepository(root, repo), null);
    assert.equal(await siteFollowsRef(repo, 'refs/heads/main'), false);
    editSiteSettings(repoDir, (s) => {
      s.enabled = false;
      s.source = 'repository';
    });
    assert.equal(await publishSiteFromRepository(root, repo), null);
    assert.equal(fs.existsSync(siteDir), false);
  });

  it('writes the default branch tree, honouring export-ignore and dropping escaping symlinks', async () => {
    const repo = new GitRepo(repoDir, 'demo', 'site');
    editSiteSettings(repoDir, (s) => {
      s.enabled = true;
      s.source = 'repository';
    });
    assert.equal(await siteFollowsRef(repo, 'refs/heads/main'), true);
    assert.equal(await siteFollowsRef(repo, 'refs/heads/other'), false);
    const result = await publishSiteFromRepository(root, repo);
    assert.deepEqual(result, { files: 4 });
    assert.deepEqual(listSite(), ['.gitattributes', 'docs/index.html', 'docs/style.css', 'index.html']);
    assert.equal(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), '<h1>root</h1>\n');
  });

  it('publishes a directory within the tree when a path is set', async () => {
    const repo = new GitRepo(repoDir, 'demo', 'site');
    editSiteSettings(repoDir, (s) => {
      s.path = 'docs';
    });
    assert.deepEqual(await publishSiteFromRepository(root, repo), { files: 2 });
    assert.deepEqual(listSite(), ['index.html', 'style.css']);
    assert.equal(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), '<h1>docs</h1>\n');
  });

  it('refuses a directory the branch does not have, and keeps the previous site', async () => {
    const repo = new GitRepo(repoDir, 'demo', 'site');
    editSiteSettings(repoDir, (s) => {
      s.path = 'missing';
    });
    await assert.rejects(publishSiteFromRepository(root, repo), SitePublishError);
    assert.deepEqual(listSite(), ['index.html', 'style.css'], 'the previous site stays in place');
    editSiteSettings(repoDir, (s) => {
      s.path = '';
    });
  });
});

describe('over HTTP', () => {
  // A commit made through the API is a push as far as the site is concerned:
  // it goes through the same trigger a git push does (src/ci/trigger.ts).
  // git-over-HTTP itself is not driven here, since the smoke tests cover it.
  async function commitViaApi(branch: string, content: string): Promise<Response> {
    return fetch(`${base}/api/repos/demo/site/commits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ branch, message: `set ${branch}`, files: [{ path: 'index.html', content }] }),
    });
  }
  async function siteIndexEventually(expected: string): Promise<string> {
    let text = '';
    for (let i = 0; i < 50; i++) {
      text = fs.existsSync(path.join(siteDir, 'index.html')) ? fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8') : '';
      if (text === expected) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return text;
  }

  it('republishes the site when a commit moves the default branch, and not for another branch', async () => {
    const res = await commitViaApi('main', '<h1>second</h1>\n');
    assert.equal(res.status, 200, await res.text());
    assert.equal(await siteIndexEventually('<h1>second</h1>\n'), '<h1>second</h1>\n');

    const branch = await fetch(`${base}/api/repos/demo/site/branches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'topic', from: 'main' }),
    });
    assert.ok(branch.status === 200 || branch.status === 201, await branch.text());
    const topic = await commitViaApi('topic', '<h1>topic</h1>\n');
    assert.equal(topic.status, 200, await topic.text());
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), '<h1>second</h1>\n', 'another branch does not publish');
  });

  it('is reported by the repository read and rewritten by a settings change', async () => {
    const view = await fetch(`${base}/api/repos/demo/site`, { headers: { authorization: `Bearer ${token}` } });
    const data = (await view.json()) as { site: { source: string; path: string } };
    assert.equal(data.site.source, 'repository');
    assert.equal(data.site.path, '');

    const patch = await fetch(`${base}/api/repos/demo/site`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sitePath: 'docs' }),
    });
    assert.equal(patch.status, 200);
    const body = (await patch.json()) as { site: { path: string }; sitePublish: { files?: number } };
    assert.equal(body.site.path, 'docs');
    assert.deepEqual(body.sitePublish, { files: 2 });
    assert.equal(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), '<h1>docs</h1>\n');

    const bad = await fetch(`${base}/api/repos/demo/site`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sitePath: '../etc' }),
    });
    assert.equal(bad.status, 400);
    const badSource = await fetch(`${base}/api/repos/demo/site`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ siteSource: 'branch' }),
    });
    assert.equal(badSource.status, 400);
  });
});
