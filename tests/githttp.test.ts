import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Server } from 'http';
import { makeVaultDir } from './helpers';
import { createApp } from '../src/server';
import { ROOT_FILES } from '../src/api/backup';
import { setRepoPrivate } from '../src/perms';
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
let bobToken: string;
let repoDir: string;
let bigBytes: Buffer;
// Over the threshold above which raw files are streamed rather than buffered.
const BIG_SIZE = 9 * 1024 * 1024;

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
  // A file too large to be read into memory by any route: the raw routes
  // stream it and the contents route refuses it from its size alone.
  bigBytes = Buffer.alloc(BIG_SIZE);
  for (let i = 0; i < BIG_SIZE; i += 4096) bigBytes.writeUInt32LE(i, i);
  fs.writeFileSync(path.join(work, 'big.bin'), bigBytes);
  git(work, 'add', 'big.bin');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'big');
  git(work, 'push', '-q', repoDir, 'main');
  fs.rmSync(work, { recursive: true, force: true });
  // A private repository in the same collection, and a user with no role
  // anywhere in it.
  const secret = path.join(root, 'collections', 'demo', 'repos', 'secret.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', secret], { stdio: 'ignore' });
  setRepoPrivate(secret, true);
  bobToken = addUserToken(root, 'bob').token;

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

// A private repository must look exactly like an absent one to anybody who
// cannot read it, on every surface. The push path and the site routes each
// once answered the two cases differently, in status or in wording, which
// let a collection's private names be listed by guessing them.
describe('a private repository and an absent one', () => {
  const basic = (t: string) => `Basic ${Buffer.from(`bob:${t}`).toString('base64')}`;

  it('are refused alike on the push path, status and body', async () => {
    const ask = (name: string) =>
      fetch(`${base}/demo/${name}/info/refs?service=git-receive-pack`, {
        headers: { authorization: basic(bobToken) },
      });
    const [hidden, absent] = await Promise.all([ask('secret'), ask('nosuch')]);
    assert.equal(hidden.status, 404);
    assert.equal(absent.status, 404);
    assert.equal(await hidden.text(), await absent.text());
  });

  it('are refused alike on the site route, for a site that is not published', async () => {
    const [hidden, absent] = await Promise.all([fetch(`${base}/demo/secret/site/`), fetch(`${base}/demo/nosuch/site/`)]);
    assert.equal(hidden.status, 404);
    assert.equal(absent.status, 404);
    const strip = (s: string) => s.replace(/secret|nosuch/g, 'NAME');
    assert.equal(strip(await hidden.text()), strip(await absent.text()));
    // And the public one still says what is actually wrong.
    const open = await fetch(`${base}/demo/proj/site/`);
    assert.equal(open.status, 404);
    assert.match(await open.text(), /does not publish a site/);
  });
});

describe('a wake address on a runner', () => {
  it('takes a site admin, however the runner itself is owned', async () => {
    const res = await fetch(`${base}/api/runners`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'bobs',
        allow: ['bob/*'],
        wakeUrl: 'http://169.254.169.254/latest/meta-data/',
        wakeSecret: 's',
      }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /site admin/);
  });
});

describe('a large file', () => {
  it('is streamed from the raw routes, whole and with its length', async () => {
    for (const url of [`${base}/demo/proj/raw/main/big.bin`, `${base}/api/repos/demo/proj/raw/big.bin?ref=main`]) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200, url);
      assert.equal(res.headers.get('content-length'), String(BIG_SIZE));
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body.length, BIG_SIZE);
      assert.ok(body.equals(bigBytes), 'the bytes must be the file');
    }
  });

  it('is refused by the contents route from its size, and shown as a card by the web', async () => {
    const api = await fetch(`${base}/api/repos/demo/proj/contents/big.bin?ref=main`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(api.status, 413);
    const page = await fetch(`${base}/demo/proj/blob/main/big.bin`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /raw\/main\/big\.bin/);
    assert.ok(!html.includes('<td class="code"'), 'a file this size is not rendered as code');
  });

  it('under a branch revalidates by blob id and answers 304 to a matching ETag', async () => {
    const first = await fetch(`${base}/demo/proj/raw/main/big.bin`);
    await first.arrayBuffer();
    const etag = first.headers.get('etag');
    assert.ok(etag, 'an ETag is set under a branch');
    const again = await fetch(`${base}/demo/proj/raw/main/big.bin`, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
  });
});

describe('a sign-in form posted from another site', () => {
  it('is refused by its Origin, while one with no Origin is judged on its credential', async () => {
    const body = new URLSearchParams({ username: 'owner', token: 'wrong' });
    const cross = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body,
      redirect: 'manual',
    });
    assert.equal(cross.status, 403);
    const plain = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    assert.equal(plain.status, 401);
    const own = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ username: 'owner', token }),
      redirect: 'manual',
    });
    assert.equal(own.status, 302);
    assert.ok(own.headers.get('set-cookie'), 'a same-origin post signs in');
  });
});
