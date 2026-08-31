const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIperf } = require('../src/iperf');

test('normalizes TCP iperf JSON', () => {
  const result = normalizeIperf({ end: { sum_received: { bits_per_second: 95_000_000 }, sum_sent: { retransmits: 4 } } }, 'tcp');
  assert.deepEqual(result, { success: true, mbps: 95, retransmits: 4, jitterMs: null, lostPercent: null, error: null });
});

test('normalizes UDP iperf JSON', () => {
  const result = normalizeIperf({ end: { sum_received: { bits_per_second: 10_000_000, jitter_ms: 1.2, lost_percent: 0.5 } } }, 'udp');
  assert.equal(result.mbps, 10);
  assert.equal(result.jitterMs, 1.2);
  assert.equal(result.lostPercent, 0.5);
});
