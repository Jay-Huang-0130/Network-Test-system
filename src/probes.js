const { execFile } = require('node:child_process');
const dns = require('node:dns').promises;
const net = require('node:net');
const { performance } = require('node:perf_hooks');

function runCommand(file, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error) => {
      resolve({ success: !error, latencyMs: round(performance.now() - started), error: error?.code || null });
    });
  });
}

async function ping(target, timeoutMs) {
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(timeoutMs), target]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), target];
  return runCommand('ping', args, timeoutMs + 300);
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const started = performance.now();
    let done = false;
    const finish = (success, error = null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ success, latencyMs: success ? round(performance.now() - started) : null, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, error.code || error.message));
    socket.connect(port, host);
  });
}

async function dnsProbe(hostname, timeoutMs) {
  const started = performance.now();
  try {
    await Promise.race([
      dns.resolve4(hostname),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
    return { success: true, latencyMs: round(performance.now() - started), error: null };
  } catch (error) {
    return { success: false, latencyMs: null, error: error.code || error.message };
  }
}

async function httpProbe(url, timeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Network-System/0.1' }
    });
    await response.body?.cancel();
    return { success: response.status < 500, latencyMs: round(performance.now() - started), status: response.status, error: null };
  } catch (error) {
    return { success: false, latencyMs: null, status: null, error: error.name || error.message };
  }
}

async function runLocalProbe(node, internalTargets, config) {
  const publicPingsPromise = Promise.all(config.publicPingTargets.map((target) => ping(target, config.timeoutMs)));
  const internalPromise = Promise.all(internalTargets.map(async (target) => {
    const result = await ping(target.address, config.timeoutMs);
    return { targetId: target.id, targetName: target.name, targetAddress: target.address, ...result };
  }));
  const [publicPings, tcp, dnsResult, http, internal] = await Promise.all([
    publicPingsPromise,
    tcpProbe(config.tcpTarget.host, config.tcpTarget.port, config.timeoutMs),
    dnsProbe(config.dnsHostname, config.timeoutMs),
    httpProbe(config.httpUrl, config.timeoutMs),
    internalPromise
  ]);
  const successfulPings = publicPings.filter((item) => item.success);
  const pingResult = {
    success: successfulPings.length > 0,
    latencyMs: successfulPings.length ? Math.min(...successfulPings.map((item) => item.latencyMs)) : null,
    targetsSucceeded: successfulPings.length,
    targetsTotal: publicPings.length
  };
  const score = [pingResult.success, tcp.success, dnsResult.success, http.success].filter(Boolean).length;
  return {
    recordedAt: new Date().toISOString(), nodeId: node.id, nodeName: node.name,
    agentReachable: true,
    public: { online: score >= config.onlineMinimumSignals, score, ping: pingResult, tcp, dns: dnsResult, http },
    internal, statusMessage: null
  };
}

function failedSample(node, message) {
  const failed = { success: false, latencyMs: null, error: message };
  return {
    recordedAt: new Date().toISOString(), nodeId: node.id, nodeName: node.name,
    agentReachable: false,
    public: { online: false, score: 0, ping: failed, tcp: failed, dns: failed, http: failed },
    internal: [], statusMessage: message
  };
}

function round(value) { return Math.round(value * 10) / 10; }

module.exports = { ping, tcpProbe, dnsProbe, httpProbe, runLocalProbe, failedSample };
