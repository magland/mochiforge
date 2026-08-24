import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Server } from 'http';
import { makeVaultDir } from './helpers';
import { createApp } from '../src/server';
import { addUserToken, authForBinding, loadVault, passkeyBinding } from '../src/vault';
import { getSecret } from '../src/session';
import { COSE_ES256 } from '../src/webauthn';

// The three sign-in flows, driven over real HTTP against a real vault
// directory: a passkey registered and then used (with a synthetic
// authenticator; see webauthn.test.ts for the byte-level cases), a handoff
// code typed on a "second device", and a `mochi web` login link redeemed
// with a click. What these assert is the wiring -- challenges are one-use,
// sessions come out bound to the right credential, refusals refuse -- not
// the cryptography, which has its own file.

let server: Server;
let root: string;
let base: string;
let host: string;
let ownerToken: string;

before(async () => {
  root = makeVaultDir();
  ownerToken = addUserToken(root, 'owner', { siteAdmin: true }).token;
  const app = createApp(root);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  host = `127.0.0.1:${addr.port}`;
  base = `http://${host}`;
});

after(() => {
  server.close();
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

// ---- the synthetic authenticator (ES256; the alg matrix is webauthn.test.ts's) ----

function cborUint(n: number, major: number): Buffer {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 256) return Buffer.from([m | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = m | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

function cborEncode(v: unknown): Buffer {
  if (typeof v === 'number' && Number.isInteger(v)) return v >= 0 ? cborUint(v, 0) : cborUint(-1 - v, 1);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborUint(v.length, 2), v]);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([cborUint(b.length, 3), b]);
  }
  if (v instanceof Map) {
    const parts: Buffer[] = [cborUint(v.size, 5)];
    for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
    return Buffer.concat(parts);
  }
  throw new Error('unsupported test CBOR value');
}

const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const credId = crypto.randomBytes(16);

function authenticatorRegistration(challenge: string): { clientDataJSON: string; attestationObject: string } {
  const jwk = keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = new Map<number, unknown>([
    [1, 2],
    [3, COSE_ES256],
    [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  const head = Buffer.alloc(37);
  crypto.createHash('sha256').update('127.0.0.1').digest().copy(head, 0);
  head[32] = 0x45;
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(credId.length);
  const authData = Buffer.concat([head, Buffer.alloc(16), idLen, credId, cborEncode(cose)]);
  const att = new Map<string, unknown>([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.create', challenge, origin: base, crossOrigin: false })
  );
  return {
    clientDataJSON: clientDataJSON.toString('base64url'),
    attestationObject: cborEncode(att).toString('base64url'),
  };
}

function authenticatorAssertion(challenge: string, counter: number) {
  const authData = Buffer.alloc(37);
  crypto.createHash('sha256').update('127.0.0.1').digest().copy(authData, 0);
  authData[32] = 0x05;
  authData.writeUInt32BE(counter, 33);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge, origin: base, crossOrigin: false })
  );
  const signature = crypto.sign(
    'sha256',
    Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]),
    keys.privateKey
  );
  return {
    id: credId.toString('base64url'),
    clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: authData.toString('base64url'),
    signature: signature.toString('base64url'),
    userHandle: Buffer.from('owner', 'utf8').toString('base64url'),
  };
}

async function postJson(pathName: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe('passkey sign-in over HTTP', () => {
  it('registers a passkey from the account page and signs in with it', async () => {
    const cookie = await signInWithToken();
    const csrf = await csrfFrom('/account', cookie);

    const challengeRes = await postJson('/account/passkeys/challenge', { csrf }, cookie);
    assert.equal(challengeRes.status, 200);
    const options = (await challengeRes.json()) as {
      challenge: string;
      rp: { id: string };
      user: { name: string };
    };
    assert.equal(options.rp.id, '127.0.0.1');
    assert.equal(options.user.name, 'owner');

    const reg = authenticatorRegistration(options.challenge);
    const stored = await postJson('/account/passkeys', { csrf, name: 'test key', ...reg }, cookie);
    assert.equal(stored.status, 200);

    // The challenge was consumed: replaying the same registration fails.
    const replay = await postJson('/account/passkeys', { csrf, name: 'again', ...reg }, cookie);
    assert.equal(replay.status, 400);

    const state = loadVault(root);
    assert.ok(state.status === 'ok' && state.vault.users.owner.passkeys?.length === 1);

    // Now sign in with it, from a browser holding no session at all.
    const loginChallenge = (await (await postJson('/login/passkey/challenge', {})).json()) as {
      challenge: string;
      rpId: string;
    };
    assert.equal(loginChallenge.rpId, '127.0.0.1');
    const assertRes = await postJson('/login/passkey', {
      next: '/account',
      ...authenticatorAssertion(loginChallenge.challenge, 1),
    });
    assert.equal(assertRes.status, 200);
    assert.equal(((await assertRes.json()) as { next: string }).next, '/account');
    const pkCookie = cookieOf(assertRes);

    // The session works, and is bound to the passkey, not to any token.
    const account = await fetch(`${base}/account`, { headers: { cookie: pkCookie } });
    assert.equal(account.status, 200);
    assert.match(await account.text(), /this session/);

    // A replayed login challenge is refused.
    const replayLogin = await postJson('/login/passkey', {
      next: '/',
      ...authenticatorAssertion(loginChallenge.challenge, 2),
    });
    assert.equal(replayLogin.status, 400);
  });

  it('a session bound to a removed passkey dies with it', async () => {
    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    const id = state.vault.users.owner.passkeys![0].id;
    assert.ok(authForBinding(state.vault, 'owner', passkeyBinding(id)));
    assert.equal(authForBinding(state.vault, 'owner', passkeyBinding('nope')), null);
    // The synthetic binding never resolves as a token hash.
    assert.equal(state.vault.users.owner.tokens.some((t) => t.hash === passkeyBinding(id)), false);
  });

  it('an admin removes the passkey from the user page', async () => {
    const state = loadVault(root);
    assert.ok(state.status === 'ok');
    const id = state.vault.users.owner.passkeys![0].id;
    const cookie = await signInWithToken();
    const csrf = await csrfFrom('/admin/users/owner', cookie);
    const removed = await fetch(`${base}/admin/users/owner/passkeys/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(removed.status, 302);
    const after = loadVault(root);
    assert.ok(after.status === 'ok' && !after.vault.users.owner.passkeys);
  });
});

describe('handoff codes over HTTP', () => {
  it('signs a second device in with a shown code, once', async () => {
    const cookie = await signInWithToken();
    const csrf = await csrfFrom('/account', cookie);
    const shown = await fetch(`${base}/account/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(shown.status, 200);
    const code = (await shown.text()).match(/class="handoff-code mono">([A-Z2-9-]+)</)?.[1];
    assert.ok(code, 'the page shows the code');

    const redeem = await fetch(`${base}/login/link`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: code.toLowerCase(), next: '/account' }),
    });
    assert.equal(redeem.status, 302);
    assert.equal(redeem.headers.get('location'), '/account');
    const second = cookieOf(redeem);
    assert.equal((await fetch(`${base}/account`, { headers: { cookie: second } })).status, 200);

    // Once.
    const again = await fetch(`${base}/login/link`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, next: '/' }),
    });
    assert.equal(again.status, 401);
  });
});

describe('mochi web login links over HTTP', () => {
  it('mints a link over the API, confirms, and signs in bound to the same token', async () => {
    const minted = await fetch(`${base}/api/login-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ next: '/account' }),
    });
    assert.equal(minted.status, 200);
    const link = (await minted.json()) as { url: string; username: string };
    assert.equal(link.username, 'owner');
    assert.ok(link.url.startsWith(base));

    // The landing page names the account and consumes nothing.
    const landing = await fetch(link.url);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Continue as owner/);

    const code = link.url.slice(link.url.lastIndexOf('/') + 1);
    const redeem = await fetch(`${base}/login/code`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code }),
    });
    assert.equal(redeem.status, 302);
    assert.equal(redeem.headers.get('location'), '/account');
    const cookie = cookieOf(redeem);
    assert.equal((await fetch(`${base}/account`, { headers: { cookie } })).status, 200);

    // Redeemed links die: the landing page and a second redeem both refuse.
    assert.equal((await fetch(link.url)).status, 404);
    const again = await fetch(`${base}/login/code`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code }),
    });
    assert.equal(again.status, 401);
  });

  it('refuses a link whose token was revoked in the meantime', async () => {
    const extra = addUserToken(root, 'owner', {});
    const minted = await fetch(`${base}/api/login-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${extra.token}` },
      body: JSON.stringify({}),
    });
    const link = (await minted.json()) as { url: string };
    // Revoke by editing vault.json the way an admin's revocation would.
    const file = path.join(root, 'vault.json');
    const vaultJson = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hash = crypto.createHash('sha256').update(extra.token).digest('hex');
    vaultJson.users.owner.tokens = vaultJson.users.owner.tokens.filter((t: { hash: string }) => t.hash !== hash);
    fs.writeFileSync(file, JSON.stringify(vaultJson));
    const code = link.url.slice(link.url.lastIndexOf('/') + 1);
    const redeem = await fetch(`${base}/login/code`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code }),
    });
    assert.equal(redeem.status, 403);
  });
});

describe('sliding session renewal', () => {
  // Re-sign a real session cookie with a different expiry, using the vault's
  // own secret: the payload is what the server minted, only `exp` changes.
  function withExp(cookie: string, exp: number): string {
    const eq = cookie.indexOf('=');
    const name = cookie.slice(0, eq);
    const value = cookie.slice(eq + 1);
    const dot = value.lastIndexOf('.');
    const payload = JSON.parse(Buffer.from(value.slice(0, dot), 'base64url').toString('utf8'));
    payload.exp = exp;
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', getSecret(root)).update(body).digest('base64url');
    return `${name}=${body}.${sig}`;
  }

  function payloadOf(setCookie: string): { u: string; exp: number; csrf: string; t: string } {
    const value = setCookie.slice(setCookie.indexOf('=') + 1);
    return JSON.parse(Buffer.from(value.slice(0, value.lastIndexOf('.')), 'base64url').toString('utf8'));
  }

  const DAY = 24 * 60 * 60 * 1000;

  it('re-issues a cookie seen in the second half of its life, keeping identity and csrf', async () => {
    const cookie = await signInWithToken();
    const before = payloadOf(cookie);
    const stale = withExp(cookie, Date.now() + 5 * DAY);
    const res = await fetch(`${base}/account`, { headers: { cookie: stale } });
    assert.equal(res.status, 200);
    const renewed = res.headers.get('set-cookie');
    assert.ok(renewed, 'expected a renewed session cookie');
    const after = payloadOf(renewed);
    assert.equal(after.u, before.u);
    assert.equal(after.csrf, before.csrf);
    assert.equal(after.t, before.t);
    assert.ok(after.exp > Date.now() + 29 * DAY, 'expiry pushed out to a full term');
  });

  it('leaves a cookie in the first half of its life alone', async () => {
    const cookie = await signInWithToken();
    const fresh = withExp(cookie, Date.now() + 29 * DAY);
    const res = await fetch(`${base}/account`, { headers: { cookie: fresh } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('does not renew a session whose token has been revoked', async () => {
    const extra = addUserToken(root, 'owner', {});
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'owner', token: extra.token, next: '/' }),
    });
    assert.equal(login.status, 302);
    const stale = withExp(cookieOf(login), Date.now() + 5 * DAY);
    const file = path.join(root, 'vault.json');
    const vaultJson = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hash = crypto.createHash('sha256').update(extra.token).digest('hex');
    vaultJson.users.owner.tokens = vaultJson.users.owner.tokens.filter((t: { hash: string }) => t.hash !== hash);
    fs.writeFileSync(file, JSON.stringify(vaultJson));
    const res = await fetch(`${base}/account`, { redirect: 'manual', headers: { cookie: stale } });
    assert.equal(res.headers.get('set-cookie'), null);
    assert.notEqual(res.status, 200);
  });
});
