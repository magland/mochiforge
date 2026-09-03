import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USER_CONTENT_PREFIX, renderMarkdown } from '../src/markdown';

// Hostile HTML in a document. The renderer's output is sanitized against an
// allowlist, and these pin down the two parts of it that guard the page around
// the document rather than the reader: a class an author wrote reaches the
// interface's own stylesheet, and an id an author wrote reaches the page
// script's lookups. Neither survives; the renderer's own classes and ids do.

const OPTS = {
  rawBase: '/demo/proj/raw/main',
  blobBase: '/demo/proj/blob/main',
  issueBase: '/demo/proj/issues',
  commitBase: '/demo/proj/commit',
};

test("an author's class is dropped, so a document cannot wear the interface's chrome", () => {
  const html = renderMarkdown(
    '<div class="topbar"><a class="btn" href="https://evil.example/login">Sign in</a></div>\n\nafter',
    OPTS
  );
  assert.ok(!html.includes('topbar'), html);
  assert.ok(!html.includes('class="btn"'), html);
  assert.ok(html.includes('Sign in'), 'the text itself is kept');
});

test('the classes the renderer emits are kept, where it emits them', () => {
  const alert = renderMarkdown('> [!NOTE]\n> careful', OPTS);
  assert.match(alert, /<blockquote class="alert alert-note">/);
  assert.match(alert, /<p class="alert-title">/);
  const code = renderMarkdown('```js\nlet x = 1;\n```', OPTS);
  assert.match(code, /<div class="code-block">/);
  assert.match(code, /<code class="language-js">/);
  const task = renderMarkdown('- [x] done\n- [ ] not yet', OPTS);
  assert.match(task, /<li class="task-item">/);
  // A renderer class on an element the renderer never puts it on is an
  // author's, and goes.
  const forged = renderMarkdown('<p class="code-block">x</p>\n\n<span class="alert">y</span>', OPTS);
  assert.ok(!forged.includes('code-block'), forged);
  assert.ok(!forged.includes('class="alert"'), forged);
});

test('ids carry the user-content prefix, and links within the document follow them', () => {
  const html = renderMarkdown('# Install\n\nSee [install](#install).\n\n<div id="jump">x</div>', OPTS);
  assert.match(html, new RegExp(`<h1 id="${USER_CONTENT_PREFIX}install">`));
  assert.match(html, new RegExp(`href="#${USER_CONTENT_PREFIX}install"`));
  assert.ok(!html.includes('id="jump"'), html);
  assert.ok(html.includes(`id="${USER_CONTENT_PREFIX}jump"`), html);
  // The heading's own anchor points at the prefixed id too.
  assert.match(html, new RegExp(`<a class="heading-anchor" href="#${USER_CONTENT_PREFIX}install"`));
});

test('a footnote still finds its note and its way back', () => {
  const html = renderMarkdown('text[^1]\n\n[^1]: the note', OPTS);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const hrefs = [...html.matchAll(/ href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2, html);
  for (const id of ids) assert.ok(id.startsWith(USER_CONTENT_PREFIX), id);
  for (const href of hrefs) assert.ok(ids.includes(href), `${href} should name an element in ${ids.join(', ')}`);
});

test('the sanitizer still refuses what it always refused', () => {
  const html = renderMarkdown(
    '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">j</a>' +
      '<a href="//evil.example/x">p</a><p style="position:fixed">s</p>',
    OPTS
  );
  assert.ok(!html.includes('<script'), html);
  assert.ok(!html.includes('onerror'), html);
  assert.ok(!html.includes('javascript:'), html);
  assert.ok(!html.includes('//evil.example'), html);
  assert.ok(!html.includes('style='), html);
});
