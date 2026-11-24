// Backtest: signaal op slot van candle t, uitvoering op de opening van candle t+1.
import { Book, summarize } from './sim.js';

export function backtest(strategy, candlesByCoin, btc, { from, startEur = 100, costs } = {}) {
  const coins = Object.keys(candlesByCoin);
  const sig = {}, bars = {};
  for (const c of coins) {
    const cs = candlesByCoin[c];
    sig[c] = new Map(strategy.series(cs, btc).map(x => [x.t, x.on]));
    bars[c] = new Map(cs.map(k => [k.t, k]));
  }
  const timeline = [...new Set(coins.flatMap(c => candlesByCoin[c].map(k => k.t)))].filter(t => t >= from).sort((a, b) => a - b);
  const book = new Book(startEur, coins.length, costs);
  const last = {}; const curve = []; let pending = {};
  for (const t of timeline) {
    // 1) uitvoeren wat gisteren besloten is, tegen de opening van vandaag
    const openOf = c => bars[c].get(t)?.o;
    const ex = strategy.exits;
    if (!ex) for (const [c, want] of Object.entries(pending)) if (!want && book.pos[c] && openOf(c)) book.sell(c, openOf(c), t, 'signaal uit');
    for (const [c, want] of Object.entries(pending)) if (want && !book.pos[c] && openOf(c)) book.buy(c, openOf(c), t, c2 => last[c2], 'signaal aan');
    pending = {};
    // 2) slot van vandaag: koersen + nieuwe signalen
    // vaste uitstap (winst / stop / max tijd) binnen de candle; bij twijfel telt de stop eerst
    if (ex) for (const c of Object.keys(book.pos)) {
      const k = bars[c].get(t), p = book.pos[c]; if (!k) continue;
      const entry = p.entry, sl = entry * (1 - ex.slPct / 100), tp = entry * (1 + ex.tpPct / 100);
      if (k.l <= sl) book.sell(c, Math.min(sl, k.o), t, 'stop');
      else if (k.h >= tp) book.sell(c, Math.max(tp, k.o), t, 'winst');
      else if (t - p.at >= ex.maxHoldH * 3600e3) book.sell(c, k.c, t, 'tijd');
    }
    for (const c of coins) { const k = bars[c].get(t); if (k) last[c] = k.c; const s = sig[c].get(t); if (s !== undefined && s !== null) pending[c] = s; }
    curve.push({ t, eq: book.equity(c => last[c]) });
  }
  return { ...summarize(curve, book.trades, startEur), curve, feesPaid: book.feesPaid, from };
}
