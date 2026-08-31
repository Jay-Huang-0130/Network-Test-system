const state = { config: null, current: null, histories: {}, internal: {}, iperf: [], events: [], colors: ['#62e6a7', '#5bc8e8', '#aa8cff'] };
const $ = (selector) => document.querySelector(selector);

async function api(path, options) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function initialize() {
  state.config = await api('/api/config');
  state.current = await api('/api/session/current');
  renderNodes(); renderSession(); await loadSessions();
  if (state.current) await loadSessionData(state.current.id);
  connectEvents();
}

function allNodes() { return [state.config.controller.localNode, ...state.config.agents]; }

function renderNodes() {
  $('#nodes').innerHTML = allNodes().map((node) => {
    const latest = state.histories[node.id]?.at(-1);
    const status = !latest ? 'idle' : latest.public.online ? 'online' : 'offline';
    const text = !latest ? '等待資料' : latest.public.online ? '公網正常' : latest.agentReachable ? '公網異常' : 'Agent 無回應';
    return `<article class="node card ${status}">
      <div class="node-head"><div><div class="node-name">${escapeHtml(node.name)}</div><div class="node-address">${escapeHtml(node.address)}</div></div><div class="node-status"><i class="dot ${status}"></i>${text}</div></div>
      <div class="metrics">
        <div class="metric"><span>PING</span><strong>${metric(latest?.public.ping.latencyMs, ' ms')}</strong></div>
        <div class="metric"><span>HTTPS</span><strong>${metric(latest?.public.http.latencyMs, ' ms')}</strong></div>
        <div class="metric"><span>訊號</span><strong>${latest ? `${latest.public.score}/4` : '--'}</strong></div>
      </div></article>`;
  }).join('');
}

function renderSession() {
  const active = Boolean(state.current);
  $('#start').disabled = active; $('#stop').disabled = !active; $('#duration').disabled = active;
  $('#session-dot').className = `dot ${active ? 'running' : 'idle'}`;
  $('#session-status').textContent = active ? `測試 #${state.current.id} 執行中` : '尚未執行測試';
  if (!active) $('#remaining').textContent = formatDuration(Number($('#duration').value) * 60);
}

function receiveSample(sample) {
  const history = state.histories[sample.nodeId] ||= [];
  history.push(sample); if (history.length > 120) history.shift();
  for (const result of sample.internal || []) {
    const key = `${sample.nodeId}->${result.targetId}`;
    const points = state.internal[key] ||= [];
    points.push(result.success ? result.latencyMs : null); if (points.length > 120) points.shift();
  }
  renderNodes(); drawAllCharts();
}

function receiveIperf(result) {
  state.iperf.unshift(result); if (state.iperf.length > 30) state.iperf.pop();
  renderIperf();
}

function renderIperf() {
  $('#iperf-body').innerHTML = state.iperf.length ? state.iperf.map((row) => `<tr>
    <td>${formatTime(row.recordedAt)}</td><td>${escapeHtml(row.direction)}</td><td>${row.protocol.toUpperCase()}</td>
    <td>${metric(row.mbps, ' Mbps')}</td><td>${row.retransmits ?? '--'}</td><td>${metric(row.jitterMs, ' ms')}</td>
    <td>${metric(row.lostPercent, '%')}</td><td class="${row.success ? 'ok' : 'bad'}">${row.success ? '成功' : escapeHtml(row.error || '失敗')}</td>
  </tr>`).join('') : '<tr><td colspan="8" class="empty">等待測速結果</td></tr>';
}

function addEvent(event) {
  const descriptions = {
    'outage-start': `${event.nodeId} → ${event.targetKey} 發生斷線`,
    'outage-end': `${event.nodeId} → ${event.targetKey} 已恢復`,
    'session-start': `測試 #${event.session?.id} 已開始`,
    'session-end': `測試 #${event.session?.id} 已結束`
  };
  state.events.unshift({ text: descriptions[event.type] || event.type, time: event.startedAt || event.endedAt || new Date().toISOString(), bad: event.type === 'outage-start' });
  state.events = state.events.slice(0, 40);
  $('#events').innerHTML = state.events.map((item) => `<div class="event"><span class="${item.bad ? 'bad' : 'ok'}">${escapeHtml(item.text)}</span><time>${formatTime(item.time)}</time></div>`).join('');
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('sample', (event) => receiveSample(JSON.parse(event.data)));
  source.addEventListener('iperf', (event) => receiveIperf(JSON.parse(event.data)));
  source.addEventListener('monitor-event', async (event) => {
    const data = JSON.parse(event.data); addEvent(data);
    if (data.type === 'session-start') { state.current = data.session; resetLiveData(); }
    if (data.type === 'session-end') { const id = data.session.id; state.current = null; await loadSessions(); await showSummary(id); }
    renderSession();
  });
  source.onerror = () => showNotice('與控制器的即時連線中斷，瀏覽器會自動重連。');
  source.onopen = () => hideNotice();
}

async function loadSessions() {
  const sessions = await api('/api/sessions');
  $('#sessions').innerHTML = sessions.length ? sessions.map((session) => `<div class="session-row">
    <div><strong>#${session.id} · ${statusText(session.status)}</strong><br><small>${formatDate(session.started_at)} · ${formatDuration(session.duration_seconds)}</small></div>
    <button data-summary="${session.id}">查看</button></div>`).join('') : '<p class="empty">尚無歷史測試</p>';
  document.querySelectorAll('[data-summary]').forEach((button) => button.addEventListener('click', () => showSummary(button.dataset.summary)));
}

async function loadSessionData(id) {
  const [samples, iperf] = await Promise.all([api(`/api/sessions/${id}/samples?limit=360`), api(`/api/sessions/${id}/iperf`)]);
  resetLiveData(); samples.forEach(receiveSample); state.iperf = iperf.slice(-30).reverse(); renderIperf();
}

async function showSummary(id) {
  const summary = await api(`/api/sessions/${id}/summary`);
  $('#summary-section').classList.remove('hidden'); $('#csv-link').href = `/api/sessions/${id}/export.csv`;
  const nodeItems = Object.values(summary.nodes).map((node) => `<div class="summary-item"><span>${escapeHtml(node.name)} 可用率</span><strong>${metric(node.availabilityPercent, '%', 3)}</strong><small>${node.outages} 次斷線 · ${formatDuration(Math.round(node.downtimeMs / 1000))}</small></div>`);
  const linkItems = Object.entries(summary.links).map(([link, value]) => `<div class="summary-item"><span>${escapeHtml(link)} 平均速度</span><strong>${metric(value.throughputMbps.avg, ' Mbps')}</strong><small>P95 ${metric(value.throughputMbps.p95, ' Mbps')} · 重傳 ${value.retransmits}</small></div>`);
  $('#summary').innerHTML = [...nodeItems, ...linkItems].join('') || '<p class="empty">這個測試還沒有足夠資料</p>';
  $('#summary-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawAllCharts() {
  const publicSeries = allNodes().map((node, index) => ({ label: node.name, color: state.colors[index], values: (state.histories[node.id] || []).map((item) => item.public.ping.success ? item.public.ping.latencyMs : null) }));
  const internalSeries = Object.entries(state.internal).map(([label, values], index) => ({ label, color: state.colors[index % state.colors.length], values }));
  drawChart($('#public-chart'), publicSeries); drawChart($('#internal-chart'), internalSeries);
  renderLegend($('#public-legend'), publicSeries); renderLegend($('#internal-legend'), internalSeries);
}

function drawChart(canvas, series) {
  const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth || 500, height = 230;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
  const pad = { left: 42, right: 10, top: 12, bottom: 25 };
  const values = series.flatMap((line) => line.values).filter(Number.isFinite);
  const max = Math.max(10, ...values) * 1.12;
  ctx.strokeStyle = '#24333d'; ctx.fillStyle = '#71858b'; ctx.font = '11px ui-monospace'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + ((height - pad.top - pad.bottom) * i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillText(String(Math.round(max * (1 - i / 4))), 4, y + 4);
  }
  for (const line of series) {
    if (!line.values.length) continue;
    ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.beginPath(); let drawing = false;
    line.values.forEach((value, index) => {
      if (!Number.isFinite(value)) { drawing = false; return; }
      const x = pad.left + (width - pad.left - pad.right) * (index / Math.max(119, line.values.length - 1));
      const y = pad.top + (height - pad.top - pad.bottom) * (1 - value / max);
      drawing ? ctx.lineTo(x, y) : ctx.moveTo(x, y); drawing = true;
    });
    ctx.stroke();
  }
}

function renderLegend(element, series) { element.innerHTML = series.map((line) => `<span><i style="background:${line.color}"></i>${escapeHtml(line.label)}</span>`).join(''); }
function resetLiveData() { state.histories = {}; state.internal = {}; state.iperf = []; state.events = []; renderIperf(); drawAllCharts(); }
function showNotice(text) { $('#notice').textContent = text; $('#notice').classList.remove('hidden'); }
function hideNotice() { $('#notice').classList.add('hidden'); }
function metric(value, suffix = '', digits = 1) { return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : '--'; }
function formatTime(value) { return new Date(value).toLocaleTimeString('zh-TW', { hour12: false }); }
function formatDate(value) { return new Date(value).toLocaleString('zh-TW', { hour12: false }); }
function formatDuration(seconds) { const s = Math.max(0, Number(seconds) || 0); return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), Math.floor(s % 60)].map((v) => String(v).padStart(2, '0')).join(':'); }
function statusText(status) { return ({ running: '執行中', completed: '完成', stopped: '手動停止', interrupted: '意外中止' })[status] || status; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]); }

$('#start').addEventListener('click', async () => {
  try { state.current = await api('/api/session/start', { method: 'POST', body: JSON.stringify({ durationSeconds: Number($('#duration').value) * 60 }) }); resetLiveData(); renderSession(); hideNotice(); }
  catch (error) { showNotice(error.message); }
});
$('#stop').addEventListener('click', async () => { try { await api('/api/session/stop', { method: 'POST', body: '{}' }); } catch (error) { showNotice(error.message); } });
$('#duration').addEventListener('input', renderSession);
setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  if (state.current) $('#remaining').textContent = formatDuration((new Date(state.current.planned_end_at) - Date.now()) / 1000);
}, 250);
window.addEventListener('resize', drawAllCharts);
initialize().catch((error) => showNotice(`初始化失敗：${error.message}`));
