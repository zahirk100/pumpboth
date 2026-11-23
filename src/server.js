// Dashboard-server: statische pagina + JSON + live stream (Server-Sent Events).
// Online (Railway) is het dashboard beveiligd met DASHBOARD_PASSWORD.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const csvCell = v => {
  if (v === null || v === undefined) return '';
  const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
function toCsv(rows) {
  const flat = rows.map(r => { const { features, exits, ...rest } = r; return { ...rest, exits: (exits || []).join(' > '), ...(features || {}) }; });
  const cols = [...new Set(flat.flatMap(r => Object.keys(r)))];
  return [cols.join(','), ...flat.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const NO_PASSWORD_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font-family:system-ui;max-width:520px;margin:60px auto;padding:0 20px;line-height:1.5">
<h2>🌙 Night Desk draait</h2><p>Het dashboard staat online maar heeft nog <b>geen wachtwoord</b>, dus het blijft dicht.</p>
<p>Zet in Railway onder <b>Variables</b> de variabele <code>DASHBOARD_PASSWORD</code> en wacht tot de nieuwe deploy klaar is.</p></body>`;

function passwordOk(header, password) {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const given = decoded.slice(decoded.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

export function startServer(engine, cfg) {
  const clients = new Set();
  const html = () => fs.readFileSync(path.join(ROOT, 'index.html'));

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Health-check voor Railway: altijd open, verraadt niets gevoeligs
    if (url.pathname === '/health') {
      const f = engine.feed.stats, now = Date.now();
      return json(res, 200, { ok: true, feedConnected: engine.feed.connected, secSinceLastMessage: Math.round((now - engine.feed.lastMsg) / 1000), creates: f.creates, tradeMsgsToday: f.tradeMsgsToday, tradesProcessed: engine.c.trades, hasApiKey: Boolean(cfg.feedApiKey), unknownMessages: f.unknown });
    }

    // Toegang
    if (cfg.hosted && !cfg.dashboardPassword) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(NO_PASSWORD_PAGE);
    }
    if (cfg.dashboardPassword && !passwordOk(req.headers.authorization, cfg.dashboardPassword)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Night Desk", charset="UTF-8"' });
      return res.end('Wachtwoord vereist');
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html());
    }
    if (req.method === 'GET' && url.pathname === '/api/debug') {
      const f = engine.feed;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ stats: f.stats, subscribed: f.tokens.size, counters: engine.c, samples: f.samples }, null, 2));
    }
    if (req.method === 'GET' && url.pathname === '/api/trades.csv') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="nightdesk-trades.csv"' });
      return res.end(toCsv(engine.allClosed()));
    }
    if (req.method === 'GET' && (url.pathname === '/api/research.csv' || url.pathname === '/api/research-long.csv')) {
      const long = url.pathname.includes('long');
      const file = path.join(cfg.dataDir, long ? 'research-long.jsonl' : 'research.jsonl');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'nog geen onderzoeksdata' });
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="nightdesk-${long ? 'lange-termijn' : 'onderzoek'}.csv"` });
      const rl = readline.createInterface({ input: fs.createReadStream(file) });
      let cols = null;
      rl.on('line', line => {
        let r; try { r = JSON.parse(line); } catch { return; }
        if (!cols) { cols = Object.keys(r); res.write(cols.join(',') + '\n'); }
        res.write(cols.map(c => csvCell(r[c])).join(',') + '\n');
      });
      rl.on('close', () => res.end());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/wallets') {
      return json(res, 200, { summary: engine.wallets?.summary(), top: engine.wallets?.rank(50) || [] });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, engine.snapshot(url.searchParams.get('s')));
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      res.sid = url.searchParams.get('s') || '';
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST') {
      // alleen verzoeken van het dashboard zelf (geen andere websites)
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'forbidden' });
      if (url.pathname === '/api/pause') { engine.setPaused(true); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/resume') { engine.setPaused(false); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/reset') { engine.resetAccount(); return json(res, 200, { ok: true }); }
    }
    json(res, 404, { error: 'not found' });
  });

  const push = setInterval(() => {
    if (!clients.size) return;
    const cache = new Map();
    for (const c of clients) {
      if (!cache.has(c.sid)) cache.set(c.sid, `data: ${JSON.stringify(engine.snapshot(c.sid))}\n\n`);
      c.write(cache.get(c.sid));
    }
  }, 1000);

  server.on('close', () => clearInterval(push));
  server.listen(cfg.port, cfg.host);
  return server;
}
