// EXECUTOR (paper) — doet alsof het een echte Solana-transactie stuurt:
//  • vertraging tussen besluit en landing (prijs beweegt intussen)
//  • slippage-limiet: te ver weggelopen → tx faalt
//  • willekeurige tx-failures, fees ben je dan wel kwijt
//  • pump.fun curve-fee + netwerk/priority fee + Jito-tip
// Prijs wordt berekend met de echte curve-wiskunde op de reserves
// van het moment van landen.
import { quoteBuy, quoteSell } from './curve.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class PaperExecutor {
  constructor(cfg, rng = Math.random) {
    this.cfg = cfg;
    this.rng = rng;
  }

  get txCost() { return this.cfg.txFeeSol + this.cfg.jitoTipSol; }

  async buy(token, solIn) {
    const decisionPrice = token.price;
    await sleep(this.cfg.latencyMs);
    if (this.rng() < this.cfg.txFailRate) return { ok: false, reason: 'tx niet geland', lost: this.cfg.txFeeSol };
    if (token.migrated) return { ok: false, reason: 'token gemigreerd', lost: this.cfg.txFeeSol };
    const q = quoteBuy(token.vSol, token.vTokens, solIn, this.cfg.curveFeePct);
    const fillPrice = solIn / q.tokensOut;
    const slip = (fillPrice / decisionPrice - 1) * 100;
    if (slip > this.cfg.maxSlippagePct) return { ok: false, reason: `slippage ${slip.toFixed(0)}%`, lost: this.cfg.txFeeSol };
    return {
      ok: true, tokens: q.tokensOut, fillPrice, slipPct: slip,
      costSol: solIn + this.txCost, feeSol: q.fee + this.txCost,
    };
  }

  async sell(token, tokens) {
    await sleep(this.cfg.latencyMs);
    if (this.rng() < this.cfg.txFailRate) return { ok: false, reason: 'tx niet geland', lost: this.cfg.txFeeSol };
    const q = quoteSell(token.vSol, token.vTokens, tokens, this.cfg.curveFeePct);
    return { ok: true, solOut: q.solOut - this.txCost, feeSol: q.fee + this.txCost };
  }

  /** Wat levert de positie nu op als je alles verkoopt (na fees)? */
  liquidationValue(token, tokens) {
    if (tokens <= 0) return 0;
    return Math.max(0, quoteSell(token.vSol, token.vTokens, tokens, this.cfg.curveFeePct).solOut - this.txCost);
  }
}
