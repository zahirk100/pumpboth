// Gedeelde boekhouding voor backtest én paper trading: zelfde kosten, zelfde inzetregels.
export const COSTS = { feePct: 0.25, slippagePct: 0.05, minOrderEur: 5 };

export class Book {
  constructor(startEur, nSlots, costs = COSTS) {
    this.start = startEur; this.cash = startEur; this.n = nSlots; this.costs = costs;
    this.pos = {};      // coin → { qty, entry, cost, at }
    this.trades = [];   // afgesloten trades
    this.fills = [];    // alle aan-/verkopen
    this.feesPaid = 0;
  }
  equity(priceOf) { let e = this.cash; for (const [c, p] of Object.entries(this.pos)) e += p.qty * (priceOf(c) ?? p.entry); return e; }
  buy(coin, price, at, priceOf, why = '') {
    if (this.pos[coin] || !(price > 0)) return null;
    const amt = Math.min(this.cash, this.equity(priceOf) / this.n);
    if (amt < this.costs.minOrderEur) return null;
    const px = price * (1 + this.costs.slippagePct / 100), fee = amt * this.costs.feePct / 100;
    const qty = (amt - fee) / px;
    this.cash -= amt; this.feesPaid += fee;
    this.pos[coin] = { qty, entry: px, cost: amt, at };
    const f = { side: 'koop', coin, price: px, eur: amt, fee, at, why };
    this.fills.push(f); return f;
  }
  sell(coin, price, at, why = '') {
    const p = this.pos[coin]; if (!p || !(price > 0)) return null;
    const px = price * (1 - this.costs.slippagePct / 100), gross = p.qty * px, fee = gross * this.costs.feePct / 100;
    const net = gross - fee;
    this.cash += net; this.feesPaid += fee; delete this.pos[coin];
    const t = { coin, entry: p.entry, exit: px, eurIn: p.cost, eurOut: net, pnl: net - p.cost, pnlPct: (net / p.cost - 1) * 100, openedAt: p.at, closedAt: at, why };
    this.trades.push(t);
    this.fills.push({ side: 'verkoop', coin, price: px, eur: net, fee, at, why, pnl: t.pnl });
    return t;
  }
  toJSON() { return { start: this.start, cash: this.cash, n: this.n, pos: this.pos, trades: this.trades, fills: this.fills.slice(-500), feesPaid: this.feesPaid }; }
  static from(o, costs = COSTS) { const b = new Book(o.start, o.n, costs); Object.assign(b, { cash: o.cash, pos: o.pos || {}, trades: o.trades || [], fills: o.fills || [], feesPaid: o.feesPaid || 0 }); return b; }
}

export function summarize(curve, trades, start) {
  let peak = -Infinity, dd = 0;
  for (const p of curve) { peak = Math.max(peak, p.eq); dd = Math.min(dd, p.eq / peak - 1); }
  const last = curve.at(-1)?.eq ?? start;
  const wins = trades.filter(t => t.pnl > 0).length;
  return { eq: last, returnPct: (last / start - 1) * 100, maxDDPct: dd * 100, trades: trades.length, winRatePct: trades.length ? wins / trades.length * 100 : null };
}
