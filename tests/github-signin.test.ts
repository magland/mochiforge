import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { Server } from 'http';
import { makeVaultDir } from './helpers';
import { createApp } from '../src/server';
import { addUserToken, authForBinding, githubBinding, loadVault } from '../src/vault';
import { overrideGithubEndpointsForTests, writeGithubSecret } from '../src/githubauth';

// Sign-in with GitHub, driven over real HTTP against a real vault directory
// and a stub standing in for github.com. What these assert is the wiring --
// the state parameter is one-use, approval gates provisioning, linking binds
// the id to the right user, sessions come out bound to gh:<id> and die with
// the link -- not GitHub's side of the protocol, which the stub plays
// straight.

let server: Server;
let github: Server;
let root: string;
let base: string;
let ownerToken: string;

// The accounts the stub GitHub knows. A callback code of `code-<login>`
// exchanges for a token that /user answers with that login's account.
const DIRECTORY: Record<string, { id: number; login: string }> = {
  alice: { id: 101, login: 'alice' },
  bob: { id: 202, login: 'bob' },
  carol: { id: 303, login: 'carol' },
};

function stubGithub(): Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const code = form.get('code') ?? '';
        const ok =
          form.get('client_id') === 'test-client' &&
          form.get('client_secret') === 'test-secret' &&
          code.startsWith('code-');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(ok ? { access_token: `tok-${code.slice('code-'.length)}` } : {}));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/user') {
      const auth = req.headers.authorization ?? '';
      const login = auth.startsWith('Bearer tok-') ? auth.slice('Bearer tok-'.length) : '';
      const account = DIRECTORY[login];
      res.setHeader('content-type', 'application/json');
      if (!account) {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      res.end(JSON.stringify(account));
      return;
    }
    const m = url.pathname.match(/^\/users\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const account = DIRECTORY[m[1]];
      res.setHeader('content-type', 'application/json');
      if (!account) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.end(JSON.stringify(account));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

before(async () => {
  root = makeVaultDir();
  ownerToken = addUserToken(root, 'owner', { siteAdmin: true }).token;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ auth: { githubClientId: 'test-client' } }));
  writeGithubSecret(root, 'test-secret');

  github = stubGithub();
  github.listen(0, '127.0.0.1');
  await new Promise((resolve) => github.once('listening', resolve));
  const ghAddr = github.address();
  if (ghAddr === null || typeof ghAddr === 'string') throw new Error('no stub port');
  const stubBase = `http://127.0.0.1:${ghAddr.port}`;
  overrideGithubEndpointsForTests({
    authorize: `${stubBase}/authorize`,
    token: `${stubBase}/token`,
    api: stubBase,
  });

  const app = createApp(root);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  github.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie');
  assert.ok(raw, 'expected a Set-Cookie');
  return raw.split(';')[0];
}

async function signInWithToken(): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'owner', token: ownerToken, next: '/' }),
  });
  assert.equal(res.status, 302);
  return cookieOf(res);
}

async function csrfFrom(pagePath: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}${pagePath}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const m = (await res.text()).match(/name="csrf" value="([^"]+)"/);
  assert.ok(m, `no csrf field on ${pagePath}`);
  return m[1];
}

async function postForm(pathName: string, body: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
  });
}

/** The state parameter the vault put in its redirect to (the stub) GitHub. */
function stateOf(res: Response): string {
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location, 'expected a redirect to GitHub');
  const u = new URL(location);
  assert.equal(u.pathname, '/authorize');
  assert.equal(u.searchParams.get('client_id'), 'test-client');
  const state = u.searchParams.get('state');
  assert.ok(state, 'the authorize URL carries a state');
  return state;
}

async function callback(code: string, state: string, cookie?: string): Promise<Response> {
  return fetch(`${base}/login/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

describe('sign-in with GitHub over HTTP', () => {
  it('the admin page saves the OAuth App credentials', async () => {
    // The vault starts this suite already configured (the files are written
    // in before()); saving the same values through the page must land on the
    // admin route rather than fall through to the repository-settings route,
    // and must leave the vault configured.
    const cookie = await signInWithToken();
    const csrf = await csrfFrom('/admin/github', cookie);
    const res = await postForm('/admin/github', { csrf, clientId: 'test-client', clientSecret: 'test-secret' }, cookie);
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/admin\/github\?msg=/);
    assert.equal(fs.readFileSync(path.join(root, '.github-secret'), 'utf8').trim(), 'test-secret');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(config.auth.githubClientId, 'test-client');
  });

  it('the sign-in page offers GitHub when it is configured', async () => {
    const res = await fetch(`${base}/login`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Sign in with GitHub/);
    // The CSP must allow the link form's redirect to GitHub's authorize page:
    // browsers apply form-action to redirects that follow a submission.
    assert.match(res.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/github\.com/);
  });

  it('an admin approves a GitHub account by username, resolved to its id', async () => {
    const cookie = await signInWithToken();
    const csrf = await csrfFrom('/admin/github', cookie);
    const res = await postForm('/admin/github/approve', { csrf, login: 'alice' }, cookie);
    assert.equal(res.status, 302);
    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    assert.deepEqual(
      state.vault.githubApproved?.map((a) => ({ id: a.id, login: a.login })),
      [{ id: 101, login: 'alice' }]
    );
  });

  it('an approved account signs in and is given an account, once', async () => {
    const start = await fetch(`${base}/login/github?next=/account`, { redirect: 'manual' });
    const redeemed = await callback('code-alice', stateOf(start));
    assert.equal(redeemed.status, 302);
    assert.equal(redeemed.headers.get('location'), '/account');
    const cookie = cookieOf(redeemed);

    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    const alice = state.vault.users.alice;
    assert.ok(alice, 'first sign-in created the account');
    assert.equal(alice.github?.id, 101);
    assert.equal(alice.tokens.length, 0);

    const account = await fetch(`${base}/account`, { headers: { cookie } });
    assert.equal(account.status, 200);
    assert.match(await account.text(), /alice/);

    // A second sign-in lands on the same account rather than minting alice-2.
    const again = await fetch(`${base}/login/github?next=/`, { redirect: 'manual' });
    const redeemedAgain = await callback('code-alice', stateOf(again));
    assert.equal(redeemedAgain.status, 302);
    const after = loadVault(root);
    assert.ok(after.status === 'ok');
    assert.equal(after.vault.users['alice-2'], undefined);
  });

  it('the state parameter is one-use', async () => {
    const start = await fetch(`${base}/login/github?next=/`, { redirect: 'manual' });
    const state = stateOf(start);
    assert.equal((await callback('code-alice', state)).status, 302);
    assert.equal((await callback('code-alice', state)).status, 400);
  });

  it('an unapproved account is refused and no account is created', async () => {
    const start = await fetch(`${base}/login/github?next=/`, { redirect: 'manual' });
    const redeemed = await callback('code-bob', stateOf(start));
    assert.equal(redeemed.status, 403);
    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    assert.equal(state.vault.users.bob, undefined);
  });

  it('a user links their GitHub account, signs in with it, and unlinks it', async () => {
    const cookie = await signInWithToken();
    const csrf = await csrfFrom('/account', cookie);
    const start = await postForm('/account/github', { csrf }, cookie);
    const linked = await callback('code-carol', stateOf(start), cookie);
    assert.equal(linked.status, 302);
    assert.match(linked.headers.get('location') ?? '', /^\/account\?msg=/);
    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    assert.equal(state.vault.users.owner.github?.id, 303);

    // From a browser with no session: carol, though never approved, signs in
    // as owner because the id is linked.
    const fresh = await fetch(`${base}/login/github?next=/account`, { redirect: 'manual' });
    const redeemed = await callback('code-carol', stateOf(fresh));
    assert.equal(redeemed.status, 302);
    const ghCookie = cookieOf(redeemed);
    const account = await fetch(`${base}/account`, { headers: { cookie: ghCookie } });
    assert.equal(account.status, 200);
    assert.match(await account.text(), /owner/);

    // Unlinking from a token session ends the GitHub-bound session.
    const unlinked = await postForm('/account/github/unlink', { csrf }, cookie);
    assert.equal(unlinked.status, 302);
    const after = loadVault(root);
    assert.ok(after.status === 'ok');
    assert.equal(after.vault.users.owner.github, undefined);
    assert.equal(authForBinding(after.vault, 'owner', githubBinding(303)), null);
    const dead = await fetch(`${base}/account`, { redirect: 'manual', headers: { cookie: ghCookie } });
    assert.notEqual(dead.status, 200);
  });

  it('refuses to unlink an account whose GitHub link is its only credential', async () => {
    const start = await fetch(`${base}/login/github?next=/account`, { redirect: 'manual' });
    const redeemed = await callback('code-alice', stateOf(start));
    const cookie = cookieOf(redeemed);
    const csrf = await csrfFrom('/account', cookie);
    const refused = await postForm('/account/github/unlink', { csrf }, cookie);
    assert.equal(refused.status, 409);
    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    assert.equal(state.vault.users.alice.github?.id, 101);
  });

  it('removing an approval stops provisioning but not a linked account', async () => {
    const cookie = await signInWithToken();
    const csrf = await csrfFrom('/admin/github', cookie);
    const removed = await postForm('/admin/github/approved/101/remove', { csrf }, cookie);
    assert.equal(removed.status, 302);
    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    assert.equal(state.vault.githubApproved, undefined);

    // alice's account is linked, so she still signs in.
    const start = await fetch(`${base}/login/github?next=/`, { redirect: 'manual' });
    const redeemed = await callback('code-alice', stateOf(start));
    assert.equal(redeemed.status, 302);
    assert.ok(redeemed.headers.get('set-cookie'));
  });

  it('the admin unlinks from the user page', async () => {
    const cookie = await signInWithToken();
    const csrf = await csrfFrom('/admin/users/alice', cookie);
    const res = await postForm('/admin/users/alice/github/unlink', { csrf }, cookie);
    assert.equal(res.status, 302);
    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    assert.equal(state.vault.users.alice.github, undefined);
  });
});
