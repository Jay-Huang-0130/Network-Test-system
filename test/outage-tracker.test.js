const test = require('node:test');
const assert = require('node:assert/strict');
const { OutageTracker } = require('../src/outage-tracker');

test('opens an outage after threshold and closes on recovery', () => {
  const calls = [];
  const database = {
    openOutage: (...args) => { calls.push(['open', ...args]); return 9; },
    closeOutage: (...args) => calls.push(['close', ...args]),
    closeSessionOutages: () => {}
  };
  const tracker = new OutageTracker(database, 3);
  tracker.observe(1, 'pi-1', 'public', false, '2026-01-01T00:00:01Z');
  tracker.observe(1, 'pi-1', 'public', false, '2026-01-01T00:00:02Z');
  assert.equal(calls.length, 0);
  tracker.observe(1, 'pi-1', 'public', false, '2026-01-01T00:00:03Z');
  tracker.observe(1, 'pi-1', 'public', true, '2026-01-01T00:00:04Z');
  assert.deepEqual(calls, [
    ['open', 1, 'pi-1', 'public', '2026-01-01T00:00:01Z'],
    ['close', 9, '2026-01-01T00:00:04Z']
  ]);
});
