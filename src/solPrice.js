// SOL/USD — alleen voor weergave. Probeert een paar publieke bronnen.
const SOURCES = [
  ['https://api.coinbase.com/v2/prices/SOL-USD/spot', j => Number(j?.data?.amount)],
  ['https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', j => Number(j?.price)],
  ['https://api.kraken.com/0/public/Ticker?pair=SOLUSD', j => Number(Object.values(j?.result || {})[0]?.c?.[0])],
];

export class SolPrice {
  constructor(fallback, { offline = false } = {}) {
    this.usd = fallback;
    this.live = false;
    this.offline = offline;
  }

  async refresh() {
    if (this.offline) return this.usd;
    for (const [url, pick] of SOURCES) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const v = pick(await res.json());
        if (v > 1 && v < 100000) { this.usd = v; this.live = true; return v; }
      } catch { /* volgende bron */ }
    }
    return this.usd;
  }

  start() { this.refresh(); this.timer = setInterval(() => this.refresh(), 60_000); }
  stop() { clearInterval(this.timer); }
}
