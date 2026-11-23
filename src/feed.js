// PumpPortal realtime feed — ÉÉN websocket (PumpPortal blokkeert clients
// die meerdere verbindingen openen). Herverbindt automatisch en
// herstelt alle abonnementen.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const num = v => (v === undefined || v === null || v === '' ? undefined : Number(v));

export function normalize(m, now = Date.now()) {
  if (!m || typeof m !== 'object' || !m.mint) return null;
  const type = String(m.txType || '').toLowerCase();

  let vSol = num(m.vSolInBondingCurve);
  if (vSol === undefined && m.vQuoteInBondingCurve !== undefined) {
    const q = Number(m.vQuoteInBondingCurve);
    vSol = q > 1e6 ? q / 10 ** (m.quoteTokenDecimals ?? 9) : q; // lamports → SOL
  }
  let vTokens = num(m.vTokensInBondingCurve);
  // Na migratie (PumpSwap / pump-amm) komen echte pool-reserves i.p.v. curve-reserves
  if (!(vSol > 0) && num(m.solInPool) > 0) vSol = num(m.solInPool);
  if (!(vTokens > 0) && num(m.tokensInPool) > 0) vTokens = num(m.tokensInPool);
  const base = {
    mint: m.mint,
    signature: m.signature || '',
    trader: m.traderPublicKey || m.txSigner || '',
    vSol,
    vTokens,
    mcapSol: num(m.marketCapSol ?? m.marketCapQuote),
    pool: m.pool || 'pump',
    ts: now,
  };
  if (type === 'create') {
    return {
      ...base, kind: 'create', name: String(m.name || '').slice(0, 40),
      symbol: String(m.symbol || '').slice(0, 16), uri: m.uri || '',
      initialBuy: num(m.initialBuy) || 0, solAmount: num(m.solAmount ?? m.quoteAmount) || 0,
    };
  }
  if (type === 'buy' || type === 'sell') {
    return {
      ...base, kind: 'trade', side: type,
      solAmount: num(m.solAmount ?? m.quoteAmount) || 0,
      tokenAmount: num(m.tokenAmount) || 0,
      newTokenBalance: num(m.newTokenBalance),
    };
  }
  if (type === 'migrate' || type === 'migration' || (!type && m.pool)) {
    return { ...base, kind: 'migration' };
  }
  return null;
}

export class Feed extends EventEmitter {
  constructor(url, { silenceSec = 60, log = () => {} } = {}) {
    super();
    this.url = url;
    this.silenceMs = silenceSec * 1000;
    this.log = log;
    this.tokens = new Set();
    this.accounts = new Set();
    this.ws = null;
    this.connected = false;
    this.backoff = 1000;
    this.lastMsg = Date.now();
    this.stopped = false;
    this.seen = new Set();
    this.samples = [];   // laatste afwijkende berichten, voor /api/debug
    this.seenOld = new Set();
    this.stats = { messages: 0, reconnects: 0, unknown: 0, creates: 0, lastCreateAt: 0, connectedAt: 0, tradeMsgsToday: 0, tradeDay: '' };
  }

  start() {
    this.stopped = false;
    this.#connect();
    this.watchdog = setInterval(() => {
      if (this.connected && Date.now() - this.lastMsg > this.silenceMs) {
        this.log('feed', `Geen data in ${this.silenceMs / 1000}s — opnieuw verbinden`);
        this.ws?.terminate();
      }
    }, 5000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retry);
    this.ws?.close();
  }

  #send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  #sendKeys(method, keys) {
    for (let i = 0; i < keys.length; i += 50) this.#send({ method, keys: keys.slice(i, i + 50) });
  }

  #connect() {
    const ws = new WebSocket(this.url, { handshakeTimeout: 15000 });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.stats.connectedAt = Date.now();
      this.stats.refusals = 0; this.stats.diagnosis = ''; this.stats.nextRetryAt = 0;
      this.backoff = 1000;
      this.lastMsg = Date.now();
      this.log('feed', `Verbonden met ${this.url.replace(/api-key=[^&]+/, 'api-key=***')}`);
      this.#send({ method: 'subscribeNewToken' });
      this.#send({ method: 'subscribeMigration' });
      if (this.tokens.size) this.#sendKeys('subscribeTokenTrade', [...this.tokens]);
      if (this.accounts.size) this.#sendKeys('subscribeAccountTrade', [...this.accounts]);
      this.emit('status', true);
    });
    ws.on('message', buf => {
      this.lastMsg = Date.now();
      this.stats.messages++;
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      const ev = normalize(m, this.lastMsg);
      if (!ev) {
        // Bevestigingen ({message: ...}) zijn normaal; iets met een mint dat we niet snappen niet.
        if (m && m.mint) this.#sample('onbekend', m);
        if (m && m.mint && ++this.stats.unknown <= 3) this.log('feed', `Onbekend berichtformaat: ${JSON.stringify(m).slice(0, 300)}`);
        if (m && (m.errors || m.error)) this.log('feed', `Feed meldt fout: ${JSON.stringify(m.errors || m.error).slice(0, 200)}`);
        return;
      }
      if (ev.kind === 'create') { this.stats.creates++; this.stats.lastCreateAt = this.lastMsg; }
      if (ev.kind === 'trade') {
        const day = new Date(this.lastMsg).toLocaleDateString('sv-SE');
        if (day !== this.stats.tradeDay) { this.stats.tradeDay = day; this.stats.tradeMsgsToday = 0; }
        this.stats.tradeMsgsToday++;
      }
      const noRes = (ev.kind === 'trade' || ev.kind === 'create') && !(ev.vSol > 0 && ev.vTokens > 0);
      if (noRes) { this.stats.noReserves = (this.stats.noReserves || 0) + 1; this.#sample('zonder reserves', m); }
      if (noRes && ++this.stats.unknown <= 3)
        this.log('feed', `Bericht zonder curve-reserves: ${JSON.stringify(m).slice(0, 300)}`);
      // Dezelfde trade kan binnenkomen via token- én account-abonnement
      if (ev.signature) {
        const key = ev.signature + ev.trader + ev.kind;
        if (this.seen.has(key) || this.seenOld.has(key)) return;
        this.seen.add(key);
        if (this.seen.size > 20000) { this.seenOld = this.seen; this.seen = new Set(); }
      }
      this.emit(ev.kind, ev);
    });
    ws.on('unexpected-response', (req, res) => {
      // PumpPortal weigert de verbinding (storing of tijdelijke ban): niet blijven hameren.
      this.stats.lastHttpStatus = res.statusCode;
      this.stats.refusals = (this.stats.refusals || 0) + 1;
      this.backoff = Math.max(this.backoff, 120_000);
      this.stats.nextRetryAt = Date.now() + this.backoff;
      this.log('feed', `PumpPortal weigert verbinding (HTTP ${res.statusCode}) — volgende poging om ${new Date(this.stats.nextRetryAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`);
      ws.terminate();
      if (this.stats.refusals === 2 || this.stats.refusals % 6 === 0) this.#probe();
    });
    ws.on('close', () => this.#onDown());
    ws.on('error', err => {
      if (/closed before the connection/.test(err.message)) return;
      const now = Date.now();
      if (err.message !== this.lastErr || now - (this.lastErrAt || 0) > 10 * 60_000) {
        this.log('feed', `Websocket-fout: ${err.message}${/50[234]/.test(err.message) ? ' (storing bij PumpPortal — blijft opnieuw proberen)' : ''}`);
        this.lastErr = err.message; this.lastErrAt = now;
      }
    });
  }

  /** Diagnose: lukt een verbinding ZONDER API key wel? Dan ligt het aan de key. */
  #probe() {
    if (!/api-key=/.test(this.url) || this.probing) return;
    this.probing = true;
    const url = this.url.replace(/[?&]api-key=[^&]+/, '').replace(/\?$/, '');
    const done = (verdict, detail) => {
      if (!this.probing) return;
      this.probing = false;
      clearTimeout(timer);
      try { p.terminate(); } catch {}
      this.stats.diagnosis = verdict;
      this.log('feed', detail);
      this.emit('diagnosis', verdict);
    };
    const p = new WebSocket(url, { handshakeTimeout: 10000 });
    const timer = setTimeout(() => done('onbekend', 'Diagnose: geen antwoord van PumpPortal binnen 15s'), 15000);
    p.on('open', () => p.send(JSON.stringify({ method: 'subscribeNewToken' })));
    p.on('message', buf => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.mint) done('key', 'Diagnose: ZONDER API key werkt PumpPortal wél → het probleem zit bij de key of het gekoppelde wallet-saldo. Check de key in Railway en het saldo op solscan.');
    });
    p.on('unexpected-response', (q, r) => done('pumpportal', `Diagnose: ook zonder key weigert PumpPortal (HTTP ${r.statusCode}) → storing bij PumpPortal of blokkade van het (gedeelde) server-IP. De bot blijft het proberen.`));
    p.on('error', () => {});
  }

  #onDown() {
    if (this.connected) this.emit('status', false);
    this.connected = false;
    if (this.stopped) return;
    this.stats.reconnects++;
    this.retry = setTimeout(() => this.#connect(), this.backoff);
    this.backoff = this.backoff >= 120_000 ? Math.min(this.backoff * 1.5, 600_000) : Math.min(this.backoff * 2, 30_000);
  }

  #sample(kind, m) {
    this.samples.push({ ts: Date.now(), kind, msg: m });
    if (this.samples.length > 8) this.samples.shift();
  }

  watchTokens(mints) {
    const add = mints.filter(m => !this.tokens.has(m));
    add.forEach(m => this.tokens.add(m));
    if (add.length) this.#sendKeys('subscribeTokenTrade', add);
  }

  /** Afmelden, ook als we denken dat we al afgemeld zijn (berichten blijven komen = geld). */
  forceUnwatch(mint) {
    this.tokens.delete(mint);
    this.#send({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }

  unwatchTokens(mints) {
    const rm = mints.filter(m => this.tokens.has(m));
    rm.forEach(m => this.tokens.delete(m));
    if (rm.length) this.#sendKeys('unsubscribeTokenTrade', rm);
  }

  watchAccounts(wallets) {
    const add = wallets.filter(w => !this.accounts.has(w));
    add.forEach(w => this.accounts.add(w));
    if (add.length) this.#sendKeys('subscribeAccountTrade', add);
  }
}
