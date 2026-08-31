const test = require('node:test');
const assert = require('node:assert/strict');
const { percentile, summarize } = require('../src/stats');

test('percentile calculates interpolated values', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([], 0.95), null);
});

test('summarize ignores non-finite input', () => {
  const result = summarize([10, null, 20, undefined, 30]);
  assert.equal(result.count, 3);
  assert.equal(result.avg, 20);
  assert.equal(result.min, 10);
  assert.equal(result.max, 30);
});
