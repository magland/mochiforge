import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../src/markdown';

// Newlines inside a paragraph, which a document joins with a space and a chat
// (or a GitHub comment) keeps as line breaks. The option is per render, since
// the parser is shared, and off unless asked for.

const OPTS = { rawBase: '', blobBase: '' };
const breaks = { ...OPTS, breaks: true };

test('without the option a newline inside a paragraph is a space', () => {
  assert.equal(renderMarkdown('one\ntwo', OPTS).trim(), '<p>one\ntwo</p>');
});

test('with it, a newline inside a paragraph, a list item, or a quote is a line break', () => {
  assert.equal(renderMarkdown('one\ntwo\nthree', breaks).trim(), '<p>one<br />\ntwo<br />\nthree</p>');
  assert.match(renderMarkdown('- item\n  more of it', breaks), /<li>item<br \/>\nmore of it<\/li>/);
  assert.match(renderMarkdown('> one\n> two', breaks), /<p>one<br \/>\ntwo<\/p>/);
});

test('with it, code, lists, tables, and headings are as they were', () => {
  for (const text of ['```\na\nb\n```', '    a\n    b', '- a\n- b', '| a | b |\n|---|---|\n| 1 | 2 |', '# Title\nbody']) {
    assert.equal(renderMarkdown(text, breaks), renderMarkdown(text, OPTS), text);
  }
});

test('the option does not stay with the shared parser for the next render', () => {
  renderMarkdown('one\ntwo', breaks);
  assert.ok(!renderMarkdown('one\ntwo', OPTS).includes('<br'));
});
