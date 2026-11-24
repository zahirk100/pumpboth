// Koersdata: Bitvavo (EUR, de beurs waar je later live gaat). Reserve: Binance EUR-paren.
// Alleen afgesloten candles tellen mee voor signalen.
import fs from 'node:fs';
import path from 'node:path';

export const IV_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 86400e3 };
const BV = 'https://api.bitvavo.com/v2';
const BN = 'https://data-api.binance.vision/api/v3';

async function getJson(url, fetchFn, timeoutMs = 15000) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

export class Market {
  constructor({ coins, dataDir, fetchFn = globalThis.fetch, log = () => {}, now = () => Date.now() }) {
    this.coins = coins; this.fetch = fetchFn; this.log = log; this.now = now;
    this.dir = dataDir ? path.join(dataDir, 'spot') : null;
    this.candles = new Map();   // key `${coin}|${iv}` → [{t,o,h,l,c}] oplopend, alleen afgesloten
    this.prices = new Map();    // coin → prijs in EUR
    this.source = null; this.lastOk = 0; this.lastError = null;
  }
  key(coin, iv) { return `${coin}|${iv}`; }
  get(coin, iv) { return this.candles.get(this.key(coin, iv)) || []; }

  #file(coin, iv) { return this.dir && path.join(this.dir, `candles-${coin}-${iv}.json`); }
  loadCache(iv) {
    if (!this.dir) return;
    for (const c of this.coins) {
      try { const f = this.#file(c, iv); if (fs.existsSync(f)) this.candles.set(this.key(c, iv), JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
    }
  }
  saveCache(iv) {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    for (const c of this.coins) { const k = this.get(c, iv); if (k.length) fs.writeFileSync(this.#file(c, iv), JSON.stringify(k)); }
  }

  #closed(rows, iv) { const cut = this.now() - IV_MS[iv]; return rows.filter(k => k.t <= cut); }
  #merge(coin, iv, rows) {
    const m = new Map(this.get(coin, iv).map(k => [k.t, k]));
    for (const k of rows) m.set(k.t, k);
    this.candles.set(this.key(coin, iv), [...m.values()].sort((a, b) => a.t - b.t));
  }

  async #bitvavo(coin, iv, start, end) {
    const out = [];
    let e = end;
    for (let page = 0; page < 20; page++) {
      const rows = await getJson(`${BV}/${coin}-EUR/candles?interval=${iv}&limit=1440&start=${start}&end=${e}`, this.fetch);
      if (!Array.isArray(rows)) throw new Error('onverwacht antwoord');
      for (const r of rows) out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] });
      if (rows.length < 1440) break;
      e = Math.min(...rows.map(r => +r[0])) - 1;
    }
    return out;
  }
  async #binance(coin, iv, start, end) {
    const out = [];
    let s = start;
    for (let page = 0; page < 20; page++) {
      const rows = await getJson(`${BN}/klines?symbol=${coin}EUR&interval=${iv}&limit=1000&startTime=${s}&endTime=${end}`, this.fetch);
      if (!Array.isArray(rows)) throw new Error('onverwacht antwoord');
      for (const r of rows) out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] });
      if (rows.length < 1000) break;
      s = +rows[rows.length - 1][0] + 1;
    }
    return out;
  }

  // Haalt ontbrekende candles op vanaf `since` (of vanaf de laatste die we al hebben).
  async refreshCandles(iv, since) {
    const end = this.now();
    let ok = 0;
    for (const coin of this.coins) {
      const have = this.get(coin, iv);
      const start = have.length ? have[have.length - 1].t - IV_MS[iv] * 2 : since;
      let rows = null;
      try { rows = await this.#bitvavo(coin, iv, start, end); this.source = 'Bitvavo'; }
      catch (e) {
        try { rows = await this.#binance(coin, iv, start, end); this.source = 'Binance (reserve)'; this.log('spot', `Bitvavo niet bereikbaar voor ${coin} (${e.message}) — Binance gebruikt`); }
        catch (e2) { this.lastError = `${coin} ${iv}: ${e.message} / ${e2.message}`; continue; }
      }
      this.#merge(coin, iv, this.#closed(rows, iv)); ok++;
    }
    if (ok) this.lastOk = this.now();
    return ok;
  }

  async refreshPrices() {
    try {
      const rows = await getJson(`${BV}/ticker/price`, this.fetch);
      for (const r of rows) { const [b, q] = String(r.market).split('-'); if (q === 'EUR' && this.coins.includes(b)) this.prices.set(b, +r.price); }
      this.priceSource = 'Bitvavo';
    } catch (e) {
      let n = 0;
      for (const c of this.coins) {
        try { const r = await getJson(`${BN}/ticker/price?symbol=${c}EUR`, this.fetch); this.prices.set(c, +r.price); n++; } catch {}
      }
      this.priceSource = n ? 'Binance (reserve)' : null;
      if (!n) this.lastError = `prijzen: ${e.message}`;
    }
    this.pricesAt = this.now();
  }
  price(coin) { return this.prices.get(coin) ?? this.get(coin, '1d').at(-1)?.c ?? null; }
}
