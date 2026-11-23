// De dirigent: verbindt feed → agents → executor → portefeuille → reporter.
import { EventEmitter } from 'node:events';
import { TokenState } from './tracker.js';
import { Registry, scan, fetchSocials } from './agents/contractScan.js';
import { botFilter } from './agents/botFilter.js';
import { momentum } from './agents/momentum.js';
import { sizePosition, DrawdownGuard } from './agents/risk.js';
import { planExit } from './agents/exitPlanner.js';
import { Portfolio } from './portfolio.js';

const short = m => m.slice(0, 4) + '…' + m.slice(-4);

export class Engine extends EventEmitter {
  constructor(cfg, { feed, executor, reporter, solPrice }) {
    super();
    this.cfg = cfg;
    this.feed = feed;
    this.exec = executor;
    this.rep = reporter;
    this.sol = solPrice;
    this.tokens = new Map();
    this.registry = new Registry();
    this.portfolio = new Portfolio(cfg);
    this.copySet = new Set(cfg.copyWallets);
    this.inflight = new Set();
    this.attempts = new Map();
    this.c = {
      newPairs: 0, watching: 0, scanRejected: 0, botRejected: 0, momentumRejected: 0,
      momentumPassed: 0, expired: 0, copySignals: 0, buys: 0, buyFails: 0, sells: 0, sellFails: 0,
      guardBlocks: 0, exits: 0, trades: 0,
    };
    this.reasons = {};
    this.guardStatus = { ok: true };
    this.lastGuardLog = '';
  }

  // ── opstarten ─────────────────────────────────────────────
  start() {
    if (this.portfolio.load()) {
      this.rep.log('info', `Staat hersteld: ${this.portfolio.cash.toFixed(4)} SOL cash, ${this.portfolio.positions.size} open posities`);
    } else {
      this.rep.log('info', `Nieuw paper-account met ${this.cfg.startBalanceSol} SOL`);
    }
    this.guard = new DrawdownGuard(this.cfg, this.portfolio.extra.guard);
    Object.assign(this.c, this.portfolio.extra.counters || {});

    // open posities herstellen
    for (const p of this.portfolio.positions.values()) {
      const t = new TokenState({ mint: p.mint, symbol: p.symbol, name: p.name, createdAt: p.openedAt, known: false }, this.cfg);
      t.setReserves({ vSol: p.lastVSol, vTokens: p.lastVTokens });
      t.lastTradeAt = Date.now();
      t.status = 'entered';
      this.tokens.set(p.mint, t);
    }
    this.feed.on('create', ev => this.#safe(() => this.onCreate(ev)));
    this.feed.on('trade', ev => this.#safe(() => this.onTrade(ev)));
    this.feed.on('migration', ev => this.#safe(() => this.onMigration(ev)));
    this.feed.on('status', up => this.rep.log('feed', up ? 'Live datafeed verbonden' : 'Datafeed weggevallen — herverbinden…'));
    this.feed.start();
    if (this.portfolio.positions.size) this.feed.watchTokens([...this.portfolio.positions.keys()]);
    if (this.copySet.size) this.feed.watchAccounts([...this.copySet]);

    this.tick = setInterval(() => this.#safe(() => this.housekeeping()), 2000);
    this.saveTimer = setInterval(() => this.save(), 15_000);
    this.eqTimer = setInterval(() => this.portfolio.recordEquity(this.equity()), 10_000);
    this.portfolio.recordEquity(this.equity());
  }

  stop() {
    clearInterval(this.tick); clearInterval(this.saveTimer); clearInterval(this.eqTimer);
    this.feed.stop();
    this.save();
  }

  save() {
    this.portfolio.save({ guard: this.guard.toJSON(), counters: this.c });
  }

  #safe(fn) {
    try { fn(); } catch (e) { this.rep.log('fail', `Interne fout: ${e.message}`); console.error(e); }
  }

  #reject(token, reason, bucket) {
    token.status = 'rejected';
    token.reason = reason;
    token.doneAt = Date.now();
    this.c[bucket]++;
    this.reasons[reason] = (this.reasons[reason] || 0) + 1;
    this.feed.unwatchTokens([token.mint]);
    if (bucket !== 'momentumRejected') this.rep.log('block', `$${token.symbol} — ${reason}`, { mint: token.mint });
  }

  // ── NEW PAIRS ─────────────────────────────────────────────
  onCreate(ev) {
    this.c.newPairs++;
    if (this.tokens.has(ev.mint)) return;
    const t = new TokenState({ mint: ev.mint, name: ev.name, symbol: ev.symbol || '?', uri: ev.uri, creator: ev.trader, createdAt: ev.ts }, this.cfg);
    t.applyCreate(ev);
    this.registry.record(t);
    this.tokens.set(ev.mint, t);

    const s = scan(t, this.registry, this.cfg, ev.ts);
    if (!s.ok && s.fatal) return this.#reject(t, s.reason, 'scanRejected');

    // ruimte maken: oudste token dat we alleen bekijken laten vallen
    const watching = [...this.tokens.values()].filter(x => x.status === 'watching');
    if (watching.length > this.cfg.maxWatched) {
      const old = watching[0];
      old.status = 'expired'; old.doneAt = Date.now();
      this.feed.unwatchTokens([old.mint]);
    }
    const used = this.feed.stats.tradeMsgsToday;
    if (!this.cfg.demo && used >= this.cfg.maxTradeMsgsPerDay) {
      t.status = 'expired'; t.doneAt = Date.now(); t.reason = 'databudget op';
      if (!this.budgetWarned) { this.budgetWarned = true; this.rep.log('guard', `Databudget van vandaag op (${used.toLocaleString('nl-NL')} trade-berichten) — tot morgen alleen open posities volgen`); }
      return;
    }
    this.budgetWarned = false;
    this.feed.watchTokens([ev.mint]);
    if (this.cfg.requireSocials) fetchSocials(ev.uri, this.cfg.metadataTimeoutMs).then(v => { t.socials = v; });
  }

  onMigration(ev) {
    const t = this.tokens.get(ev.mint);
    if (!t) return;
    t.migrated = true;
    if (this.portfolio.positions.has(ev.mint)) this.evaluateExit(t, null);
  }

  // ── elke trade ───────────────────────────────────────────
  onTrade(ev) {
    this.c.trades++;
    let t = this.tokens.get(ev.mint);
    const isCopy = this.copySet.has(ev.trader);

    if (!t && isCopy) {
      t = new TokenState({ mint: ev.mint, createdAt: ev.ts, known: false }, this.cfg);
      t.status = 'watching';
      this.tokens.set(ev.mint, t);
      this.feed.watchTokens([ev.mint]);
    }
    if (!t) {
      this.c.untracked = (this.c.untracked || 0) + 1;
      return;
    }
    t.applyTrade(ev);

    const pos = this.portfolio.positions.get(ev.mint);
    if (pos) {
      pos.lastVSol = t.vSol; pos.lastVTokens = t.vTokens;
      if (isCopy && ev.side === 'sell' && pos.source === 'copy') return this.#sell(t, pos.tokens, 'copy-wallet verkoopt');
      return this.evaluateExit(t, ev);
    }
    if (isCopy && ev.side === 'buy' && ev.solAmount >= this.cfg.copyMinSol) return this.onCopySignal(t, ev);
    if (t.status === 'watching') this.evaluateEntry(t);
  }

  // ── COPY TRADER ──────────────────────────────────────────
  onCopySignal(t, ev) {
    this.c.copySignals++;
    this.rep.log('info', `Copy-signaal: ${short(ev.trader)} koopt $${t.symbol} voor ${ev.solAmount.toFixed(2)} SOL`, { mint: t.mint });
    const m = t.metrics(ev.ts);
    const b = botFilter(t, m, this.cfg);
    if (!b.ok && b.fatal) return this.rep.log('block', `Copy overgeslagen: ${b.reason}`, { mint: t.mint });
    if (m.mcapSol > this.cfg.maxMcapSol * 1.5) return this.rep.log('block', 'Copy overgeslagen: mcap te hoog', { mint: t.mint });
    const g = this.guard.check(this.equity(), this.portfolio.startBalance, this.portfolio.positions.size + this.inflight.size);
    if (!g.ok) return this.rep.log('block', `Copy overgeslagen: ${g.reason}`, { mint: t.mint });
    this.#enter(t, 'copy', null, this.cfg.copySizeFactor);
  }

  // ── CONTRACT SCAN → BOT FILTER → MOMENTUM ────────────────
  evaluateEntry(t, now = Date.now()) {
    if (this.inflight.has(t.mint)) return;
    const s = scan(t, this.registry, this.cfg, now);
    if (!s.ok) { if (s.fatal) this.#reject(t, s.reason, 'scanRejected'); return; }
    const m = t.metrics(now);
    const b = botFilter(t, m, this.cfg);
    if (!b.ok) { if (b.fatal) this.#reject(t, b.reason, 'botRejected'); else t.reason = b.reason; return; }
    const mo = momentum(m, this.cfg);
    if (!mo.ok) { if (mo.fatal) this.#reject(t, mo.reason, 'momentumRejected'); else t.reason = mo.reason; return; }
    if (!t.passed) { t.passed = true; this.c.momentumPassed++; }
    this.#enter(t, 'momentum', mo.score, 1, m);
  }

  // ── SIZER + DRAWDOWN GUARD + EXECUTOR ────────────────────
  #enter(...a) { this.#enterImpl(...a).catch(e => { this.inflight.delete(a[0].mint); this.rep.log('fail', `Interne fout bij kopen: ${e.message}`); }); }
  #sell(...a) { this.#sellImpl(...a).catch(e => { this.inflight.delete(a[0].mint); this.rep.log('fail', `Interne fout bij verkopen: ${e.message}`); }); }

  async #enterImpl(t, source, score, factor, m = t.metrics()) {
    if (this.inflight.has(t.mint) || this.portfolio.positions.has(t.mint)) return;
    const eq = this.equity();
    const g = this.guard.check(eq, this.portfolio.startBalance, this.portfolio.positions.size + this.inflight.size);
    this.guardStatus = g;
    if (!g.ok) {
      if (!t.guardBlocked) { t.guardBlocked = true; this.c.guardBlocks++; }
      t.reason = `wacht: ${g.reason}`;
      if (g.reason !== this.lastGuardLog && g.reason !== 'max posities open') this.rep.log('guard', g.reason);
      this.lastGuardLog = g.reason;
      return;
    }
    this.lastGuardLog = '';
    const size = sizePosition(eq, this.portfolio.cash, this.cfg, factor);
    if (!size) return;
    const n = (this.attempts.get(t.mint) || 0) + 1;
    if (n > 2) return;
    this.attempts.set(t.mint, n);

    this.inflight.add(t.mint);
    t.status = 'buying';
    const res = await this.exec.buy(t, size);
    this.inflight.delete(t.mint);
    if (!res.ok) {
      this.c.buyFails++;
      this.portfolio.chargeFailed(res.lost);
      t.status = 'watching';
      this.rep.log('fail', `Koop $${t.symbol} mislukt: ${res.reason}`, { mint: t.mint });
      return;
    }
    this.c.buys++;
    t.status = 'entered';
    const pos = this.portfolio.open(t, res, { source, score });
    const detail = source === 'copy' ? 'copy trade' :
      `score ${score} · ${m.uniqueBuyers} kopers · ratio ${m.ratio.toFixed(1)} · +${m.netInflow.toFixed(1)} SOL`;
    this.rep.log('buy', `$${t.symbol} ${size.toFixed(3)} SOL @ ${(t.mcapSol * this.sol.usd / 1000).toFixed(1)}k mcap · ${detail}`, {
      mint: t.mint, sol: size, posId: pos.id, slip: res.slipPct,
    });
    this.save();
  }

  // ── EXIT PLANNER ─────────────────────────────────────────
  evaluateExit(t, lastTrade, now = Date.now()) {
    const pos = this.portfolio.positions.get(t.mint);
    if (!pos || this.inflight.has(t.mint)) return;
    const d = planExit(pos, t, this.cfg, now, lastTrade);
    if (d) this.#sell(t, d.tokens, d.reason, d.nextTpIndex);
  }

  async #sellImpl(t, tokensWanted, reason, nextTpIndex) {
    const pos = this.portfolio.positions.get(t.mint);
    if (!pos || this.inflight.has(t.mint)) return;
    // restje stof meenemen zodat er geen onverkoopbare dust achterblijft
    const tokens = pos.tokens - tokensWanted < pos.initialTokens * 0.02 ? pos.tokens : Math.min(tokensWanted, pos.tokens);
    this.inflight.add(t.mint);
    const res = await this.exec.sell(t, tokens);
    this.inflight.delete(t.mint);
    if (!res.ok) {
      this.c.sellFails++;
      this.portfolio.chargeFailed(res.lost);
      this.rep.log('fail', `Verkoop $${t.symbol} mislukt: ${res.reason} — opnieuw proberen`, { mint: t.mint });
      return;
    }
    this.c.sells++;
    if (nextTpIndex !== undefined) pos.tpIndex = nextTpIndex;
    const x = t.price / pos.entryPrice;
    const rec = this.portfolio.reduce(t.mint, tokens, res, reason);
    if (!rec) {
      this.rep.log('sell', `$${t.symbol} deel verkocht (${reason}) +${res.solOut.toFixed(4)} SOL · ${x.toFixed(2)}×`, { mint: t.mint });
    } else {
      this.c.exits++;
      t.status = 'closed'; t.doneAt = Date.now();
      this.feed.unwatchTokens([t.mint]);
      const type = rec.pnlSol >= 0 ? 'sell' : 'stop';
      this.rep.log(type, `$${t.symbol} dicht (${reason}) ${rec.pnlSol >= 0 ? '+' : ''}${rec.pnlSol.toFixed(4)} SOL · ${rec.x.toFixed(2)}×`, {
        mint: t.mint, pnl: rec.pnlSol, x: rec.x,
      });
      if (this.guard.onClosed(rec.pnlSol)) this.rep.log('guard', `${this.cfg.lossStreakPause} verliezen op rij — ${this.cfg.lossStreakCooldownMin} min pauze`);
    }
    this.save();
  }

  // ── elke 2 seconden ──────────────────────────────────────
  housekeeping(now = Date.now()) {
    for (const t of this.tokens.values()) {
      if (t.status === 'watching' && !this.portfolio.positions.has(t.mint) && (now - t.createdAt) / 1000 > this.cfg.maxAgeSec) {
        t.status = 'expired'; t.doneAt = now; this.c.expired++;
        const r = t.reason || 'geen signaal';
        this.reasons[r] = (this.reasons[r] || 0) + 1;
        this.feed.unwatchTokens([t.mint]);
      } else if (t.status === 'watching' && t.known && (now - t.createdAt) / 1000 > this.cfg.deadAfterSec && t.buyers.size < this.cfg.deadMinBuyers) {
        t.status = 'expired'; t.doneAt = now; this.c.expired++;
        this.reasons['dood (geen kopers)'] = (this.reasons['dood (geen kopers)'] || 0) + 1;
        this.feed.unwatchTokens([t.mint]);
      } else if (t.status === 'watching') {
        this.evaluateEntry(t, now);
      }
      if (this.portfolio.positions.has(t.mint)) this.evaluateExit(t, null, now);
      if (t.doneAt && now - t.doneAt > 120_000 && !this.portfolio.positions.has(t.mint)) this.tokens.delete(t.mint);
    }
    this.c.watching = [...this.tokens.values()].filter(t => t.status === 'watching').length;
    this.guardStatus = this.guard.check(this.equity(), this.portfolio.startBalance, this.portfolio.positions.size, now);
    if (now % 60_000 < 2000) this.registry.prune(now);
    // Elke 10 min: komen er vooral trades binnen voor tokens die we hebben afgemeld?
    if (!this.chk || now - this.chk.ts > 600_000) {
      if (this.chk) {
        const tr = this.c.trades - this.chk.trades, un = (this.c.untracked || 0) - this.chk.untracked;
        if (tr > 2000 && un / tr > 0.5 && now - (this.warnedUnsub || 0) > 3600_000) {
          this.warnedUnsub = now;
          this.rep.log('feed', `Let op: ${Math.round(un / tr * 100)}% van de trades is voor tokens die we niet meer volgen — afmelden bij de feed werkt mogelijk niet.`);
        }
      }
      this.chk = { ts: now, trades: this.c.trades, untracked: this.c.untracked || 0 };
    }
    this.rep.maybeRecap(this.portfolio, this.equity(), this.sol.usd);
  }

  mark(pos) {
    const t = this.tokens.get(pos.mint);
    return t ? this.exec.liquidationValue(t, pos.tokens) : 0;
  }

  equity() { return this.portfolio.equity(p => this.mark(p)); }

  // ── voor het dashboard ───────────────────────────────────
  snapshot() {
    const now = Date.now();
    const eq = this.equity();
    const P = this.portfolio;
    const positions = [...P.positions.values()].map(p => {
      const t = this.tokens.get(p.mint);
      const value = this.mark(p);
      return {
        id: p.id, mint: p.mint, symbol: p.symbol, source: p.source, openedAt: p.openedAt,
        costSol: p.costSol, realizedSol: p.realizedSol, valueSol: value,
        pnlSol: p.realizedSol + value - p.costSol, x: t ? t.price / p.entryPrice : 1,
        mcapUsd: t ? t.mcapSol * this.sol.usd : 0, tpIndex: p.tpIndex,
        entryPrice: p.entryPrice, series: t ? t.series.slice(-300) : [],
      };
    });
    const watch = [...this.tokens.values()].filter(t => t.status === 'watching').slice(-8).map(t => ({
      symbol: t.symbol, mint: t.mint, ageSec: Math.round((now - t.createdAt) / 1000),
      mcapUsd: t.mcapSol * this.sol.usd, buyers: t.buyers.size, waiting: t.reason || '…',
    }));
    return {
      now, demo: this.cfg.demo, startedAt: P.startedAt,
      feed: { ...this.feed.stats, subscribed: this.feed.tokens.size },
      solUsd: this.sol.usd, solLive: this.sol.live, feedUp: this.feed.connected,
      equity: eq, cash: P.cash, startBalance: P.startBalance, feesPaid: P.feesPaid,
      stats: P.stats(), counters: this.c, guard: this.guardStatus,
      paused: this.guard.manualPause, reasons: this.reasons,
      positions, watch, closed: P.closed.slice(-40).reverse(),
      equityCurve: P.equityCurve.slice(-1500).concat([[now, eq]]),
      log: this.rep.ring.slice(-80).reverse(),
      config: {
        latencyMs: this.cfg.latencyMs, riskPerTradePct: this.cfg.riskPerTradePct, stopLossPct: this.cfg.stopLossPct,
        dailyMaxDrawdownPct: this.cfg.dailyMaxDrawdownPct, takeProfits: this.cfg.takeProfits,
        maxOpenPositions: this.cfg.maxOpenPositions, copyWallets: this.copySet.size,
        hasFeedKey: Boolean(this.cfg.feedApiKey) || this.cfg.demo, maxTradeMsgsPerDay: this.cfg.maxTradeMsgsPerDay,
      },
    };
  }

  setPaused(v) {
    this.guard.manualPause = !!v;
    this.rep.log('guard', v ? 'Handmatig gepauzeerd — geen nieuwe trades (exits lopen door)' : 'Hervat');
    this.save();
  }

  resetAccount() {
    for (const m of this.portfolio.positions.keys()) this.feed.unwatchTokens([m]);
    this.portfolio.reset();
    this.guard = new DrawdownGuard(this.cfg);
    for (const k of Object.keys(this.c)) this.c[k] = 0;
    this.reasons = {};
    this.rep.log('info', `Paper-account gereset naar ${this.cfg.startBalanceSol} SOL`);
    this.save();
  }
}
