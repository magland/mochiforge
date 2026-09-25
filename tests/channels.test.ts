import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../src/markdown';

// #channel names in rendered markdown. The opts.channels callback stands in
// for a chat's channel list: it answers where a channel the reader can see
// lives, or null, and only an answer becomes a link.

const OPTS = { rawBase: '', blobBase: '' };

const visible = new Set(['general', 'dango-feedback']);
const channels = (name: string) => (visible.has(name) ? `/c/${name}` : null);

test('a visible channel is linked and any other stays text', () => {
  const html = renderMarkdown('see #dango-feedback, not #secret', { ...OPTS, channels });
  assert.ok(html.includes('<a href="/c/dango-feedback">#dango-feedback</a>,'), html);
  assert.ok(!html.includes('href="/c/secret"'), html);
  assert.ok(html.includes('#secret'), html);
});

test('without the callback nothing is linked', () => {
  const html = renderMarkdown('see #general', OPTS);
  assert.ok(!html.includes('href="/c/general"'), html);
});

test('a trailing hyphen is peeled only while the name does not resolve', () => {
  const html = renderMarkdown('over in #general- for now', { ...OPTS, channels });
  assert.ok(html.includes('<a href="/c/general">#general</a>-'), html);
});

test('a # inside a word, in code, or in a link is left alone', () => {
  const url = renderMarkdown('https://example.org/page#general', { ...OPTS, channels });
  assert.ok(!url.includes('href="/c/general"'), url);
  const code = renderMarkdown('`#general`', { ...OPTS, channels });
  assert.ok(!code.includes('href="/c/general"'), code);
  const link = renderMarkdown('[see #general](https://example.org)', { ...OPTS, channels });
  assert.ok(!link.includes('href="/c/general"'), link);
  const heading = renderMarkdown('# general', { ...OPTS, channels });
  assert.ok(!heading.includes('href="/c/general"'), heading);
});
