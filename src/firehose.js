// PumpAPI-datastream (wss://stream.pumpapi.io) — gratis, geen key, geen abonnementen.
// De stream stuurt ALLES (alle DEX'en, transfers, ~300-400 tx/s). We filteren hier
// lokaal op pump.fun (bonding curve) en pump-amm (na migratie), in SOL.
// Zelfde interface als Feed (PumpPortal), zodat de engine niets merkt.
//
// Let op: PumpAPI staat maar 1 verbinding per IP-adres toe.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { normalize } from './feed.js';

const WSOL = 'So11111111111111111111111111111111111111112';

export class FirehoseFeed extends EventEmitter {
  constructor(url, { silenceSec = 30, log = () => {}, name = 'PumpAPI' } = {}) {
    super();
    this.url = url;
    this.name = name;
    this.silenceMs = silenceSec * 1000;
    this.log = log;
    this.tokens = new Set();
    this.accounts = new Set();
    this.createSigs = new Map();
    this.connected = false;
    this.backoff = 1000;
    this.lastMsg = 0;
    this.stopped = true;
    this.stats = { messages: 0, relevant: 0, creates: 0, lastCreateAt: 0, connectedAt: 0, reconnects: 0, rate: 0, unknown: 0, tradeMsgsToday: 0 };
    this.samples = [];
    this.lastErr = '';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
    let lastCount = 0, lastAt = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      this.stats.rate = Math.round((this.stats.messages - lastCount) / ((now - lastAt) / 1000));
      lastCount = this.stats.messages; lastAt = now;
      if (this.connected && now - this.lastMsg > this.silenceMs) {
        this.log('feed', `${this.name}: ${this.silenceMs / 1000}s geen data — opnieuw verbinden`);
        this.ws?.terminate();
      }
      for (const [sig, ts] of this.createSigs) if (now - ts > 60_000) this.createSigs.delete(sig);
    }, 5000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    this.ws?.close();
    if (this.connected) { this.connected = false; this.emit('status', false); }
  }

  #connect() {
    const ws = new WebSocket(this.url, { handshakeTimeout: 15000 });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoff = 1000;
      this.lastMsg = Date.now();
      this.stats.connectedAt = Date.now();
      this.stats.lastHttpStatus = 0;
      this.log('feed', `Verbonden met ${this.name} (gratis datastream)`);
      this.emit('status', true);
    });
    ws.on('message', buf => {
      this.lastMsg = Date.now();
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (Array.isArray(m)) for (const x of m) this.#handle(x); else this.#handle(m);
    });
    ws.on('unexpected-response', (req, res) => {
      this.stats.lastHttpStatus = res.statusCode;
      this.backoff = Math.max(this.backoff, 30_000);
      const why = res.statusCode === 429 || res.statusCode === 403 ? ' (mogelijk al een verbinding vanaf dit IP)' : '';
      this.#logOnce(`${this.name} weigert verbinding (HTTP ${res.statusCode})${why}`);
      ws.terminate();
    });
    ws.on('close', () => this.#onDown());
    ws.on('error', err => { if (!/closed before the connection/.test(err.message)) this.#logOnce(`${this.name}-fout: ${err.message}`); });
  }

  #logOnce(msg) {
    const now = Date.now();
    if (msg !== this.lastErr || now - (this.lastErrAt || 0) > 10 * 60_000) { this.log('feed', msg); this.lastErr = msg; this.lastErrAt = now; }
  }

  #onDown() {
    if (this.connected) { this.connected = false; this.emit('status', false); }
    if (this.stopped) return;
    this.stats.reconnects++;
    this.retry = setTimeout(() => this.#connect(), this.backoff);
    this.backoff = this.backoff >= 30_000 ? Math.min(this.backoff * 1.5, 300_000) : Math.min(this.backoff * 2, 15_000);
  }

  #handle(m) {
    this.stats.messages++;
    if (!m || typeof m !== 'object') return;
    const pool = m.pool;
    if (pool !== 'pump' && pool !== 'pump-amm') return;
    if (m.quoteMint && m.quoteMint !== WSOL) return;
    const action = String(m.action || m.txType || '').toLowerCase();

    // pump-amm "create" = de pool die bij migratie wordt aangemaakt
    if (action === 'create' && pool === 'pump-amm') {
      if (m.mint && this.tokens.has(m.mint)) this.emit('migration', { kind: 'migration', mint: m.mint, signature: m.signature || '', pool, ts: Date.now() });
      return;
    }
    if (action !== 'create' && action !== 'buy' && action !== 'sell') return;
    const ev = normalize(m, Date.now());
    if (!ev) { this.#sample(m); return; }
    this.stats.relevant++;

    if (ev.kind === 'create') {
      if (ev.signature) this.createSigs.set(ev.signature, ev.ts);
      this.stats.creates++; this.stats.lastCreateAt = ev.ts;
      this.emit('create', ev);
      return;
    }
    // de dev-buy zit al in het create-bericht; niet dubbel tellen
    if (ev.signature && this.createSigs.has(ev.signature)) return;
    if (!(ev.vSol > 0 && ev.vTokens > 0)) { this.#sample(m); return; }
    if (this.tokens.has(ev.mint) || this.accounts.has(ev.trader)) this.emit('trade', ev);
  }

  #sample(m) {
    this.stats.unknown++;
    this.samples.push({ ts: Date.now(), kind: 'pumpapi-afwijkend', msg: m });
    if (this.samples.length > 8) this.samples.shift();
    if (this.stats.unknown <= 3) this.log('feed', `${this.name}: onverwacht bericht ${JSON.stringify(m).slice(0, 300)}`);
  }

  // Geen abonnementen nodig: we filteren lokaal. Interface gelijk aan Feed.
  watchTokens(mints) { for (const m of mints) this.tokens.add(m); }
  unwatchTokens(mints) { for (const m of mints) this.tokens.delete(m); }
  forceUnwatch(mint) { this.tokens.delete(mint); }
  watchAccounts(wallets) { for (const w of wallets) this.accounts.add(w); }
}
