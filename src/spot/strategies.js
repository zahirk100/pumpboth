// Strategieën voor de grote coins. Elke strategie geeft per markt per (afgesloten) candle aan
// of je erin wilt zitten (on) plus een korte uitleg. Backtest en paper trading gebruiken
// precies dezelfde functie, zodat wat je in de backtest ziet ook live gebeurt.
import { ema, sma } from './indicators.js';

export const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT'];

const pct = (a, b) => (a / b - 1) * 100;

function emaCross(candles, f, s) {
  const c = candles.map(k => k.c), ef = ema(c, f), es = ema(c, s);
  return candles.map((k, i) => es[i] === null ? { t: k.t, on: null } :
    { t: k.t, on: ef[i] > es[i], v: pct(ef[i], es[i]), info: `EMA${f} ${ef[i] > es[i] ? 'boven' : 'onder'} EMA${s} (${pct(ef[i], es[i]).toFixed(1)}%)` });
}
function btcRegime(btc, n) {
  const c = btc.map(k => k.c), m = sma(c, n), map = new Map();
  btc.forEach((k, i) => { if (m[i] !== null) map.set(k.t, { on: c[i] > m[i], v: pct(c[i], m[i]) }); });
  return map;
}

export const STRATEGIES = [
  { id: 'hold', name: 'Vasthouden', interval: '1d', benchmark: true,
    desc: 'Maatstaf: koopt alle 10 coins één keer en houdt ze vast.',
    series: (cs) => cs.map(k => ({ t: k.t, on: true, info: 'altijd in bezit' })) },
  { id: 'ema', name: 'EMA 10/30', interval: '1d',
    desc: 'Koopt een coin als zijn trend omhoog draait (EMA10 boven EMA30), verkoopt als die omdraait.',
    series: (cs) => emaCross(cs, 10, 30) },
  { id: 'btc', name: 'BTC-filter', interval: '1d',
    desc: 'Alle coins in bezit zolang Bitcoin boven zijn 50-daags gemiddelde staat, anders alles in euro.',
    series: (cs, btc) => { const m = btcRegime(btc, 50); return cs.map(k => { const r = m.get(k.t); return r ? { t: k.t, on: r.on, v: r.v, info: `BTC ${r.v >= 0 ? '+' : ''}${r.v.toFixed(1)}% t.o.v. 50-daags gem.` } : { t: k.t, on: null }; }); } },
  { id: 'combo', name: 'EMA + BTC-filter', interval: '1d',
    desc: 'Alleen kopen als de coin-trend omhoog is én Bitcoin boven zijn 50-daags gemiddelde staat.',
    series: (cs, btc) => { const m = btcRegime(btc, 50), e = emaCross(cs, 10, 30);
      return e.map(x => { const r = m.get(x.t); if (x.on === null || !r) return { t: x.t, on: null };
        return { t: x.t, on: x.on && r.on, v: Math.min(x.v, r.v), info: `${x.info} · BTC ${r.on ? 'boven' : 'onder'} gem.` }; }); } },
  { id: 'ema4h', name: 'EMA 20/60 · 4 uur', interval: '4h', experimental: true,
    desc: 'Experiment: sneller, kijkt elke 4 uur. Meer trades, maar in de backtest niet beter dan vasthouden.',
    series: (cs) => emaCross(cs, 20, 60) },
];
