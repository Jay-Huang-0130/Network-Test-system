async function postAgent(agent, route, body, timeoutMs) {
  const response = await fetch(`http://${agent.address}:${agent.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': agent.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Agent ${agent.id} 回應 HTTP ${response.status}`);
  return response.json();
}

async function probeAgent(agent, internalTargets, probeConfig) {
  return postAgent(agent, '/probe', {
    node: { id: agent.id, name: agent.name },
    internalTargets: internalTargets.map(({ id, name, address }) => ({ id, name, address })),
    probe: probeConfig
  }, Math.max(2500, probeConfig.timeoutMs * 3));
}

async function iperfAgent(agent, request, timeoutMs) {
  return postAgent(agent, '/iperf', request, timeoutMs);
}

module.exports = { postAgent, probeAgent, iperfAgent };
