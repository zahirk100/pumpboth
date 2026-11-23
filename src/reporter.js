// REPORTER — nachtlog (bestand + dashboard + console), Telegram-meldingen
// en een dagelijkse samenvatting.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const COLORS = { buy: 32, sell: 36, stop: 31, block: 90, fail: 33, guard: 35, feed: 34, info: 37 };

export class Reporter extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ring = [];
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    this.file = path.join(cfg.dataDir, 'log.jsonl');
    this.tgQueue = [];
    this.tgBusy = false;
    this.lastRecapDay = null;
    this.quiet = false;
  }

  log(type, text, data = {}) {
    const ev = { ts: Date.now(), type, text, ...data };
    this.ring.push(ev);
    if (this.ring.length > 300) this.ring.shift();
    fs.appendFile(this.file, JSON.stringify(ev) + '\n', () => {});
    if (!this.quiet && type !== 'block') {
      const t = new Date(ev.ts).toLocaleTimeString('nl-NL');
      console.log(`\x1b[90m${t}\x1b[0m \x1b[${COLORS[type] || 37}m${type.toUpperCase().padEnd(5)}\x1b[0m ${text}`);
    }
    this.emit('log', ev);
    if (this.cfg.telegramTradeAlerts && ['buy', 'sell', 'stop', 'guard'].includes(type)) this.telegram(`${type.toUpperCase()} · ${text}`);
    return ev;
  }

  telegram(text) {
    if (!this.cfg.telegramToken || !this.cfg.telegramChatId) return;
    this.tgQueue.push(text);
    this.#drain();
  }

  async #drain() {
    if (this.tgBusy) return;
    this.tgBusy = true;
    while (this.tgQueue.length) {
      const text = this.tgQueue.shift();
      try {
        await fetch(`https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text: `🌙 ${text}`, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(8000),
        });
      } catch { /* Telegram mag de bot nooit laten crashen */ }
      await new Promise(r => setTimeout(r, 1100));
    }
    this.tgBusy = false;
  }

  /** Eén keer per dag rond recapHour. */
  maybeRecap(portfolio, equity, solUsd, now = new Date()) {
    const day = now.toLocaleDateString('sv-SE');
    if (now.getHours() !== this.cfg.recapHour || this.lastRecapDay === day) return null;
    this.lastRecapDay = day;
    const s = portfolio.stats(now.getTime() - 24 * 3600_000);
    const lines = [
      `Recap afgelopen 24u${this.cfg.demo ? ' (DEMO)' : ''}`,
      `Equity: ${equity.toFixed(3)} SOL (~$${(equity * solUsd).toFixed(0)}) · ${(equity / portfolio.startBalance).toFixed(2)}× van start`,
      `Trades: ${s.trades} · ${s.wins}W/${s.losses}L · winrate ${s.winRate.toFixed(0)}%`,
      `Netto: ${s.netSol >= 0 ? '+' : ''}${s.netSol.toFixed(4)} SOL · profit factor ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}`,
      `Beste trade: ${s.bestX.toFixed(2)}× · max drawdown ${s.maxDrawdownPct.toFixed(1)}%`,
    ];
    const text = lines.join('\n');
    this.log('info', text.replace(/\n/g, ' · '));
    this.telegram(text);
    return text;
  }
}
