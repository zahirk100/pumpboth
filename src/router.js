// Feed-router: één primaire databron + automatische reserve.
//   primair: PumpAPI (gratis, alles)      reserve: PumpPortal (betaald per bericht)
// Valt de primaire bron langer dan `failoverSec` weg, dan start de reserve.
// Is de primaire bron weer `recoverSec` stabiel, dan stopt de reserve (scheelt kosten).
// Voor de engine gedraagt de router zich als één gewone Feed.
import { EventEmitter } from 'node:events';

export class FeedRouter extends EventEmitter {
  constructor({ primary, fallback = null, log = () => {}, failoverSec = 60, recoverSec = 120 }) {
    super();
    this.primary = primary;
    this.fallback = fallback;
    this.log = log;
    this.failoverMs = failoverSec * 1000;
    this.recoverMs = recoverSec * 1000;
    this.fallbackOn = false;
    this.connected = false;
    this.seen = new Set(); this.seenOld = new Set();
    for (const [src, name] of [[primary, 'primary'], [fallback, 'fallback']]) {
      if (!src) continue;
      for (const kind of ['create', 'trade', 'migration']) src.on(kind, ev => this.#forward(kind, ev, name));
      src.on('status', () => this.#updateStatus());
      src.on('diagnosis', v => this.emit('diagnosis', v));
      // volledige marktstroom heeft alleen de primaire bron (PumpAPI)
      if (name === 'primary') src.on('raw', ev => this.emit('raw', ev));
    }
  }

  get tokens() { return this.primary.tokens; }
  get samples() { return [...(this.primary.samples || []), ...(this.fallback?.samples || [])].slice(-8); }
  get lastMsg() { return Math.max(this.primary.lastMsg || 0, this.fallback?.lastMsg || 0); }

  get stats() {
    const p = this.primary.stats, f = this.fallback?.stats || {};
    const active = this.primary.connected ? 'PumpAPI' : this.fallback?.connected ? 'PumpPortal' : '';
    return {
      source: active,
      fallbackOn: this.fallbackOn,
      rate: (this.primary.connected ? p.rate : 0) || 0,
      messages: (p.messages || 0) + (f.messages || 0),
      creates: (p.creates || 0) + (f.creates || 0),
      lastCreateAt: Math.max(p.lastCreateAt || 0, f.lastCreateAt || 0),
      connectedAt: Math.max(p.connectedAt || 0, f.connectedAt || 0),
      reconnects: (p.reconnects || 0) + (f.reconnects || 0),
      unknown: (p.unknown || 0) + (f.unknown || 0),
      noReserves: f.noReserves || 0,
      // alleen PumpPortal kost geld per bericht
      tradeMsgsToday: f.tradeMsgsToday || 0,
      tradeDay: f.tradeDay,
      lastHttpStatus: this.primary.connected ? 0 : (p.lastHttpStatus || f.lastHttpStatus || 0),
      primaryStatus: p.lastHttpStatus || 0,
      fallbackStatus: f.lastHttpStatus || 0,
      nextRetryAt: f.nextRetryAt || 0,
      diagnosis: f.diagnosis || '',
    };
  }

  start() {
    this.primary.start();
    this.downSince = Date.now();
    this.timer = setInterval(() => this.#check(), 5000);
  }

  stop() {
    clearInterval(this.timer);
    this.primary.stop();
    this.fallback?.stop();
  }

  #check() {
    const now = Date.now();
    const pOk = this.primary.connected && now - (this.primary.lastMsg || 0) < 30_000;
    if (pOk) { this.downSince = 0; this.upSince ||= now; } else { this.upSince = 0; this.downSince ||= now; }
    if (!this.fallback) return;
    if (!this.fallbackOn && !pOk && now - this.downSince > this.failoverMs) {
      this.fallbackOn = true;
      this.log('feed', 'PumpAPI valt weg — reserve-databron PumpPortal wordt gestart');
      this.fallback.start();
    } else if (this.fallbackOn && pOk && now - this.upSince > this.recoverMs) {
      this.fallbackOn = false;
      this.log('feed', 'PumpAPI weer stabiel — reserve PumpPortal gestopt (scheelt datakosten)');
      this.fallback.stop();
    }
  }

  #updateStatus() {
    const up = Boolean(this.primary.connected || this.fallback?.connected);
    if (up !== this.connected) { this.connected = up; this.emit('status', up); }
  }

  #forward(kind, ev, from) {
    // Zelfde transactie via twee bronnen? Maar één keer doorgeven.
    if (ev.signature) {
      const key = ev.signature + ev.trader + kind;
      if (this.seen.has(key) || this.seenOld.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > 50_000) { this.seenOld = this.seen; this.seen = new Set(); }
    }
    ev.source = from;
    this.emit(kind, ev);
  }

  watchTokens(m) { this.primary.watchTokens(m); this.fallback?.watchTokens(m); }
  unwatchTokens(m) { this.primary.unwatchTokens(m); this.fallback?.unwatchTokens(m); }
  forceUnwatch(m) { this.primary.forceUnwatch(m); this.fallback?.forceUnwatch(m); }
  watchAccounts(w) { this.primary.watchAccounts(w); this.fallback?.watchAccounts(w); }
  unwatchAccounts(w) { this.primary.unwatchAccounts(w); this.fallback?.unwatchAccounts(w); }
}
