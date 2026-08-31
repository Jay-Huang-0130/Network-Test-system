const { execFile } = require('node:child_process');

function executeIperf({ target, port, durationSeconds, protocol = 'tcp', reverse = false, udpBandwidth = '10M' }) {
  const args = ['-c', target, '-p', String(port), '-t', String(durationSeconds), '-J'];
  if (reverse) args.push('-R');
  if (protocol === 'udp') args.push('-u', '-b', udpBandwidth);
  return new Promise((resolve) => {
    execFile('iperf3', args, { timeout: (durationSeconds + 8) * 1000, maxBuffer: 5_000_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve({ success: false, error: friendlyIperfError(error, stderr) });
      try {
        resolve(normalizeIperf(JSON.parse(stdout), protocol));
      } catch (parseError) {
        resolve({ success: false, error: `無法解析 iperf3 結果：${parseError.message}` });
      }
    });
  });
}

function normalizeIperf(data, protocol) {
  if (data.error) return { success: false, error: data.error };
  if (protocol === 'udp') {
    const sum = data.end?.sum_received || data.end?.sum || {};
    return {
      success: Number.isFinite(sum.bits_per_second),
      mbps: toMbps(sum.bits_per_second), retransmits: null,
      jitterMs: numberOrNull(sum.jitter_ms), lostPercent: numberOrNull(sum.lost_percent),
      error: Number.isFinite(sum.bits_per_second) ? null : 'iperf3 UDP 結果缺少速率'
    };
  }
  const received = data.end?.sum_received || {};
  const sent = data.end?.sum_sent || {};
  const bits = received.bits_per_second ?? sent.bits_per_second;
  return {
    success: Number.isFinite(bits), mbps: toMbps(bits),
    retransmits: numberOrNull(sent.retransmits), jitterMs: null, lostPercent: null,
    error: Number.isFinite(bits) ? null : 'iperf3 TCP 結果缺少速率'
  };
}

function friendlyIperfError(error, stderr) {
  if (error.code === 'ENOENT') return '找不到 iperf3，請先依 README 安裝';
  if (error.killed) return 'iperf3 執行逾時';
  return String(stderr || error.message).trim().slice(0, 500);
}

function toMbps(bits) { return Number.isFinite(bits) ? Math.round(bits / 100_000) / 10 : null; }
function numberOrNull(value) { return Number.isFinite(value) ? value : null; }

module.exports = { executeIperf, normalizeIperf };
