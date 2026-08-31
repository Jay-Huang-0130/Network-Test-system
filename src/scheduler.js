const { EventEmitter } = require('node:events');
const { runLocalProbe, failedSample } = require('./probes');
const { probeAgent, iperfAgent } = require('./agent-client');
const { executeIperf } = require('./iperf');
const { OutageTracker } = require('./outage-tracker');

class MonitorScheduler extends EventEmitter {
  constructor(config, database) {
    super();
    this.config = config;
    this.database = database;
    this.active = null;
    this.probeBusy = new Set();
    this.iperfBusy = false;
    this.tracker = new OutageTracker(database, config.probe.outageThreshold, (event) => this.emit('event', event));
  }

  get nodes() { return [{ ...this.config.controller.localNode, kind: 'local' }, ...this.config.agents.map((node) => ({ ...node, kind: 'agent' }))]; }
  getCurrent() { return this.active ? { ...this.active.session, remainingSeconds: Math.max(0, Math.ceil((new Date(this.active.session.planned_end_at) - Date.now()) / 1000)) } : null; }

  start(durationSeconds = this.config.session.defaultDurationSeconds) {
    if (this.active) throw new Error('已有測試正在執行');
    durationSeconds = Math.max(10, Math.min(86400, Math.round(Number(durationSeconds))));
    if (!Number.isFinite(durationSeconds)) throw new Error('測試時間格式錯誤');
    const session = this.database.createSession(durationSeconds);
    this.active = { session, pairIndex: 0, iperfCycle: 0 };
    this.active.probeTimer = setInterval(() => this.runProbeTick(), this.config.probe.intervalMs);
    this.active.stopTimer = setTimeout(() => this.stop('completed'), durationSeconds * 1000);
    if (this.config.iperf.enabled) {
      this.active.iperfTimer = setInterval(() => this.runIperfCycle(), this.config.iperf.intervalSeconds * 1000);
      setTimeout(() => { if (this.active?.session.id === session.id) this.runIperfCycle(); }, 3000);
    }
    this.runProbeTick();
    this.emit('event', { type: 'session-start', session });
    return session;
  }

  stop(status = 'stopped') {
    if (!this.active) return null;
    const { session, probeTimer, iperfTimer, stopTimer } = this.active;
    clearInterval(probeTimer); clearInterval(iperfTimer); clearTimeout(stopTimer);
    const endedAt = new Date().toISOString();
    this.tracker.closeAll(session.id, endedAt);
    const ended = this.database.endSession(session.id, status, new Date(endedAt));
    this.active = null;
    this.emit('event', { type: 'session-end', session: ended });
    return ended;
  }

  async runProbeTick() {
    if (!this.active) return;
    const sessionId = this.active.session.id;
    await Promise.all(this.nodes.map(async (node) => {
      if (this.probeBusy.has(node.id)) return;
      this.probeBusy.add(node.id);
      const targets = this.nodes.filter((target) => target.id !== node.id);
      let sample;
      try {
        sample = node.kind === 'local'
          ? await runLocalProbe(node, targets, this.config.probe)
          : await probeAgent(node, targets, this.config.probe);
        sample.nodeId = node.id; sample.nodeName = node.name; sample.agentReachable = true;
      } catch (error) {
        sample = failedSample(node, error.message);
        sample.internal = targets.map((target) => ({
          targetId: target.id, targetName: target.name, targetAddress: target.address,
          success: false, latencyMs: null, error: '來源節點 Agent 無回應'
        }));
      } finally {
        this.probeBusy.delete(node.id);
      }
      if (this.active?.session.id !== sessionId) return;
      this.database.insertSample(sessionId, sample);
      this.tracker.observe(sessionId, node.id, 'public', sample.public.online, sample.recordedAt);
      for (const result of sample.internal) this.tracker.observe(sessionId, node.id, `internal:${result.targetId}`, result.success, sample.recordedAt);
      this.emit('sample', sample);
    }));
  }

  buildPairs() {
    const result = [];
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) result.push([nodes[i], nodes[j]]);
    return result;
  }

  async runIperfCycle() {
    if (!this.active || this.iperfBusy) return;
    const sessionId = this.active.session.id;
    const pairs = this.buildPairs();
    if (!pairs.length) return;
    this.iperfBusy = true;
    const pair = pairs[this.active.pairIndex % pairs.length];
    this.active.pairIndex += 1;
    this.active.iperfCycle += 1;
    const protocols = ['tcp'];
    if (this.active.iperfCycle % this.config.iperf.udpEveryCycles === 0) protocols.push('udp');
    try {
      for (const protocol of protocols) {
        await this.runIperfDirection(sessionId, pair[0], pair[1], protocol, false);
        if (!this.active || this.active.session.id !== sessionId) break;
        await this.runIperfDirection(sessionId, pair[0], pair[1], protocol, true);
      }
    } finally {
      this.iperfBusy = false;
    }
  }

  async runIperfDirection(sessionId, client, server, protocol, reverse) {
    const options = {
      target: server.address, port: this.config.iperf.port,
      durationSeconds: this.config.iperf.durationSeconds, protocol, reverse,
      udpBandwidth: this.config.iperf.udpBandwidth
    };
    let measured;
    try {
      measured = client.kind === 'local'
        ? await executeIperf(options)
        : await iperfAgent(client, options, (this.config.iperf.durationSeconds + 10) * 1000);
    } catch (error) {
      measured = { success: false, error: error.message };
    }
    const source = reverse ? server : client;
    const target = reverse ? client : server;
    const result = {
      recordedAt: new Date().toISOString(), sourceId: source.id, targetId: target.id,
      direction: `${source.id}->${target.id}`, protocol, success: Boolean(measured.success),
      mbps: measured.mbps ?? null, retransmits: measured.retransmits ?? null,
      jitterMs: measured.jitterMs ?? null, lostPercent: measured.lostPercent ?? null,
      error: measured.error || null
    };
    if (this.active?.session.id === sessionId) {
      this.database.insertIperf(sessionId, result);
      this.emit('iperf', result);
    }
  }
}

module.exports = { MonitorScheduler };
