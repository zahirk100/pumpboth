// MOMENTUM — is er echte, brede vraag? Geeft ook een score (0–100) voor het log.
export function momentum(m, cfg) {
  if (m.ageSec < cfg.minAgeSec) return { ok: false, reason: 'te jong' };
  if (m.uniqueBuyers < cfg.minUniqueBuyers) return { ok: false, reason: 'te weinig kopers' };
  if (m.trades < cfg.minTrades) return { ok: false, reason: 'te weinig trades' };
  if (m.mcapSol < cfg.minMcapSol) return { ok: false, reason: 'mcap te laag' };
  if (m.mcapSol > cfg.maxMcapSol) return { ok: false, fatal: true, reason: 'mcap te hoog (te laat)' };
  if (m.ratio < cfg.minBuySellRatio) return { ok: false, reason: 'te veel verkoopdruk' };
  if (m.netInflow < cfg.minNetInflowSol) return { ok: false, reason: 'te weinig instroom' };
  if (m.drawFromPeakPct > cfg.maxDrawFromPeakPct) return { ok: false, reason: 'al gedumpt van top' };
  // Pomp door 1-2 grote wallets: die verkopen zodra wij (te laat) kopen
  if (m.topBuyerSharePct > cfg.maxTopBuyerSharePct) return { ok: false, reason: 'één wallet pompt' };
  if (m.windowBuyers < Math.min(cfg.minUniqueBuyers, 4)) return { ok: false, reason: 'te weinig recente kopers' };
  // Prijs schoot net omhoog: met onze vertraging kopen we dan de top
  if (m.chasePct > cfg.maxChasePct) return { ok: false, reason: 'te steil (top kopen)' };

  const clamp = x => Math.max(0, Math.min(1, x));
  const score = Math.round(100 * (
    0.3 * clamp(m.uniqueBuyers / (cfg.minUniqueBuyers * 3)) +
    0.3 * clamp(m.ratio / (cfg.minBuySellRatio * 2.5)) +
    0.25 * clamp(m.netInflow / (cfg.minNetInflowSol * 4)) +
    0.15 * clamp(1 - m.top10Pct / cfg.maxTop10Pct)
  ));
  return { ok: true, score };
}
