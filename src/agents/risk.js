// SIZER + DRAWDOWN GUARD

export function sizePosition(equity, cash, cfg, factor = 1) {
  const reserve = 0.02; // houd altijd wat SOL over voor fees
  let size = equity * (cfg.riskPerTradePct / 100) * factor;
  size = Math.min(size, cfg.maxPositionSol, cash - reserve);
  return size >= cfg.minPositionSol ? +size.toFixed(4) : 0;
}

const dayKey = (ts = Date.now()) => new Date(ts).toLocaleDateString('sv-SE'); // YYYY-MM-DD lokaal

export class DrawdownGuard {
  constructor(cfg, state = {}) {
    this.cfg = cfg;
    this.day = state.day || dayKey();
    this.dayStartEquity = state.dayStartEquity ?? null;
    this.lossStreak = state.lossStreak || 0;
    this.cooldownUntil = state.cooldownUntil || 0;
    this.manualPause = state.manualPause || false;
  }

  toJSON() {
    const { day, dayStartEquity, lossStreak, cooldownUntil, manualPause } = this;
    return { day, dayStartEquity, lossStreak, cooldownUntil, manualPause };
  }

  check(equity, startBalance, openCount, now = Date.now()) {
    const today = dayKey(now);
    if (today !== this.day || this.dayStartEquity === null) { this.day = today; this.dayStartEquity = equity; }
    if (this.manualPause) return { ok: false, reason: 'handmatig gepauzeerd' };
    if (equity < startBalance * this.cfg.hardFloorPct / 100) return { ok: false, reason: `equity onder ${this.cfg.hardFloorPct}% van start — gestopt` };
    const dd = (1 - equity / this.dayStartEquity) * 100;
    if (dd >= this.cfg.dailyMaxDrawdownPct) return { ok: false, reason: `dagverlies ${dd.toFixed(1)}% — pauze tot morgen` };
    if (now < this.cooldownUntil) return { ok: false, reason: `afkoelen na ${this.cfg.lossStreakPause} verliezen` };
    if (openCount >= this.cfg.maxOpenPositions) return { ok: false, reason: 'max posities open' };
    return { ok: true, dd };
  }

  onClosed(pnlSol, now = Date.now()) {
    if (pnlSol < 0) {
      this.lossStreak++;
      if (this.lossStreak >= this.cfg.lossStreakPause) {
        this.cooldownUntil = now + this.cfg.lossStreakCooldownMin * 60_000;
        this.lossStreak = 0;
        return true;
      }
    } else this.lossStreak = 0;
    return false;
  }
}
