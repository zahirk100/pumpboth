// EXIT PLANNER — beslist per positie of (en hoeveel) er verkocht moet worden.
// Geeft { tokens, reason } terug, of null.
export function planExit(pos, token, cfg, now = Date.now(), lastTrade = null) {
  const x = token.price / pos.entryPrice;
  const all = r => ({ tokens: pos.tokens, reason: r });
  pos.peakX = Math.max(pos.peakX || 1, x);

  if (token.migrated) return all('gemigreerd naar AMM');
  if (token.mcapSol >= cfg.completeMcapSol) return all('curve bijna vol');

  // Signalen uit de tradestroom
  if (token.creator && token.devSoldPct() >= cfg.devSellExitPct) return all('dev verkoopt');
  if (lastTrade && lastTrade.side === 'sell' && lastTrade.ts >= pos.openedAt &&
      token.pctOfSupply(lastTrade.tokens) >= cfg.whaleDumpPct) return all('whale dump');

  // Harde stop
  if (x <= 1 - cfg.stopLossPct / 100) return all(`stop −${cfg.stopLossPct}%`);

  // Take-profit ladder (percentages van de oorspronkelijke positie)
  // tpIndex wordt pas opgehoogd als de verkoop echt slaagt (engine doet dat).
  const tps = cfg.takeProfits;
  if (pos.tpIndex < tps.length && x >= tps[pos.tpIndex].x) {
    const tp = tps[pos.tpIndex];
    const tokens = Math.min(pos.tokens, pos.initialTokens * tp.sell / 100);
    return { tokens, reason: `take-profit ${tp.x}×`, nextTpIndex: pos.tpIndex + 1 };
  }

  // Trailing stop na de eerste take-profit
  if (pos.tpIndex > 0 && x <= pos.peakX * (1 - cfg.trailingStopPct / 100)) return all('trailing stop');

  const heldSec = (now - pos.openedAt) / 1000;
  if (heldSec >= cfg.maxHoldMin * 60) return all('max houdtijd');
  if (heldSec >= cfg.stallSec && pos.tpIndex === 0 && x < 1 + cfg.stallMinGainPct / 100) return all('geen momentum');
  if ((now - token.lastTradeAt) / 1000 >= cfg.staleSec) return all('geen handel meer');
  return null;
}
