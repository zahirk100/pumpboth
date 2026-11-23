// Houdt per token alles bij wat we uit de tradestroom kunnen afleiden:
// prijs, holders, snipers, dev-gedrag en flow.
import { priceSol } from './curve.js';

export class TokenState {
  constructor({ mint, name = '', symbol = '?', uri = '', creator = '', createdAt = Date.now(), known = true }, cfg) {
    this.cfg = cfg;
    this.mint = mint;
    this.name = name;
    this.symbol = symbol;
    this.uri = uri;
    this.creator = creator;
    this.createdAt = createdAt;
    this.known = known;               // false = we zagen de create niet (bijv. copy trade)
    this.vSol = 30; this.vTokens = 1_073_000_000;
    this.price = priceSol(this.vSol, this.vTokens);
    this.peakPrice = this.price;
    this.mcapSol = this.price * cfg.tokenSupply;
    this.lastTradeAt = createdAt;
    this.trades = [];
    this.holders = new Map();
    this.buyers = new Set();
    this.snipers = new Set();
    this.devMaxBalance = 0;
    this.devSold = 0;
    this.status = 'watching';
    this.reason = '';
    this.socials = null;
    this.series = [];
    this.migrated = false;
    this.createVTokens = 0;   // reserves direct na de create (incl. dev-buy)
    this.unseenEarly = 0;     // tokens gekocht vóór ons abonnement actief was (vaak bundles)
    this.firstTradeSeen = false;
  }

  setReserves(ev) {
    if (ev.vSol > 0 && ev.vTokens > 0) {
      this.vSol = ev.vSol; this.vTokens = ev.vTokens;
      this.price = priceSol(ev.vSol, ev.vTokens);
      this.mcapSol = ev.mcapSol > 0 ? ev.mcapSol : this.price * this.cfg.tokenSupply;
    }
    if (this.price > this.peakPrice) this.peakPrice = this.price;
  }

  applyCreate(ev) {
    this.setReserves(ev);
    this.peakPrice = this.price;
    this.createVTokens = ev.vTokens || 0;
    if (ev.initialBuy > 0) {
      this.holders.set(ev.trader, ev.initialBuy);
      this.devMaxBalance = ev.initialBuy;
    }
    this.#point(ev.ts);
  }

  applyTrade(ev) {
    if (ev.pool && ev.pool !== 'pump') this.migrated = true;
    if (!this.firstTradeSeen) {
      this.firstTradeSeen = true;
      if (this.known && this.createVTokens > 0 && ev.vTokens > 0) {
        // reserves vóór deze trade terugrekenen; het verschil met de create = trades die we misten
        const pre = ev.side === 'buy' ? ev.vTokens + ev.tokenAmount : ev.vTokens - ev.tokenAmount;
        this.unseenEarly = Math.max(0, this.createVTokens - pre);
      }
    }
    this.setReserves(ev);
    this.lastTradeAt = ev.ts;
    const tokens = ev.tokenAmount;
    const prev = this.holders.get(ev.trader) || 0;
    let bal = ev.newTokenBalance;
    if (bal === undefined || Number.isNaN(bal)) bal = Math.max(0, prev + (ev.side === 'buy' ? tokens : -tokens));
    if (bal > 0) this.holders.set(ev.trader, bal); else this.holders.delete(ev.trader);

    if (ev.side === 'buy') {
      this.buyers.add(ev.trader);
      if (this.known && ev.ts - this.createdAt <= this.cfg.bundleWindowMs && ev.trader !== this.creator) this.snipers.add(ev.trader);
    }
    if (ev.trader && ev.trader === this.creator) {
      this.devMaxBalance = Math.max(this.devMaxBalance, bal);
      if (ev.side === 'sell') this.devSold += tokens;
    }
    this.trades.push({ ts: ev.ts, side: ev.side, sol: ev.solAmount, tokens, trader: ev.trader, price: this.price });
    if (this.trades.length > 600) this.trades.splice(0, 100);
    this.#point(ev.ts);
  }

  #point(ts) {
    const last = this.series[this.series.length - 1];
    if (last && ts - last[0] < 1000) last[1] = this.price;
    else this.series.push([ts, this.price]);
    if (this.series.length > 1500) this.series.splice(0, 300);
  }

  pctOfSupply(tokens) { return (tokens / this.cfg.tokenSupply) * 100; }

  devSoldPct() { return this.devMaxBalance > 0 ? (this.devSold / this.devMaxBalance) * 100 : 0; }

  metrics(now = Date.now()) {
    const win = this.cfg.windowSec * 1000;
    let buySol = 0, sellSol = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i];
      if (now - t.ts > win) break;
      if (t.side === 'buy') buySol += t.sol; else sellSol += t.sol;
    }
    const balances = [...this.holders.values()].sort((a, b) => b - a);
    const top10 = balances.slice(0, 10).reduce((a, b) => a + b, 0);
    let sniperTokens = 0;
    for (const s of this.snipers) sniperTokens += this.holders.get(s) || 0;
    return {
      ageSec: (now - this.createdAt) / 1000,
      trades: this.trades.length,
      uniqueBuyers: this.buyers.size,
      buySol, sellSol,
      ratio: sellSol > 0 ? buySol / sellSol : (buySol > 0 ? 99 : 0),
      netInflow: buySol - sellSol,
      mcapSol: this.mcapSol,
      top10Pct: this.pctOfSupply(top10),
      devHoldPct: this.pctOfSupply(this.holders.get(this.creator) || 0),
      sniperPct: this.pctOfSupply(sniperTokens + this.unseenEarly),
      snipers: this.snipers.size,
      drawFromPeakPct: this.peakPrice > 0 ? (1 - this.price / this.peakPrice) * 100 : 0,
      devSoldPct: this.devSoldPct(),
    };
  }
}
