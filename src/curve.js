// Pump.fun bonding curve = constant product op virtuele reserves.
//   k = vSol * vTokens
// Fee wordt over de SOL-kant gerekend.

export function priceSol(vSol, vTokens) {
  return vTokens > 0 ? vSol / vTokens : 0;
}

/** Hoeveel tokens krijg je voor `solIn` (incl. fee)? */
export function quoteBuy(vSol, vTokens, solIn, feePct) {
  const net = solIn / (1 + feePct / 100);
  const k = vSol * vTokens;
  const newSol = vSol + net;
  const tokensOut = vTokens - k / newSol;
  return { tokensOut, fee: solIn - net, newSol, newTokens: vTokens - tokensOut };
}

/** Hoeveel SOL krijg je voor `tokensIn` (na fee)? */
export function quoteSell(vSol, vTokens, tokensIn, feePct) {
  if (tokensIn <= 0) return { solOut: 0, fee: 0, newSol: vSol, newTokens: vTokens };
  const k = vSol * vTokens;
  const newTokens = vTokens + tokensIn;
  const gross = vSol - k / newTokens;
  const fee = gross * feePct / 100;
  return { solOut: gross - fee, fee, newSol: vSol - gross, newTokens };
}
