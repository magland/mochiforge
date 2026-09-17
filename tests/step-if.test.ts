import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExprEnv, evalGatedCondition } from '../src/ci/expr';
import { statusFunctions } from '../src/runner/context';

// A step's `if:` carries an implicit `success() &&` unless it names a status
// function itself, which is what makes `if: github.ref == 'refs/heads/main'`
// skip after an earlier step failed while `if: always()` still runs. The same
// gate decides a job's `if:` against its `needs`.

function env(jobFailed: boolean, cancelled = false): ExprEnv {
  return {
    contexts: { github: { ref: 'refs/heads/main' } },
    functions: statusFunctions(jobFailed, cancelled),
  };
}

const onMain = "github.ref == 'refs/heads/main'";

test('a plain if runs while the job is succeeding and is skipped after a failure', () => {
  assert.equal(evalGatedCondition(onMain, true, env(false)), true);
  assert.equal(evalGatedCondition(onMain, false, env(true)), false);
  assert.equal(evalGatedCondition('true', false, env(true)), false, 'even a condition that is literally true');
  assert.equal(evalGatedCondition("${{ github.ref == 'refs/heads/main' }}", false, env(true)), false);
});

test('no if at all is the bare gate', () => {
  assert.equal(evalGatedCondition(undefined, true, env(false)), true);
  assert.equal(evalGatedCondition(undefined, false, env(true)), false);
});

test('always() runs either way', () => {
  assert.equal(evalGatedCondition('always()', true, env(false)), true);
  assert.equal(evalGatedCondition('always()', false, env(true)), true);
  assert.equal(evalGatedCondition(`always() && ${onMain}`, false, env(true)), true);
});

test('failure() runs only after a failure', () => {
  assert.equal(evalGatedCondition('failure()', true, env(false)), false);
  assert.equal(evalGatedCondition('failure()', false, env(true)), true);
  assert.equal(evalGatedCondition('${{ failure() }}', false, env(true)), true);
});

test('success() || failure() runs in both states', () => {
  assert.equal(evalGatedCondition('success() || failure()', true, env(false)), true);
  assert.equal(evalGatedCondition('success() || failure()', false, env(true)), true);
});

test('a status function still has to evaluate true', () => {
  assert.equal(evalGatedCondition("failure() && github.ref == 'refs/heads/dev'", false, env(true)), false);
  assert.equal(evalGatedCondition('cancelled()', false, env(true)), false, 'failed is not cancelled');
  assert.equal(evalGatedCondition('cancelled()', false, env(false, true)), true);
});
