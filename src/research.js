// ONDERZOEKSMODUS — meet ELKE nieuwe pump.fun-token, zonder te handelen.
//
// Per token nemen we op vaste leeftijden (checkpoints) een momentopname van de
// kenmerken, en volgen we daarna 10 minuten wat de prijs doet:
//   • first: raakt de prijs eerst +30% ('up') of eerst −20% ('down')?
//   • maxX / minX: hoogste en laagste punt binnen 10 min (t.o.v. het checkpoint)
//   • x5m / x10m: prijs na 5 en 10 minuten
// Dat levert per dag duizenden voorbeelden op om te leren welke kenmerken écht
// voorspellen dat een token stijgt — in plaats van te gokken met instellingen.
import fs from 'node:fs';
import path from 'node:path';
import { TokenState } from './tracker.js';
import { Engine } from './engine.js';

export const CHECKPOINTS = [30, 60, 120, 300];
const HORIZON = 600_000;
const UP = 1.3, DOWN = 0.8;

export class Research {
  constructor(cfg, { registry, now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.registry = registry;
    this.now = now;
    this.tokens = new Map();     // mint → { t: TokenState, snaps: [] }
    this.file = path.join(cfg.dataDir, 'research.jsonl');
    this.stats = { tokens: 0, snapshots: 0, finished: 0, up: 0, down: 0 };
    this.maxTokens = cfg.researchMaxTokens || 1500;
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    try {
      const n = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      this.stats.finished = n.length;
      for (const l of n.slice(-5000)) { const r = JSON.parse(l); if (r.first === 'up') this.stats.up++; else if (r.first === 'down') this.stats.down++; }
    } catch { /* nog geen bestand */ }
  }

  onRaw(ev) {
    if (ev.kind === 'create') return this.#onCreate(ev);
    if (ev.kind !== 'trade') return;
    const e = this.tokens.get(ev.mint);
    if (!e) return;
    e.t.applyTrade(ev);
    const p = e.t.price;
    for (const s of e.snaps) {
      if (s.done) continue;
      const x = p / s.price;
      if (x > s.maxX) s.maxX = x;
      if (x < s.minX) s.minX = x;
      if (!s.first) { if (x >= UP) s.first = 'up'; else if (x <= DOWN) s.first = 'down'; }
    }
  }

  #onCreate(ev) {
    if (this.tokens.has(ev.mint)) return;
    if (this.tokens.size >= this.maxTokens) {
      // oudste laten vallen (zeldzaam)
      const oldest = this.tokens.keys().next().value;
      this.tokens.delete(oldest);
    }
    const t = new TokenState({ mint: ev.mint, name: ev.name, symbol: ev.symbol || '?', creator: ev.trader, createdAt: ev.ts }, this.cfg);
    t.applyCreate(ev);
    this.tokens.set(ev.mint, {
      t, snaps: [],
      creatorLaunches: this.registry?.creatorLaunches(ev.trader, ev.ts) ?? null,
      symbolLaunches: this.registry?.symbolLaunches(ev.symbol || '?', ev.ts) ?? null,
      devBuyPct: t.pctOfSupply(t.devMaxBalance),
    });
    this.stats.tokens++;
  }

  /** Elke paar seconden aanroepen. */
  tick(now = this.now()) {
    for (const [mint, e] of this.tokens) {
      const age = (now - e.t.createdAt) / 1000;
      // checkpoints nemen
      for (const cp of CHECKPOINTS) {
        if (age >= cp && !e.snaps.some(s => s.cp === cp) && age < cp + 20) {
          const m = e.t.metrics(now);
          e.snaps.push({
            cp, at: now, price: e.t.price, maxX: 1, minX: 1, first: null, done: false,
            f: { ...Engine.features(m), devSoldPct: +m.devSoldPct.toFixed(1), migrated: e.t.migrated,
              creatorLaunches: e.creatorLaunches, symbolLaunches: e.symbolLaunches, devBuyPct: +e.devBuyPct.toFixed(2) },
          });
          this.stats.snapshots++;
        }
      }
      // uitkomsten afronden
      for (const s of e.snaps) {
        if (s.done) continue;
        const dt = now - s.at;
        if (!s.x5m && dt >= 300_000) s.x5m = e.t.price / s.price;
        if (dt >= HORIZON) {
          s.done = true;
          s.x10m = e.t.price / s.price;
          this.#write(mint, e, s);
        }
      }
      // klaar met deze token?
      const last = Math.max(...CHECKPOINTS);
      if (age > last + HORIZON / 1000 + 30 || (age > 120 && e.t.trades.length < 3 && e.snaps.every(s => s.done))) this.tokens.delete(mint);
    }
  }

  #write(mint, e, s) {
    const rec = {
      ts: s.at, mint, symbol: e.t.symbol, cp: s.cp, ...s.f,
      first: s.first || 'none', maxX: +s.maxX.toFixed(3), minX: +s.minX.toFixed(3),
      x5m: s.x5m ? +s.x5m.toFixed(3) : null, x10m: +s.x10m.toFixed(3),
    };
    this.stats.finished++;
    if (rec.first === 'up') this.stats.up++; else if (rec.first === 'down') this.stats.down++;
    fs.appendFile(this.file, JSON.stringify(rec) + '\n', () => {});
  }

  summary() {
    const f = this.stats.finished;
    return { ...this.stats, tracking: this.tokens.size, upRate: f ? this.stats.up / f : 0 };
  }
}
