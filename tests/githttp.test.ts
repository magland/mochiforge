import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Server } from 'http';
import { makeVaultDir } from './helpers';
import { createApp } from '../src/server';
import { ROOT_FILES } from '../src/api/backup';
import { addUserToken } from '../src/vault';

// Hostile input on the two routes that hand a request to git: the smart-HTTP
// RPC, which pipes the body into a git process, and the API commit route, which
// puts a path segment into git's argument list. Each once let the wrong thing
// through -- a body declared gzip that was not gzip took the process down with
// an unhandled stream error, and a "commit id" of `--output=<path>` had git
// write its listing into the vault -- so each is driven over real HTTP against
// a real repository here.

let server: Server;
let root: string;
let base: string;
let token: string;
let repoDir: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

before(async () => {
  root = makeVaultDir();
  token = addUserToken(root, 'owner', { siteAdmin: true }).token;
  repoDir = path.join(root, 'collections', 'demo', 'repos', 'proj.git');
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  execFileSync('git', ['init', '-q', '-b', 'main', work], { stdio: 'ignore' });
  fs.writeFileSync(path.join(work, 'README.md'), 'hello\n');
  git(work, 'add', 'README.md');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first');
  git(work, 'push', '-q', repoDir, 'main');
  fs.rmSync(work, { recursive: true, force: true });

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
});

describe('the git RPC route', () => {
  it('survives a body declared gzip that is not gzip, and still answers afterwards', async () => {
    const res = await fetch(`${base}/demo/proj/git-upload-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request', 'content-encoding': 'gzip' },
      body: 'this is not a gzip stream',
    });
    // git got no usable input and exited; what the client sees is an ended
    // response, not a hung one. What matters is the next line.
    await res.arrayBuffer();
    const again = await fetch(`${base}/demo/proj/info/refs?service=git-upload-pack`);
    assert.equal(again.status, 200);
    assert.match(await again.text(), /refs\/heads\/main/);
  });
});

describe('the API commit route', () => {
  it('refuses a commit id that is not one, before git sees it', async () => {
    const target = path.join(repoDir, 'pwned');
    const res = await fetch(`${base}/api/repos/demo/proj/commits/${encodeURIComponent('--output=pwned')}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
    assert.equal(fs.existsSync(target), false, 'git must not have been handed --output');
    const patch = await fetch(`${base}/api/repos/demo/proj/commits/${encodeURIComponent('--output=pwned')}/patch`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(patch.status, 404);
    assert.equal(fs.existsSync(target), false);
  });

  it('still answers for a real commit, abbreviated or not', async () => {
    const sha = git(repoDir, 'rev-parse', 'main').trim();
    for (const id of [sha, sha.slice(0, 8)]) {
      const res = await fetch(`${base}/api/repos/demo/proj/commits/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { sha: string };
      assert.equal(body.sha, sha);
    }
  });
});

describe('the backup manifest', () => {
  it('names every file the server writes at the vault root', () => {
    // The server above has bootstrapped a vault, served requests, and minted
    // its session secret. Whatever it left at the root is what a backup has
    // to carry; a new state file that is not in ROOT_FILES is a file a
    // restore would silently lack.
    const onDisk = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && !/\.tmp-\d+$/.test(e.name) && !e.name.endsWith('.lock'))
      .map((e) => e.name);
    assert.ok(onDisk.includes('vault.json'));
    for (const name of onDisk) {
      assert.ok(ROOT_FILES.includes(name), `${name} is written at the vault root but not backed up`);
    }
  });
});
