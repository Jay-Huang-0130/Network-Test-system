const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { summarize } = require('./stats');

class Database {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL,
        planned_end_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
        recorded_at TEXT NOT NULL, node_id TEXT NOT NULL, node_name TEXT NOT NULL,
        agent_reachable INTEGER NOT NULL, public_online INTEGER NOT NULL,
        public_score INTEGER NOT NULL, ping_success INTEGER NOT NULL,
        ping_latency_ms REAL, tcp_success INTEGER NOT NULL, tcp_latency_ms REAL,
        dns_success INTEGER NOT NULL, dns_latency_ms REAL, http_success INTEGER NOT NULL,
        http_latency_ms REAL, internal_json TEXT NOT NULL, status_message TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_samples_session_time ON samples(session_id, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_samples_session_node ON samples(session_id, node_id);
      CREATE TABLE IF NOT EXISTS iperf_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
        recorded_at TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
        direction TEXT NOT NULL, protocol TEXT NOT NULL, success INTEGER NOT NULL,
        mbps REAL, retransmits INTEGER, jitter_ms REAL, lost_percent REAL, error TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_iperf_session ON iperf_results(session_id, recorded_at);
      CREATE TABLE IF NOT EXISTS outages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
        node_id TEXT NOT NULL, target_key TEXT NOT NULL, started_at TEXT NOT NULL,
        ended_at TEXT, duration_ms INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
    `);
  }

  createSession(durationSeconds, now = new Date()) {
    const plannedEnd = new Date(now.getTime() + durationSeconds * 1000);
    const result = this.db.prepare(`INSERT INTO sessions(started_at, planned_end_at, status, duration_seconds) VALUES (?, ?, 'running', ?)`)
      .run(now.toISOString(), plannedEnd.toISOString(), durationSeconds);
    return this.getSession(Number(result.lastInsertRowid));
  }

  getSession(id) { return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null; }
  listSessions(limit = 20) { return this.db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT ?').all(limit); }
  recoverInterruptedSessions(now = new Date()) {
    return this.db.prepare("UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(now.toISOString()).changes;
  }
  endSession(id, status = 'completed', now = new Date()) {
    this.db.prepare('UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?').run(now.toISOString(), status, id);
    return this.getSession(id);
  }

  insertSample(sessionId, sample) {
    this.db.prepare(`INSERT INTO samples(
      session_id, recorded_at, node_id, node_name, agent_reachable, public_online,
      public_score, ping_success, ping_latency_ms, tcp_success, tcp_latency_ms,
      dns_success, dns_latency_ms, http_success, http_latency_ms, internal_json, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId, sample.recordedAt, sample.nodeId, sample.nodeName,
      sample.agentReachable ? 1 : 0, sample.public.online ? 1 : 0, sample.public.score,
      sample.public.ping.success ? 1 : 0, sample.public.ping.latencyMs,
      sample.public.tcp.success ? 1 : 0, sample.public.tcp.latencyMs,
      sample.public.dns.success ? 1 : 0, sample.public.dns.latencyMs,
      sample.public.http.success ? 1 : 0, sample.public.http.latencyMs,
      JSON.stringify(sample.internal || []), sample.statusMessage || null
    );
  }

  insertIperf(sessionId, result) {
    this.db.prepare(`INSERT INTO iperf_results(
      session_id, recorded_at, source_id, target_id, direction, protocol,
      success, mbps, retransmits, jitter_ms, lost_percent, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId, result.recordedAt, result.sourceId, result.targetId, result.direction,
      result.protocol, result.success ? 1 : 0, result.mbps, result.retransmits,
      result.jitterMs, result.lostPercent, result.error || null
    );
  }

  openOutage(sessionId, nodeId, targetKey, startedAt) {
    const result = this.db.prepare('INSERT INTO outages(session_id, node_id, target_key, started_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, nodeId, targetKey, startedAt);
    return Number(result.lastInsertRowid);
  }

  closeOutage(id, endedAt) {
    const row = this.db.prepare('SELECT started_at FROM outages WHERE id = ?').get(id);
    if (!row) return;
    const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(row.started_at).getTime());
    this.db.prepare('UPDATE outages SET ended_at = ?, duration_ms = ? WHERE id = ?').run(endedAt, durationMs, id);
  }

  closeSessionOutages(sessionId, endedAt) {
    for (const row of this.db.prepare('SELECT id FROM outages WHERE session_id = ? AND ended_at IS NULL').all(sessionId)) this.closeOutage(row.id, endedAt);
  }

  getSamples(sessionId, limit = 1000) {
    return this.db.prepare('SELECT * FROM samples WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit).reverse().map(mapSample);
  }
  getIperfResults(sessionId) {
    return this.db.prepare('SELECT * FROM iperf_results WHERE session_id = ? ORDER BY id').all(sessionId).map(mapIperf);
  }
  getOutages(sessionId) {
    return this.db.prepare('SELECT * FROM outages WHERE session_id = ? ORDER BY started_at').all(sessionId);
  }

  getSummary(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const sampleRows = this.db.prepare('SELECT * FROM samples WHERE session_id = ? ORDER BY id').all(sessionId);
    const iperf = this.getIperfResults(sessionId);
    const outages = this.getOutages(sessionId);
    const byNode = {};
    for (const row of sampleRows) {
      const node = byNode[row.node_id] ||= { name: row.node_name, total: 0, online: 0, ping: [], http: [], dns: [] };
      node.total += 1; node.online += row.public_online;
      if (row.ping_success && row.ping_latency_ms != null) node.ping.push(row.ping_latency_ms);
      if (row.http_success && row.http_latency_ms != null) node.http.push(row.http_latency_ms);
      if (row.dns_success && row.dns_latency_ms != null) node.dns.push(row.dns_latency_ms);
    }
    const nodes = Object.fromEntries(Object.entries(byNode).map(([id, node]) => {
      const nodeOutages = outages.filter((item) => item.node_id === id && item.target_key === 'public');
      return [id, {
        name: node.name, sampleCount: node.total,
        availabilityPercent: node.total ? (node.online / node.total) * 100 : null,
        pingLatencyMs: summarize(node.ping), httpLatencyMs: summarize(node.http), dnsLatencyMs: summarize(node.dns),
        outages: nodeOutages.length, downtimeMs: nodeOutages.reduce((sum, item) => sum + (item.duration_ms || 0), 0)
      }];
    }));
    const links = {};
    for (const row of iperf.filter((item) => item.success)) {
      const key = `${row.sourceId}->${row.targetId} (${row.protocol.toUpperCase()})`;
      const link = links[key] ||= { mbps: [], jitterMs: [], lostPercent: [], retransmits: 0 };
      if (row.mbps != null) link.mbps.push(row.mbps);
      if (row.jitterMs != null) link.jitterMs.push(row.jitterMs);
      if (row.lostPercent != null) link.lostPercent.push(row.lostPercent);
      link.retransmits += row.retransmits || 0;
    }
    return {
      session, nodes,
      links: Object.fromEntries(Object.entries(links).map(([key, link]) => [key, {
        throughputMbps: summarize(link.mbps), jitterMs: summarize(link.jitterMs),
        packetLossPercent: summarize(link.lostPercent), retransmits: link.retransmits
      }])),
      outages, iperfTestCount: iperf.length, sampleCount: sampleRows.length
    };
  }

  close() { this.db.close(); }
}

function mapSample(row) {
  return {
    id: row.id, sessionId: row.session_id, recordedAt: row.recorded_at,
    nodeId: row.node_id, nodeName: row.node_name, agentReachable: Boolean(row.agent_reachable),
    public: {
      online: Boolean(row.public_online), score: row.public_score,
      ping: { success: Boolean(row.ping_success), latencyMs: row.ping_latency_ms },
      tcp: { success: Boolean(row.tcp_success), latencyMs: row.tcp_latency_ms },
      dns: { success: Boolean(row.dns_success), latencyMs: row.dns_latency_ms },
      http: { success: Boolean(row.http_success), latencyMs: row.http_latency_ms }
    },
    internal: JSON.parse(row.internal_json || '[]'), statusMessage: row.status_message
  };
}

function mapIperf(row) {
  return {
    id: row.id, sessionId: row.session_id, recordedAt: row.recorded_at,
    sourceId: row.source_id, targetId: row.target_id, direction: row.direction,
    protocol: row.protocol, success: Boolean(row.success), mbps: row.mbps,
    retransmits: row.retransmits, jitterMs: row.jitter_ms,
    lostPercent: row.lost_percent, error: row.error
  };
}

module.exports = { Database, mapSample, mapIperf };
