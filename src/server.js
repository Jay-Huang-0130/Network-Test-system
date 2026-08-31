const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { loadConfig, publicConfig } = require('./config');
const { Database } = require('./database');
const { MonitorScheduler } = require('./scheduler');
const { samplesCsv } = require('./report');

const config = loadConfig();
const database = new Database(config.controller.database);
const recovered = database.recoverInterruptedSessions();
const scheduler = new MonitorScheduler(config, database);
const staticRoot = path.resolve('public');
const sseClients = new Set();

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of sseClients) response.write(payload);
}
scheduler.on('sample', (sample) => broadcast('sample', sample));
scheduler.on('iperf', (result) => broadcast('iperf', result));
scheduler.on('event', (event) => broadcast('monitor-event', event));

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/events' && request.method === 'GET') return openEventStream(request, response);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    return serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: error.message });
  }
});

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/config') return sendJson(response, 200, publicConfig(config));
  if (request.method === 'GET' && url.pathname === '/api/sessions') return sendJson(response, 200, database.listSessions());
  if (request.method === 'GET' && url.pathname === '/api/session/current') return sendJson(response, 200, scheduler.getCurrent());
  if (request.method === 'POST' && url.pathname === '/api/session/start') {
    const body = await readJson(request);
    return sendJson(response, 201, scheduler.start(body.durationSeconds));
  }
  if (request.method === 'POST' && url.pathname === '/api/session/stop') return sendJson(response, 200, scheduler.stop('stopped'));
  const match = url.pathname.match(/^\/api\/sessions\/(\d+)\/(summary|samples|iperf|export\.csv)$/);
  if (request.method === 'GET' && match) {
    const sessionId = Number(match[1]);
    if (!database.getSession(sessionId)) return sendJson(response, 404, { error: '找不到測試記錄' });
    if (match[2] === 'summary') return sendJson(response, 200, database.getSummary(sessionId));
    if (match[2] === 'samples') return sendJson(response, 200, database.getSamples(sessionId, safeLimit(url.searchParams.get('limit'))));
    if (match[2] === 'iperf') return sendJson(response, 200, database.getIperfResults(sessionId));
    const csv = samplesCsv(database.getSamples(sessionId, 1_000_000));
    response.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="network-session-${sessionId}.csv"`,
      'content-length': Buffer.byteLength(csv)
    });
    return response.end(csv);
  }
  return sendJson(response, 404, { error: '找不到 API' });
}

function openEventStream(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache',
    connection: 'keep-alive', 'x-accel-buffering': 'no'
  });
  response.write(`event: connected\ndata: ${JSON.stringify({ current: scheduler.getCurrent() })}\n\n`);
  sseClients.add(response);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
  request.on('close', () => { clearInterval(heartbeat); sseClients.delete(response); });
}

function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filename = path.resolve(staticRoot, relative);
  if (!filename.startsWith(staticRoot + path.sep) && filename !== path.join(staticRoot, 'index.html')) return sendJson(response, 403, { error: 'forbidden' });
  fs.readFile(filename, (error, data) => {
    if (error) return sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: '找不到檔案' });
    response.writeHead(200, { 'content-type': mimeType(filename), 'content-length': data.length });
    response.end(data);
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) request.destroy(new Error('request too large'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON 格式錯誤')); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  const data = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  response.end(data);
}

function safeLimit(value) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(1, Math.min(1_000_000, parsed)) : 1000; }
function mimeType(filename) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream';
}

server.listen(config.controller.port, config.controller.host, () => {
  console.log(`Network System 已啟動：http://localhost:${config.controller.port}`);
  if (recovered) console.log(`已將 ${recovered} 個未正常結束的測試標記為 interrupted`);
});

function shutdown() {
  scheduler.stop('interrupted');
  for (const client of sseClients) client.end();
  server.close(() => { database.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
