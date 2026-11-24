// Indicatoren, gelijk aan de Python-backtest (pandas ewm adjust=False, rolling mean).
export function ema(xs, n) {
  const k = 2 / (n + 1), out = new Array(xs.length).fill(null);
  let e = null;
  for (let i = 0; i < xs.length; i++) {
    e = e === null ? xs[i] : xs[i] * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
  }
  return out;
}
export function sma(xs, n) {
  const out = new Array(xs.length).fill(null);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    if (i >= n) s -= xs[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
