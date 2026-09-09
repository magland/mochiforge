import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobSpec } from '../src/ci/protocol';
import { JobClient } from '../src/runner/client';

// A cancel that arrives while a step is running cannot wait for the step
// loop to notice it, since the step may never end. The client tells whoever
// asked, once, the first time a heartbeat says the job should stop, and the
// job runner uses that to remove the container.

const spec = {
  address: { collection: 'alice', repo: 'demo', run: 3, job: 'build' },
  lease: 'lease-1',
} as unknown as JobSpec;

/** Runs `body` with fetch answering every request the given way. */
async function withFetch(answer: () => Response, body: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => answer()) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

const heartbeat = (client: JobClient) => (client as unknown as { heartbeat: () => Promise<void> }).heartbeat();

test('a heartbeat answering cancel fires the listener once and sets the flag', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ cancel: true }), { status: 200 }),
    async () => {
      const client = new JobClient({ host: 'http://v', token: 't' }, spec);
      let fired = 0;
      client.onCancel(() => fired++);
      assert.equal(client.cancelled(), false);
      await heartbeat(client);
      await heartbeat(client);
      assert.equal(client.cancelled(), true);
      assert.equal(fired, 1, 'a second heartbeat saying the same thing does not fire it again');
    }
  );
});

test('the server taking the job back (409) counts as a cancel', async () => {
  await withFetch(
    () => new Response('gone', { status: 409 }),
    async () => {
      const client = new JobClient({ host: 'http://v', token: 't' }, spec);
      let fired = 0;
      client.onCancel(() => fired++);
      await heartbeat(client);
      assert.equal(client.cancelled(), true);
      assert.equal(fired, 1);
    }
  );
});

test('a heartbeat that says nothing, or fails, leaves the job running', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ cancel: false }), { status: 200 }),
    async () => {
      const client = new JobClient({ host: 'http://v', token: 't' }, spec);
      let fired = 0;
      client.onCancel(() => fired++);
      await heartbeat(client);
      assert.equal(client.cancelled(), false);
      assert.equal(fired, 0);
    }
  );
  await withFetch(
    () => {
      throw new Error('connection refused');
    },
    async () => {
      const client = new JobClient({ host: 'http://v', token: 't' }, spec);
      let fired = 0;
      client.onCancel(() => fired++);
      await heartbeat(client);
      assert.equal(client.cancelled(), false, 'a transient failure is not a cancellation');
      assert.equal(fired, 0);
    }
  );
});

test('a listener registered after the cancel was seen fires at once', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ cancel: true }), { status: 200 }),
    async () => {
      const client = new JobClient({ host: 'http://v', token: 't' }, spec);
      await heartbeat(client);
      let fired = 0;
      client.onCancel(() => fired++);
      assert.equal(fired, 1, 'the container had not started when the cancel came; it still has to go');
    }
  );
});
