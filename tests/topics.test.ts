import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { OpError } from '../src/ops';
import { isValidName } from '../src/scan';
import {
  MAX_TOPICS,
  MAX_TOPIC_LENGTH,
  checkTopics,
  countTopics,
  isValidTopic,
  parseTopicsInput,
  repoTopics,
  setTopics,
} from '../src/topics';
import { makeBareRepo, makeVaultDir } from './helpers';

test('a topic is lowercase letters, digits, and hyphens, starting alphanumeric', () => {
  assert.ok(isValidTopic('webgpu'));
  assert.ok(isValidTopic('spike-sorting'));
  assert.ok(isValidTopic('3d'));
  assert.ok(isValidTopic('a'));
  assert.ok(!isValidTopic(''));
  assert.ok(!isValidTopic('WebGPU'));
  assert.ok(!isValidTopic('-leading'));
  assert.ok(!isValidTopic('has space'));
  assert.ok(!isValidTopic('dot.ted'));
  assert.ok(!isValidTopic('under_score'));
  assert.ok(isValidTopic('a'.repeat(MAX_TOPIC_LENGTH)));
  assert.ok(!isValidTopic('a'.repeat(MAX_TOPIC_LENGTH + 1)));
});

test('checkTopics trims, drops empties, dedupes, and keeps order', () => {
  assert.deepEqual(checkTopics([' webgpu ', '', 'numbl', 'webgpu']), ['webgpu', 'numbl']);
  assert.deepEqual(checkTopics([]), []);
});

test('checkTopics refuses an invalid topic, and names the lowercase fix when that is the fix', () => {
  const err = (topics: string[]): string => {
    try {
      checkTopics(topics);
    } catch (e) {
      assert.ok(e instanceof OpError);
      return (e as OpError).message;
    }
    assert.fail('expected checkTopics to throw');
  };
  assert.match(err(['WebGPU']), /try "webgpu"/);
  assert.doesNotMatch(err(['has space']), /try/);
});

test('checkTopics caps the set at the GitHub limit', () => {
  const many = Array.from({ length: MAX_TOPICS + 1 }, (_, i) => `topic-${i}`);
  assert.throws(() => checkTopics(many), OpError);
  assert.equal(checkTopics(many.slice(0, MAX_TOPICS)).length, MAX_TOPICS);
});

test('parseTopicsInput splits on spaces, commas, or both', () => {
  assert.deepEqual(parseTopicsInput('webgpu numbl'), ['webgpu', 'numbl']);
  assert.deepEqual(parseTopicsInput('webgpu, numbl,mri'), ['webgpu', 'numbl', 'mri']);
  assert.deepEqual(parseTopicsInput('  '), []);
  assert.deepEqual(parseTopicsInput(''), []);
});

test('topics round-trip through the topics file, and clearing removes it', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  assert.deepEqual(repoTopics(dir), []);
  setTopics(dir, ['webgpu', 'numbl']);
  assert.deepEqual(repoTopics(dir), ['webgpu', 'numbl']);
  assert.equal(fs.readFileSync(path.join(dir, 'topics'), 'utf8'), 'webgpu\nnumbl\n');
  setTopics(dir, []);
  assert.deepEqual(repoTopics(dir), []);
  assert.ok(!fs.existsSync(path.join(dir, 'topics')));
});

test('setTopics validates before writing, so a bad set changes nothing', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  setTopics(dir, ['good']);
  assert.throws(() => setTopics(dir, ['good', 'Bad One']), OpError);
  assert.deepEqual(repoTopics(dir), ['good']);
});

test('reading a hand-edited file stays permissive: invalid lines skipped, the cap held', () => {
  const root = makeVaultDir();
  const dir = makeBareRepo(root, 'demo', 'proj');
  const lines = ['ok-topic', 'NOT VALID', '', '  spaced  ', 'ok-topic', ...Array.from({ length: 30 }, (_, i) => `t${i}`)];
  fs.writeFileSync(path.join(dir, 'topics'), lines.join('\n') + '\n');
  const read = repoTopics(dir);
  assert.ok(read.includes('ok-topic'));
  assert.ok(read.includes('spaced'));
  assert.ok(!read.includes('NOT VALID'));
  assert.equal(read.filter((t) => t === 'ok-topic').length, 1);
  assert.equal(read.length, MAX_TOPICS);
});

test('countTopics counts across repositories, most used first, ties alphabetical', () => {
  assert.deepEqual(countTopics([['a', 'b'], ['b'], ['c', 'b'], []]), [
    { topic: 'b', count: 3 },
    { topic: 'a', count: 1 },
    { topic: 'c', count: 1 },
  ]);
  assert.deepEqual(countTopics([]), []);
});

test('topics is a reserved name, since /topics is a page', () => {
  assert.ok(!isValidName('topics'));
});
