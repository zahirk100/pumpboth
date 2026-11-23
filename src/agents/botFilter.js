// BOT FILTER — snipers, bundles en dev-gedrag.
// fatal = token definitief afschrijven; anders opnieuw bekijken bij volgende trade.
export function botFilter(token, m, cfg) {
  if (token.known && token.pctOfSupply(token.devMaxBalance) > cfg.maxDevBuyPct)
    return { ok: false, fatal: true, reason: 'dev kocht te veel bij launch' };
  if (m.sniperPct > cfg.maxSniperPct)
    return { ok: false, fatal: true, reason: 'gebundelde launch / snipers' };
  if (m.devSoldPct >= cfg.devSellExitPct)
    return { ok: false, fatal: true, reason: 'dev verkoopt' };
  if (m.devHoldPct > cfg.maxDevHoldPct)
    return { ok: false, fatal: false, reason: 'dev houdt te veel vast' };
  if (m.top10Pct > cfg.maxTop10Pct)
    return { ok: false, fatal: false, reason: 'top-10 te geconcentreerd' };
  return { ok: true };
}
