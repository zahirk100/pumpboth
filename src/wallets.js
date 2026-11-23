// SLIMME-WALLET-DETECTOR
// Volgt ALLE wallets die op pump.fun handelen en houdt hun échte resultaat bij:
// per token een 'ronde' (eerste koop → alles verkocht), met gerealiseerde winst,
// houdtijd en hoe oud de token was bij instap.
//
// Wie komt op de ranglijst?  Wallets die aantoonbaar winst maken én niet
//   • de dev zijn (die verdienen aan hun eigen launch),
//   • snipers zijn (kopen in de eerste seconden; dat kunnen wij niet kopiëren),
//   • scalpers van seconden zijn (te snel om met onze vertraging te volgen).
// De beste wallets kopieert de strategie "Smart money" automatisch.
import fs from 'node:fs';
import path from 'node:path';

const HOUR = 3600_000;

export class WalletTracker {
  constructor(cfg, { now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.w = new Map();          // adres → stats
    this.birth = new Map();      // mint → createdAt
    this.creators = new Set();
    this.file = path.join(cfg.dataDir, 'wallets.json');
    this.top = [];
    this.load();
  }

  #get(addr, ts) {
    let w = this.w.get(addr);
    if (!w) { w = { rounds: 0, wins: 0, realized: 0, invested: 0, holdMs: 0, entryAgeMs: 0, lastSeen: ts, open: new Map() }; this.w.set(addr, w); }
    w.lastSeen = ts;
    return w;
  }

  onRaw(ev) {
    if (ev.kind === 'create') {
      this.birth.set(ev.mint, ev.ts);
      if (ev.trader) this.creators.add(ev.trader);
      return;
    }
    if (ev.kind !== 'trade' || !ev.trader || !(ev.tokenAmount > 0)) return;
    const born = this.birth.get(ev.mint);
    if (born === undefined) return;                      // alleen tokens die we zagen ontstaan
    const w = this.#get(ev.trader, ev.ts);
    let pos = w.open.get(ev.mint);
    if (ev.side === 'buy') {
      if (!pos) { pos = { tokens: 0, cost: 0, pnl: 0, firstAt: ev.ts, entryAge: ev.ts - born }; w.open.set(ev.mint, pos); }
      pos.tokens += ev.tokenAmount;
      pos.cost += ev.solAmount;
      w.invested += ev.solAmount;
      return;
    }
    if (!pos || pos.tokens <= 0) return;                 // verkoop zonder bekende koop → negeren
    const sold = Math.min(ev.tokenAmount, pos.tokens);
    const costPart = pos.cost * (sold / pos.tokens);
    const pnl = ev.solAmount - costPart;
    pos.tokens -= sold; pos.cost -= costPart; pos.pnl += pnl;
    w.realized += pnl;
    if (pos.tokens <= 1 || pos.cost < 1e-6) {
      w.rounds++;
      if (pos.pnl > 0) w.wins++;
      w.holdMs += ev.ts - pos.firstAt;
      w.entryAgeMs += pos.entryAge;
      w.open.delete(ev.mint);
    }
  }

  /** Opruimen + ranglijst herberekenen. Elke minuut aanroepen. */
  tick(now = this.now()) {
    for (const [mint, ts] of this.birth) if (now - ts > 6 * HOUR) this.birth.delete(mint);
    for (const [addr, w] of this.w) {
      for (const [mint, p] of w.open) if (now - p.firstAt > 3 * HOUR) w.open.delete(mint);
      if (now - w.lastSeen > 12 * HOUR && w.rounds < 5) this.w.delete(addr);
    }
    if (this.w.size > 300_000) {
      // minst actieve wallets met weinig rondes weggooien
      const drop = [...this.w].filter(([, w]) => w.rounds < 2).sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, this.w.size - 250_000);
      for (const [a] of drop) this.w.delete(a);
    }
    if (this.creators.size > 200_000) this.creators = new Set([...this.creators].slice(-100_000));
    this.top = this.rank(100);
  }

  rank(limit = 100, c = this.cfg) {
    const out = [];
    for (const [addr, w] of this.w) {
      if (w.rounds < c.smartMinRounds) continue;
      if (this.creators.has(addr)) continue;
      const winRate = w.wins / w.rounds;
      const avgHoldSec = w.holdMs / w.rounds / 1000;
      const avgEntrySec = w.entryAgeMs / w.rounds / 1000;
      if (winRate < c.smartMinWinRate || w.realized < c.smartMinProfitSol) continue;
      if (avgEntrySec < c.smartMinEntrySec || avgHoldSec < c.smartMinHoldSec) continue;
      out.push({ addr, rounds: w.rounds, winRate, realized: w.realized, invested: w.invested,
        roi: w.invested > 0 ? w.realized / w.invested : 0, avgHoldSec, avgEntrySec, open: w.open.size });
    }
    // rangschikken op winst per ronde, gewogen naar aantal rondes (meer bewijs = betrouwbaarder)
    out.sort((a, b) => (b.realized / Math.sqrt(b.rounds)) - (a.realized / Math.sqrt(a.rounds)));
    return out.slice(0, limit);
  }

  save() {
    const keep = {};
    for (const [addr, w] of this.w) if (w.rounds >= 3) {
      const { open, ...rest } = w;
      keep[addr] = rest;
    }
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    fs.writeFile(this.file + '.tmp', JSON.stringify({ savedAt: Date.now(), wallets: keep }), err => {
      if (!err) fs.rename(this.file + '.tmp', this.file, () => {});
    });
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [addr, w] of Object.entries(j.wallets || {})) this.w.set(addr, { ...w, open: new Map() });
      this.top = this.rank();
    } catch { /* eerste keer */ }
  }

  summary() {
    let withRounds = 0;
    for (const w of this.w.values()) if (w.rounds > 0) withRounds++;
    return { tracked: this.w.size, withRounds, smart: this.top.length };
  }
}
