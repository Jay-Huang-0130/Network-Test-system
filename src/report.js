function csvEscape(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function samplesCsv(samples) {
  const headers = [
    'recorded_at', 'node_id', 'node_name', 'agent_reachable', 'public_online',
    'public_score', 'ping_success', 'ping_latency_ms', 'tcp_success', 'tcp_latency_ms',
    'dns_success', 'dns_latency_ms', 'http_success', 'http_latency_ms', 'internal_results', 'status_message'
  ];
  const rows = samples.map((sample) => [
    sample.recordedAt, sample.nodeId, sample.nodeName, sample.agentReachable,
    sample.public.online, sample.public.score, sample.public.ping.success, sample.public.ping.latencyMs,
    sample.public.tcp.success, sample.public.tcp.latencyMs, sample.public.dns.success,
    sample.public.dns.latencyMs, sample.public.http.success, sample.public.http.latencyMs,
    sample.internal, sample.statusMessage
  ]);
  return '\uFEFF' + [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

module.exports = { csvEscape, samplesCsv };
