// CONTRACT SCAN
// Pump.fun-tokens worden door het pump.fun-programma zelf aangemaakt:
// mint- en freeze-authority zijn altijd ingetrokken en er is geen tax.
// De echte risico's zitten daarom bij de MAKER en de METADATA:
//   - serial launchers (zelfde wallet lanceert keer op keer → rug-fabriek)
//   - copycat-tickers (10× "$TRUMP" in een half uur)
//   - geen socials / kapotte metadata
// Plus een sanity check op het mint-adres.

const H = 3600_000;

export class Registry {
  constructor() { this.creators = new Map(); this.symbols = new Map(); }

  #push(map, key, ts) {
    if (!key) return;
    const arr = map.get(key) || [];
    arr.push(ts);
    map.set(key, arr);
  }

  record(token) {
    this.#push(this.creators, token.creator, token.createdAt);
    this.#push(this.symbols, token.symbol.toUpperCase(), token.createdAt);
  }

  count(map, key, windowMs, now) {
    return (map.get(key) || []).filter(t => now - t <= windowMs).length;
  }

  creatorLaunches(c, now = Date.now()) { return this.count(this.creators, c, 6 * H, now); }
  symbolLaunches(s, now = Date.now()) { return this.count(this.symbols, s.toUpperCase(), 0.5 * H, now); }

  prune(now = Date.now()) {
    for (const [map, win] of [[this.creators, 6 * H], [this.symbols, 0.5 * H]]) {
      for (const [k, arr] of map) {
        const keep = arr.filter(t => now - t <= win);
        if (keep.length) map.set(k, keep); else map.delete(k);
      }
    }
  }
}

export function scan(token, registry, cfg, now = Date.now()) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.mint)) return { ok: false, fatal: true, reason: 'ongeldig mint-adres' };
  if (!token.symbol || token.symbol.length > 12) return { ok: false, fatal: true, reason: 'rare ticker' };
  if (token.creator && registry.creatorLaunches(token.creator, now) > cfg.maxCreatorLaunches6h)
    return { ok: false, fatal: true, reason: 'serial launcher' };
  if (registry.symbolLaunches(token.symbol, now) > cfg.maxSameSymbol30m)
    return { ok: false, fatal: true, reason: 'copycat ticker' };
  if (cfg.requireSocials && token.socials === false) return { ok: false, fatal: true, reason: 'geen socials' };
  if (cfg.requireSocials && token.socials === null) return { ok: false, fatal: false, reason: 'metadata laden…' };
  return { ok: true };
}

/** Haalt de metadata-JSON op en kijkt of er socials in staan. */
export async function fetchSocials(uri, timeoutMs) {
  if (!uri || !/^https?:\/\//.test(uri)) return false;
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const j = await res.json();
    const fields = [j.twitter, j.telegram, j.website, j.extensions?.twitter, j.extensions?.telegram, j.extensions?.website];
    return fields.some(v => typeof v === 'string' && /^https?:\/\//.test(v));
  } catch {
    return false;
  }
}
