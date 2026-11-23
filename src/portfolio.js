// Virtuele portefeuille met persistente opslag (data/state.json).
import fs from 'node:fs';
import path from 'node:path';

export class Portfolio {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'state.json');
    this.startBalance = cfg.startBalanceSol;
    this.cash = cfg.startBalanceSol;
    this.positions = new Map();
    this.closed = [];
    this.equityCurve = [];
    this.feesPaid = 0;
    this.failedTxCost = 0;
    this.startedAt = Date.now();
    this.extra = {};
    this.seq = 0;
  }

  load() {
    if (!fs.existsSync(this.file)) return false;
    const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    Object.assign(this, {
      startBalance: s.startBalance, cash: s.cash, closed: s.closed || [],
      equityCurve: s.equityCurve || [], feesPaid: s.feesPaid || 0,
      failedTxCost: s.failedTxCost || 0, startedAt: s.startedAt || Date.now(),
      extra: s.extra || {}, seq: s.seq || 0,
    });
    this.positions = new Map((s.positions || []).map(p => [p.mint, p]));
    return true;
  }

  save(extra = this.extra) {
    this.extra = extra;
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      startBalance: this.startBalance, cash: this.cash, positions: [...this.positions.values()],
      closed: this.closed, equityCurve: this.equityCurve, feesPaid: this.feesPaid,
      failedTxCost: this.failedTxCost, startedAt: this.startedAt, extra, seq: this.seq,
    }));
    fs.renameSync(tmp, this.file);
  }

  reset() {
    this.cash = this.startBalance = this.cfg.startBalanceSol;
    this.positions.clear(); this.closed = []; this.equityCurve = [];
    this.feesPaid = 0; this.failedTxCost = 0; this.startedAt = Date.now(); this.extra = {};
  }

  chargeFailed(sol) { this.cash -= sol; this.failedTxCost += sol; this.feesPaid += sol; }

  open(token, fill, meta) {
    this.cash -= fill.costSol;
    this.feesPaid += fill.feeSol;
    const pos = {
      id: ++this.seq, mint: token.mint, symbol: token.symbol, name: token.name,
      openedAt: Date.now(), entryPrice: fill.fillPrice, entryMcapSol: token.mcapSol,
      costSol: fill.costSol, initialTokens: fill.tokens, tokens: fill.tokens,
      realizedSol: 0, tpIndex: 0, peakX: 1, source: meta.source, score: meta.score ?? null,
      lastVSol: token.vSol, lastVTokens: token.vTokens, exits: [],
    };
    this.positions.set(token.mint, pos);
    return pos;
  }

  /** Verkoop een deel; geeft het gesloten trade-record terug als de positie dicht is. */
  reduce(mint, tokens, res, reason) {
    const pos = this.positions.get(mint);
    if (!pos) return null;
    this.cash += res.solOut;
    this.feesPaid += res.feeSol;
    pos.tokens = Math.max(0, pos.tokens - tokens);
    pos.realizedSol += res.solOut;
    pos.exits.push({ ts: Date.now(), tokens, sol: res.solOut, reason });
    if (pos.tokens > pos.initialTokens * 0.001) return null;
    this.positions.delete(mint);
    const rec = {
      id: pos.id, mint, symbol: pos.symbol, source: pos.source, openedAt: pos.openedAt, closedAt: Date.now(),
      costSol: pos.costSol, returnSol: pos.realizedSol, pnlSol: pos.realizedSol - pos.costSol,
      x: pos.realizedSol / pos.costSol, peakX: pos.peakX, exitReason: reason,
      exits: pos.exits.map(e => e.reason),
    };
    this.closed.push(rec);
    return rec;
  }

  equity(markFn) {
    let v = this.cash;
    for (const p of this.positions.values()) v += markFn(p);
    return v;
  }

  recordEquity(eq, now = Date.now()) {
    this.equityCurve.push([now, +eq.toFixed(6)]);
    if (this.equityCurve.length > 6000) {
      // halveer resolutie van de oudste helft
      const half = this.equityCurve.length / 2;
      this.equityCurve = this.equityCurve.slice(0, half).filter((_, i) => i % 2 === 0).concat(this.equityCurve.slice(half));
    }
  }

  stats(since = 0) {
    const t = this.closed.filter(c => c.closedAt >= since);
    const wins = t.filter(c => c.pnlSol > 0), losses = t.filter(c => c.pnlSol <= 0);
    const sum = a => a.reduce((s, c) => s + c.pnlSol, 0);
    const gw = sum(wins), gl = -sum(losses);
    let peak = this.startBalance, maxDD = 0;
    for (const [, e] of this.equityCurve) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, (1 - e / peak) * 100); }
    return {
      trades: t.length, wins: wins.length, losses: losses.length,
      winRate: t.length ? (wins.length / t.length) * 100 : 0,
      avgWinSol: wins.length ? gw / wins.length : 0,
      avgLossSol: losses.length ? -gl / losses.length : 0,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      expectancySol: t.length ? (gw - gl) / t.length : 0,
      netSol: gw - gl,
      bestX: t.reduce((m, c) => Math.max(m, c.x), 0),
      maxDrawdownPct: maxDD,
    };
  }
}
