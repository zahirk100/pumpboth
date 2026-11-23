// LANGE-TERMIJN ONDERZOEK — tokens die het chaotische begin overleefd hebben.
//
// Het eerste onderzoek (eerste 15 min van elke token) liet zien dat de prijs daar
// een munt-opgooien is. Hier kijken we naar tokens die al naar PumpSwap gemigreerd
// zijn, of langer dan 15 minuten op de curve actief blijven. Daar is meer liquiditeit,
// minder dev-gedoe en (op PumpSwap) veel lagere fees.
//
// Per actieve token: elke 5 minuten een momentopname met trend- en volumekenmerken
// over 5/15/60 minuten, daarna 60 minuten volgen:
//   • first20: eerst +20% of eerst −10%?   (toevalsniveau: 33%)
//   • first50: eerst +50% of eerst −25%?   (toevalsniveau: 33%)
//   • maxX / minX, x15m, x60m
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60_000;
const SNAP_EVERY = 5 * MIN;
const HORIZON = 60 * MIN;
const KEEP_MIN = 61;                 // candles bewaren
const BRACKETS = [['first20', 1.2, 0.9], ['first50', 1.5, 0.75]];

export class LongResearch {
  constructor(cfg, { now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.tokens = new Map();         // mint → state
    this.birth = new Map();          // mint → createdAt (als we de create zagen)
    this.file = path.join(cfg.dataDir, 'research-long.jsonl');
    this.maxTokens = cfg.longResearchMaxTokens || 3000;
    this.stats = { snapshots: 0, finished: 0, up20: 0, down20: 0, up50: 0, down50: 0 };
    this.buf = [];               // regels bundelen: één schrijfactie per tick
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    try {
      for (const l of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!l) continue;
        const r = JSON.parse(l);
        this.stats.finished++;
        if (r.first20 === 'up') this.stats.up20++; else if (r.first20 === 'down') this.stats.down20++;
        if (r.first50 === 'up') this.stats.up50++; else if (r.first50 === 'down') this.stats.down50++;
      }
    } catch { /* nog geen bestand */ }
  }

  onRaw(ev) {
    if (ev.kind === 'create') { this.birth.set(ev.mint, ev.ts); return; }
    if (ev.kind === 'migration') { this.#state(ev.mint, ev.ts).migratedAt = ev.ts; return; }
    if (ev.kind !== 'trade' || !(ev.vSol > 0 && ev.vTokens > 0)) return;
    const s = this.#state(ev.mint, ev.ts);
    const price = ev.vSol / ev.vTokens;
    s.pool = ev.pool;
    s.price = price;
    s.liqSol = ev.vSol;
    if (ev.mcapSol > 0) s.mcapSol = ev.mcapSol;
    s.lastTrade = ev.ts;
    // 1-minuut candle
    const bucket = Math.floor(ev.ts / MIN) * MIN;
    let c = s.candles[s.candles.length - 1];
    if (!c || c.t !== bucket) {
      c = { t: bucket, o: price, h: price, l: price, c: price, buy: 0, sell: 0, nb: 0, ns: 0, buyers: new Set() };
      s.candles.push(c);
      while (s.candles.length && s.candles[0].t < bucket - KEEP_MIN * MIN) s.candles.shift();
    }
    c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price;
    if (ev.side === 'buy') { c.buy += ev.solAmount; c.nb++; c.buyers.add(ev.trader); } else { c.sell += ev.solAmount; c.ns++; }
    // lopende metingen bijwerken
    for (const sn of s.snaps) {
      const x = price / sn.price;
      if (x > sn.maxX) sn.maxX = x;
      if (x < sn.minX) sn.minX = x;
      for (const [k, up, down] of BRACKETS) if (!sn[k]) { if (x >= up) sn[k] = 'up'; else if (x <= down) sn[k] = 'down'; }
    }
  }

  #state(mint, ts) {
    let s = this.tokens.get(mint);
    if (!s) {
      if (this.tokens.size >= this.maxTokens) this.#evict();
      s = { mint, candles: [], snaps: [], firstSeen: ts, lastTrade: ts, lastSnap: 0, price: 0, pool: 'pump' };
      this.tokens.set(mint, s);
    }
    return s;
  }

  #evict() {
    let oldest = null;
    for (const s of this.tokens.values()) if (!s.snaps.length && (!oldest || s.lastTrade < oldest.lastTrade)) oldest = s;
    if (oldest) this.tokens.delete(oldest.mint);
  }

  /** Kenmerken over de laatste N minuten. */
  #window(s, now, minutes) {
    const from = now - minutes * MIN;
    const cs = s.candles.filter(c => c.t >= from - MIN);
    if (!cs.length) return null;
    let buy = 0, sell = 0, nb = 0, ns = 0, hi = 0, lo = Infinity;
    const buyers = new Set();
    for (const c of cs) { buy += c.buy; sell += c.sell; nb += c.nb; ns += c.ns; hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); c.buyers.forEach(b => buyers.add(b)); }
    return { ret: s.price / cs[0].o - 1, vol: buy + sell, net: buy - sell, ratio: sell > 0 ? buy / sell : (buy > 0 ? 99 : 0), trades: nb + ns, buyers: buyers.size, hi, lo };
  }

  tick(now = this.now()) {
    for (const [mint, s] of this.tokens) {
      const born = this.birth.get(mint);
      const age = born ? (now - born) / MIN : null;
      const eligible = s.pool === 'pump-amm' || (age !== null && age >= 15);
      // nieuwe momentopname?
      if (eligible && now - s.lastSnap >= SNAP_EVERY && now - s.lastTrade < 2 * MIN && s.price > 0) {
        const w5 = this.#window(s, now, 5), w15 = this.#window(s, now, 15), w60 = this.#window(s, now, 60);
        if (w15 && w15.vol >= (this.cfg.longMinVol15Sol ?? 2)) {
          s.lastSnap = now;
          const r = v => (Number.isFinite(v) ? +v.toFixed(4) : null);
          s.snaps.push({
            at: now, price: s.price, maxX: 1, minX: 1,
            f: {
              pool: s.pool, ageMin: age !== null ? +age.toFixed(1) : null,
              sinceMigrationMin: s.migratedAt ? +((now - s.migratedAt) / MIN).toFixed(1) : null,
              mcapSol: r(s.mcapSol), liqSol: r(s.liqSol), historyMin: Math.round((now - s.candles[0].t) / MIN),
              ret5: r(w5?.ret), ret15: r(w15.ret), ret60: r(w60?.ret),
              vol5: r(w5?.vol), vol15: r(w15.vol), vol60: r(w60?.vol),
              net5: r(w5?.net), net15: r(w15.net), ratio15: r(w15.ratio),
              trades15: w15.trades, buyers5: w5?.buyers ?? 0, buyers15: w15.buyers,
              fromHigh60: r(w60 ? s.price / w60.hi - 1 : null), fromLow60: r(w60 ? s.price / w60.lo - 1 : null),
            },
          });
          this.stats.snapshots++;
        }
      }
      // metingen afronden
      for (let i = s.snaps.length - 1; i >= 0; i--) {
        const sn = s.snaps[i], dt = now - sn.at;
        if (!sn.x15m && dt >= 15 * MIN) sn.x15m = s.price / sn.price;
        if (dt >= HORIZON) { sn.x60m = s.price / sn.price; this.#write(s, sn); s.snaps.splice(i, 1); }
      }
      // opruimen: lang stil en niets meer te meten
      if (!s.snaps.length && now - s.lastTrade > 90 * MIN) this.tokens.delete(mint);
    }
    for (const [m, t] of this.birth) if (now - t > 24 * 60 * MIN) this.birth.delete(m);
    this.flush();
  }

  flush() {
    if (!this.buf.length) return;
    fs.appendFile(this.file, this.buf.join(''), () => {});
    this.buf = [];
  }

  #write(s, sn) {
    const rec = {
      ts: sn.at, mint: s.mint, ...sn.f,
      first20: sn.first20 || 'none', first50: sn.first50 || 'none',
      maxX: +sn.maxX.toFixed(3), minX: +sn.minX.toFixed(3),
      x15m: sn.x15m ? +sn.x15m.toFixed(3) : null, x60m: +sn.x60m.toFixed(3),
    };
    const st = this.stats;
    st.finished++;
    if (rec.first20 === 'up') st.up20++; else if (rec.first20 === 'down') st.down20++;
    if (rec.first50 === 'up') st.up50++; else if (rec.first50 === 'down') st.down50++;
    this.buf.push(JSON.stringify(rec) + '\n');
  }

  summary() {
    const st = this.stats;
    const pending = [...this.tokens.values()].reduce((a, s) => a + s.snaps.length, 0);
    const amm = [...this.tokens.values()].filter(s => s.pool === 'pump-amm').length;
    const hit20 = st.up20 + st.down20, hit50 = st.up50 + st.down50;
    return { ...st, tracking: this.tokens.size, amm, pending,
      upShare20: hit20 ? st.up20 / hit20 : null, upShare50: hit50 ? st.up50 / hit50 : null };
  }
}
