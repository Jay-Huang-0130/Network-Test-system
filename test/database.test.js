const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../src/database');

test('stores samples and creates a summary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-system-'));
  const database = new Database(path.join(directory, 'test.db'));
  const session = database.createSession(60, new Date('2026-01-01T00:00:00Z'));
  database.insertSample(session.id, {
    recordedAt: '2026-01-01T00:00:01Z', nodeId: 'pc', nodeName: 'PC', agentReachable: true,
    public: {
      online: true, score: 4,
      ping: { success: true, latencyMs: 10 }, tcp: { success: true, latencyMs: 12 },
      dns: { success: true, latencyMs: 5 }, http: { success: true, latencyMs: 20 }
    }, internal: [], statusMessage: null
  });
  database.insertIperf(session.id, {
    recordedAt: '2026-01-01T00:00:02Z', sourceId: 'pc', targetId: 'pi-1', direction: 'pc->pi-1',
    protocol: 'tcp', success: true, mbps: 94.5, retransmits: 2, jitterMs: null, lostPercent: null
  });
  const summary = database.getSummary(session.id);
  assert.equal(summary.nodes.pc.availabilityPercent, 100);
  assert.equal(summary.links['pc->pi-1 (TCP)'].throughputMbps.avg, 94.5);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
