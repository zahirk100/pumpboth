// Spot Desk: paper trading op de 10 grote coins met echte Bitvavo-koersen.
// Elke strategie heeft een eigen portemonnee van (standaard) €100, net als straks live.
import fs from 'node:fs';
import path from 'node:path';
import { COINS, STRATEGIES } from './strategies.js';
import { Market, IV_MS } from './market.js';
import { Book, COSTS, summarize } from './sim.js';
import { backtest } from './backtest.js';

const BT_FROM = Date.UTC(2023, 0, 1);
const HIST_FROM = Date.UTC(2022, 8, 1); // ruim vóór 2023 voor de opwarmtijd van indicatoren

export class SpotDesk {
  constructor(cfg, { fetchFn, log = () => {}, now = () => Date.now(), strategies = STRATEGIES, coins = COINS } = {}) {
    this.cfg = cfg; this.log = log; this.now = now; this.strategies = strategies; this.coins = coins;
    this.startEur = cfg.spotStartEur ?? 100;
    this.dir = cfg.dataDir ? path.join(cfg.dataDir, 'spot') : null;
    this.market = new Market({ coins, dataDir: cfg.dataDir, fetchFn, log, now });
    this.books = {}; this.lastBar = {}; this.curves = {}; this.signals = {}; this.bt = {};
    this.events = []; this.ready = false; this.status = 'opstarten';
    this.#load();
  }
  #file() { return this.dir && path.join(this.dir, 'paper.json'); }
  #load() {
    for (const s of this.strategies) { this.books[s.id] = new Book(this.startEur, this.coins.length); this.lastBar[s.id] = {}; this.curves[s.id] = []; }
    const f = this.#file();
    if (f && fs.existsSync(f)) {
      try {
        const o = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const s of this.strategies) if (o.books?.[s.id]) {
          this.books[s.id] = Book.from(o.books[s.id]);
          this.lastBar[s.id] = o.lastBar?.[s.id] || {};
          this.curves[s.id] = o.curves?.[s.id] || [];
        }
        this.events = o.events || []; this.startedAt = o.startedAt;
      } catch (e) { this.log('fail', `Spot: opslag niet leesbaar (${e.message}) — opnieuw begonnen`); }
    }
    this.startedAt ??= this.now();
  }
  save() {
    const f = this.#file(); if (!f) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const books = Object.fromEntries(Object.entries(this.books).map(([k, b]) => [k, b.toJSON()]));
    fs.writeFileSync(f + '.tmp', JSON.stringify({ books, lastBar: this.lastBar, curves: this.curves, events: this.events.slice(-300), startedAt: this.startedAt }));
    fs.renameSync(f + '.tmp', f);
  }
  #event(kind, text, sid) { this.events.push({ at: this.now(), kind, text, sid }); if (this.events.length > 400) this.events.splice(0, 100); this.log('spot', text); }

  intervals() { return [...new Set(this.strategies.map(s => s.interval))]; }

  async init() {
    for (const iv of this.intervals()) this.market.loadCache(iv);
    for (const iv of this.intervals()) { await this.market.refreshCandles(iv, HIST_FROM); this.market.saveCache(iv); }
    await this.market.refreshPrices();
    this.runBacktests();
    this.ready = true;
    await this.step();
  }

  runBacktests() {
    for (const s of this.strategies) {
      const cs = Object.fromEntries(this.coins.map(c => [c, this.market.get(c, s.interval)]).filter(([, k]) => k.length));
      if (!cs.BTC) continue;
      const btc = this.market.get('BTC', '1d');
      const full = backtest(s, cs, btc, { from: BT_FROM, startEur: this.startEur });
      const yr = backtest(s, cs, btc, { from: this.now() - 365 * 86400e3, startEur: this.startEur });
      // grafiek: maximaal ~400 punten
      const step = Math.max(1, Math.ceil(full.curve.length / 400));
      this.bt[s.id] = { ...full, curve: full.curve.filter((_, i) => i % step === 0 || i === full.curve.length - 1), last12m: { returnPct: yr.returnPct, maxDDPct: yr.maxDDPct, trades: yr.trades } };
    }
    this.btAt = this.now();
  }

  // Elke paar minuten: candles bijwerken, prijzen ophalen, nieuwe signalen uitvoeren.
  async step() {
    for (const iv of this.intervals()) await this.market.refreshCandles(iv, HIST_FROM);
    await this.market.refreshPrices();
    const priceOf = c => this.market.price(c);
    const at = this.now();
    for (const s of this.strategies) {
      const book = this.books[s.id];
      const btc = this.market.get('BTC', '1d');
      const sigs = {}; const plan = [];
      for (const c of this.coins) {
        const cs = this.market.get(c, s.interval); if (!cs.length) continue;
        const last = s.series(cs, btc).at(-1);
        sigs[c] = { ...last, held: Boolean(book.pos[c]) };
        if (!last || last.on === null || last.on === undefined) continue;
        if (this.lastBar[s.id][c] === last.t) continue;   // deze candle al verwerkt
        this.lastBar[s.id][c] = last.t;
        plan.push([c, last]);
      }
      // eerst verkopen (maakt geld vrij), dan kopen
      for (const [c, x] of plan) if (!x.on && book.pos[c]) { const t = book.sell(c, priceOf(c), at, x.info); if (t) this.#event('verkoop', `${s.name}: ${c} verkocht ${t.pnl >= 0 ? '+' : ''}€${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(1)}%) — ${x.info}`, s.id); }
      for (const [c, x] of plan) if (x.on && !book.pos[c]) { const f = book.buy(c, priceOf(c), at, priceOf, x.info); if (f) this.#event('koop', `${s.name}: ${c} gekocht voor €${f.eur.toFixed(2)} — ${x.info}`, s.id); }
      for (const c of Object.keys(sigs)) sigs[c].held = Boolean(book.pos[c]);
      this.signals[s.id] = sigs;
      const cv = this.curves[s.id], eq = book.equity(priceOf);
      if (!cv.length || at - cv.at(-1).t >= 3600e3) cv.push({ t: at, eq }); else cv[cv.length - 1] = { t: at, eq };
      if (cv.length > 9000) cv.splice(0, cv.length - 9000);
    }
    // backtest dagelijks verversen
    if (!this.btAt || at - this.btAt > 6 * 3600e3) this.runBacktests();
    this.status = this.market.lastError && this.now() - this.market.lastOk > 30 * 60e3 ? `koersdata niet bereikbaar: ${this.market.lastError}` : 'actief';
    this.lastStep = at;
    this.save();
  }

  start(everyMs = 5 * 60e3) {
    const run = async () => { try { await this.step(); } catch (e) { this.status = `fout: ${e.message}`; this.log('fail', `Spot: ${e.message}`); } };
    this.init().catch(e => { this.status = `opstarten mislukt: ${e.message}`; this.log('fail', `Spot: ${e.message}`); })
      .finally(() => { this.timer = setInterval(run, everyMs); });
  }
  stop() { clearInterval(this.timer); try { this.save(); } catch {} }

  reset() {
    for (const s of this.strategies) { this.books[s.id] = new Book(this.startEur, this.coins.length); this.lastBar[s.id] = {}; this.curves[s.id] = []; }
    this.events = []; this.startedAt = this.now();
    this.#event('info', `Spot-portemonnees opnieuw gestart met €${this.startEur} per strategie`);
    this.save();
    return this.step();
  }

  nextBarAt(iv) { const ms = IV_MS[iv]; return Math.floor(this.now() / ms) * ms + ms; }

  snapshot() {
    const priceOf = c => this.market.price(c);
    return {
      status: this.status, ready: this.ready, source: this.market.source, priceSource: this.market.priceSource,
      pricesAt: this.market.pricesAt, lastStep: this.lastStep, startedAt: this.startedAt, startEur: this.startEur, costs: COSTS,
      prices: Object.fromEntries(this.coins.map(c => [c, priceOf(c)])),
      strategies: this.strategies.map(s => {
        const b = this.books[s.id], cv = this.curves[s.id];
        const live = summarize(cv.length ? cv : [{ eq: b.equity(priceOf) }], b.trades, this.startEur);
        return {
          id: s.id, name: s.name, desc: s.desc, interval: s.interval, benchmark: !!s.benchmark, experimental: !!s.experimental,
          nextCheckAt: this.nextBarAt(s.interval),
          live: { ...live, eq: b.equity(priceOf), cash: b.cash, feesPaid: b.feesPaid, curve: cv.filter((_, i, a) => a.length < 400 || i % Math.ceil(a.length / 400) === 0 || i === a.length - 1) },
          positions: Object.entries(b.pos).map(([c, p]) => { const px = priceOf(c) ?? p.entry; return { coin: c, eurIn: p.cost, value: p.qty * px, pnlPct: (px / p.entry - 1) * 100, since: p.at }; }),
          signals: this.signals[s.id] || {},
          trades: b.trades.slice(-50).reverse(),
          backtest: this.bt[s.id] || null,
        };
      }),
      events: this.events.slice(-60).reverse(),
    };
  }
  tradesCsvRows() { return this.strategies.flatMap(s => this.books[s.id].trades.map(t => ({ strategie: s.name, ...t, openedAt: new Date(t.openedAt).toISOString(), closedAt: new Date(t.closedAt).toISOString() }))); }
}
