// De dirigent: verbindt feed → agents → executor → portefeuilles → reporter.
//
// Er draaien meerdere STRATEGIEËN tegelijk op dezelfde live data. Elke strategie
// heeft eigen instellingen, een eigen virtueel saldo en eigen statistieken.
// De feed, token-tracking en contract scan worden gedeeld (dus geen extra datakosten).
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { TokenState } from './tracker.js';
import { Registry, scan, fetchSocials } from './agents/contractScan.js';
import { botFilter } from './agents/botFilter.js';
import { momentum } from './agents/momentum.js';
import { sizePosition, DrawdownGuard } from './agents/risk.js';
import { planExit } from './agents/exitPlanner.js';
import { Portfolio } from './portfolio.js';

const short = m => m.slice(0, 4) + '…' + m.slice(-4);
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

class Strategy {
  constructor(def, base, isMain) {
    this.id = def.id;
    this.name = def.name || def.id;
    this.desc = def.desc || '';
    this.isMain = isMain;
    this.copy = def.copy ?? isMain;
    const dataDir = isMain ? base.dataDir : path.join(base.dataDir, `s-${def.id}`);
    this.cfg = { ...base, ...(def.overrides || {}), dataDir };
    this.portfolio = new Portfolio(this.cfg);
    this.st = new Map();         // mint → { status, reason, passed, guardBlocked }
    this.inflight = new Set();
    this.attempts = new Map();
    this.c = { botRejected: 0, momentumRejected: 0, momentumPassed: 0, expired: 0, buys: 0, buyFails: 0, sells: 0, sellFails: 0, guardBlocks: 0, exits: 0 };
    this.reasons = {};
    this.guardStatus = { ok: true };
    this.lastGuardLog = '';
  }
  tag(text) { return this.isMain ? text : `[${this.name}] ${text}`; }
}

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
    this.copySet = new Set(cfg.copyWallets);
    const defs = cfg.strategies?.length ? cfg.strategies : [{ id: 'streng', name: 'Streng' }];
    this.strategies = defs.map((d, i) => new Strategy(d, cfg, i === 0));
    this.main = this.strategies[0];
    this.c = { newPairs: 0, watching: 0, scanRejected: 0, copySignals: 0, trades: 0, untracked: 0, wasted: 0, dead: 0 };
    this.reasons = {};
  }

  // Compatibiliteit: oude code/tests gebruiken engine.portfolio en engine.guard
  get portfolio() { return this.main.portfolio; }
  get guard() { return this.main.guard; }

  // ── opstarten ─────────────────────────────────────────────
  start() {
    for (const s of this.strategies) {
      const P = s.portfolio;
      if (P.load()) {
        if (s.isMain || P.positions.size) this.rep.log('info', s.tag(`Staat hersteld: ${P.cash.toFixed(4)} SOL cash, ${P.positions.size} open posities`));
      } else if (s.isMain) {
        this.rep.log('info', `Nieuw paper-account met ${this.cfg.startBalanceSol} SOL per strategie (${this.strategies.length} strategieën)`);
      }
      s.guard = new DrawdownGuard(s.cfg, P.extra.guard);
      for (const k of Object.keys(s.c)) if (P.extra.counters?.[k] !== undefined) s.c[k] = P.extra.counters[k];
      Object.assign(s.reasons, P.extra.reasons || {});
      if (s.isMain) {
        for (const k of Object.keys(this.c)) {
          const v = P.extra.global?.[k] ?? P.extra.counters?.[k];
          if (v !== undefined) this.c[k] = v;
        }
        Object.assign(this.reasons, P.extra.globalReasons || {});
      }
      // open posities herstellen
      for (const p of P.positions.values()) {
        let t = this.tokens.get(p.mint);
        if (!t) {
          t = new TokenState({ mint: p.mint, symbol: p.symbol, name: p.name, createdAt: p.openedAt, known: false }, this.cfg);
          t.setReserves({ vSol: p.lastVSol, vTokens: p.lastVTokens });
          t.lastTradeAt = Date.now();
          t.status = 'watching';
          this.tokens.set(p.mint, t);
        }
        s.st.set(p.mint, { status: 'entered' });
      }
    }
    this.feed.on('create', ev => this.#safe(() => this.onCreate(ev)));
    this.feed.on('trade', ev => this.#safe(() => this.onTrade(ev)));
    this.feed.on('migration', ev => this.#safe(() => this.onMigration(ev)));
    this.feed.on('status', up => this.rep.log('feed', up ? 'Live datafeed verbonden' : 'Datafeed weggevallen — herverbinden…'));

    const startFeed = () => {
      this.feed.start();
      const open = [...this.tokens.keys()];
      if (open.length) this.feed.watchTokens(open);
      if (this.copySet.size) this.feed.watchAccounts([...this.copySet]);
    };
    const delay = this.cfg.feedStartDelayMs || 0;
    if (delay) {
      this.rep.log('feed', `Wacht ${Math.round(delay / 1000)}s zodat een vorige versie eerst zijn verbinding sluit (PumpPortal staat maar één verbinding toe)`);
      this.feedTimer = setTimeout(startFeed, delay);
    } else startFeed();

    this.tick = setInterval(() => this.#safe(() => this.housekeeping()), 2000);
    this.saveTimer = setInterval(() => this.save(), 15_000);
    this.eqTimer = setInterval(() => { for (const s of this.strategies) s.portfolio.recordEquity(this.equity(s)); }, 10_000);
    for (const s of this.strategies) s.portfolio.recordEquity(this.equity(s));
  }

  stop() {
    clearTimeout(this.feedTimer);
    clearInterval(this.tick); clearInterval(this.saveTimer); clearInterval(this.eqTimer);
    this.feed.stop();
    this.save();
  }

  save() {
    for (const s of this.strategies) {
      const extra = { guard: s.guard?.toJSON(), counters: s.c, reasons: s.reasons };
      if (s.isMain) { extra.global = this.c; extra.globalReasons = this.reasons; }
      s.portfolio.save(extra);
    }
  }

  #safe(fn) {
    try { fn(); } catch (e) { this.rep.log('fail', `Interne fout: ${e.message}`); console.error(e); }
  }

  // ── wie heeft nog interesse in een token? ────────────────
  #interested(t) {
    return this.strategies.some(s => s.portfolio.positions.has(t.mint) || s.inflight.has(t.mint) || s.st.get(t.mint)?.status === 'watching');
  }

  #release(t, now = Date.now()) {
    if (t.status !== 'watching' || this.#interested(t)) return;
    t.status = 'done'; t.doneAt = now;
    this.feed.unwatchTokens([t.mint]);
  }

  #rejectGlobal(t, reason) {
    t.status = 'rejected'; t.reason = reason; t.doneAt = Date.now();
    for (const s of this.strategies) { const st = s.st.get(t.mint); if (st && st.status === 'watching') st.status = 'rejected'; }
    this.c.scanRejected++;
    bump(this.reasons, reason);
    this.feed.unwatchTokens([t.mint]);
    this.rep.log('block', `$${t.symbol} — ${reason}`, { mint: t.mint });
  }

  #rejectFor(s, t, reason, bucket) {
    const st = s.st.get(t.mint);
    if (st) { st.status = 'rejected'; st.reason = reason; }
    s.c[bucket]++;
    bump(s.reasons, reason);
    if (bucket === 'botRejected' && t.loggedBlock !== reason) {
      t.loggedBlock = reason;
      this.rep.log('block', `$${t.symbol} — ${reason}`, { mint: t.mint });
    }
    this.#release(t);
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
    if (!s.ok && s.fatal) {
      // Serial launcher ontdekt? Dan ook zijn eerdere tokens die we nog volgen afschrijven.
      if (s.reason === 'serial launcher') for (const o of this.tokens.values())
        if (o !== t && o.creator === t.creator && o.status === 'watching' && !this.strategies.some(x => x.portfolio.positions.has(o.mint)))
          this.#rejectGlobal(o, 'serial launcher');
      return this.#rejectGlobal(t, s.reason);
    }

    // ruimte maken: oudste token dat niemand vasthoudt laten vallen
    const watching = [...this.tokens.values()].filter(x => x.status === 'watching' && !this.strategies.some(st => st.portfolio.positions.has(x.mint)));
    if (watching.length > this.cfg.maxWatched) {
      const old = watching[0];
      for (const st of this.strategies) { const x = st.st.get(old.mint); if (x?.status === 'watching') x.status = 'expired'; }
      old.status = 'done'; old.doneAt = Date.now();
      this.feed.unwatchTokens([old.mint]);
    }
    const used = this.feed.stats.tradeMsgsToday;
    if (!this.cfg.demo && used >= this.cfg.maxTradeMsgsPerDay) {
      t.status = 'done'; t.doneAt = Date.now(); t.reason = 'databudget op';
      if (!this.budgetWarned) { this.budgetWarned = true; this.rep.log('guard', `Databudget van vandaag op (${used.toLocaleString('nl-NL')} trade-berichten) — tot morgen alleen open posities volgen`); }
      return;
    }
    this.budgetWarned = false;
    for (const st of this.strategies) st.st.set(ev.mint, { status: 'watching' });
    this.feed.watchTokens([ev.mint]);
    if (this.strategies.some(st => st.cfg.requireSocials)) fetchSocials(ev.uri, this.cfg.metadataTimeoutMs).then(v => { t.socials = v; });
  }

  onMigration(ev) {
    const t = this.tokens.get(ev.mint);
    if (!t) return;
    t.migrated = true;
    for (const s of this.strategies) if (s.portfolio.positions.has(ev.mint)) this.evaluateExit(s, t, null);
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
      for (const s of this.strategies) if (s.copy) s.st.set(ev.mint, { status: 'watching' });
      this.feed.watchTokens([ev.mint]);
    }
    if (!t) {
      this.c.untracked++;
      if (!isCopy) this.#stopPaying(ev.mint);
      return;
    }
    // Berichten voor een token waar niemand iets mee doet kosten geld → opnieuw afmelden
    if (!isCopy && t.status !== 'watching') {
      this.c.wasted++;
      this.#stopPaying(ev.mint);
      return;
    }
    t.applyTrade(ev);

    let copyLogged = false;
    for (const s of this.strategies) {
      const pos = s.portfolio.positions.get(ev.mint);
      if (pos) {
        pos.lastVSol = t.vSol; pos.lastVTokens = t.vTokens;
        if (isCopy && ev.side === 'sell' && pos.source === 'copy') { this.#sell(s, t, pos.tokens, 'copy-wallet verkoopt'); continue; }
        this.evaluateExit(s, t, ev);
        continue;
      }
      if (isCopy && ev.side === 'buy' && s.copy && ev.solAmount >= s.cfg.copyMinSol) {
        if (!copyLogged) {
          copyLogged = true; this.c.copySignals++;
          this.rep.log('info', `Copy-signaal: ${short(ev.trader)} koopt $${t.symbol} voor ${ev.solAmount.toFixed(2)} SOL`, { mint: t.mint });
        }
        this.onCopySignal(s, t, ev);
        continue;
      }
      if (s.st.get(ev.mint)?.status === 'watching') this.evaluateEntry(s, t);
    }
  }

  #stopPaying(mint) {
    this.resent ??= new Map();
    const last = this.resent.get(mint) || 0;
    if (Date.now() - last < 10_000) return;
    this.resent.set(mint, Date.now());
    if (this.resent.size > 5000) this.resent.clear();
    this.feed.forceUnwatch(mint);
  }

  // ── COPY TRADER ──────────────────────────────────────────
  onCopySignal(s, t, ev) {
    const m = t.metrics(ev.ts);
    const b = botFilter(t, m, s.cfg);
    if (!b.ok && b.fatal) return s.isMain && this.rep.log('block', `Copy overgeslagen: ${b.reason}`, { mint: t.mint });
    if (m.mcapSol > s.cfg.maxMcapSol * 1.5) return s.isMain && this.rep.log('block', 'Copy overgeslagen: mcap te hoog', { mint: t.mint });
    const g = s.guard.check(this.equity(s), s.portfolio.startBalance, s.portfolio.positions.size + s.inflight.size);
    if (!g.ok) return s.isMain && this.rep.log('block', `Copy overgeslagen: ${g.reason}`, { mint: t.mint });
    this.#enter(s, t, 'copy', null, s.cfg.copySizeFactor);
  }

  // ── CONTRACT SCAN → BOT FILTER → MOMENTUM ────────────────
  evaluateEntry(s, t, now = Date.now()) {
    if (s.inflight.has(t.mint)) return;
    const st = s.st.get(t.mint);
    if (!st || st.status !== 'watching') return;
    const sc = scan(t, this.registry, s.cfg, now);
    if (!sc.ok) { if (sc.fatal) this.#rejectFor(s, t, sc.reason, 'botRejected'); else st.reason = sc.reason; return; }
    const m = t.metrics(now);
    const b = botFilter(t, m, s.cfg);
    if (!b.ok) { if (b.fatal) this.#rejectFor(s, t, b.reason, 'botRejected'); else st.reason = b.reason; return; }
    const mo = momentum(m, s.cfg);
    if (!mo.ok) { if (mo.fatal) this.#rejectFor(s, t, mo.reason, 'momentumRejected'); else st.reason = mo.reason; return; }
    if (!st.passed) { st.passed = true; s.c.momentumPassed++; }
    this.#enter(s, t, 'momentum', mo.score, 1, m);
  }

  // ── SIZER + DRAWDOWN GUARD + EXECUTOR ────────────────────
  #enter(s, t, ...a) { this.#enterImpl(s, t, ...a).catch(e => { s.inflight.delete(t.mint); this.rep.log('fail', `Interne fout bij kopen: ${e.message}`); }); }
  #sell(s, t, ...a) { this.#sellImpl(s, t, ...a).catch(e => { s.inflight.delete(t.mint); this.rep.log('fail', `Interne fout bij verkopen: ${e.message}`); }); }

  async #enterImpl(s, t, source, score, factor, m = t.metrics()) {
    const P = s.portfolio;
    if (s.inflight.has(t.mint) || P.positions.has(t.mint)) return;
    const st = s.st.get(t.mint) || {};
    const eq = this.equity(s);
    const g = s.guard.check(eq, P.startBalance, P.positions.size + s.inflight.size);
    s.guardStatus = g;
    if (!g.ok) {
      if (!st.guardBlocked) { st.guardBlocked = true; s.c.guardBlocks++; }
      st.reason = `wacht: ${g.reason}`;
      if (g.reason !== s.lastGuardLog && g.reason !== 'max posities open') this.rep.log('guard', s.tag(g.reason));
      s.lastGuardLog = g.reason;
      return;
    }
    s.lastGuardLog = '';
    const size = sizePosition(eq, P.cash, s.cfg, factor);
    if (!size) return;
    const n = (s.attempts.get(t.mint) || 0) + 1;
    if (n > 2) return;
    s.attempts.set(t.mint, n);

    s.inflight.add(t.mint);
    st.status = 'buying';
    const res = await this.exec.buy(t, size);
    s.inflight.delete(t.mint);
    if (!res.ok) {
      s.c.buyFails++;
      P.chargeFailed(res.lost);
      st.status = 'watching';
      this.rep.log('fail', s.tag(`Koop $${t.symbol} mislukt: ${res.reason}`), { mint: t.mint, noTg: !s.isMain });
      return;
    }
    s.c.buys++;
    st.status = 'entered';
    const pos = P.open(t, res, { source, score });
    const detail = source === 'copy' ? 'copy trade' :
      `score ${score} · ${m.uniqueBuyers} kopers · ratio ${m.ratio.toFixed(1)} · +${m.netInflow.toFixed(1)} SOL`;
    this.rep.log('buy', s.tag(`$${t.symbol} ${size.toFixed(3)} SOL @ ${(t.mcapSol * this.sol.usd / 1000).toFixed(1)}k mcap · ${detail}`), {
      mint: t.mint, sol: size, posId: pos.id, slip: res.slipPct, strategy: s.id, noTg: !s.isMain,
    });
    this.save();
  }

  // ── EXIT PLANNER ─────────────────────────────────────────
  evaluateExit(s, t, lastTrade, now = Date.now()) {
    const pos = s.portfolio.positions.get(t.mint);
    if (!pos || s.inflight.has(t.mint)) return;
    const d = planExit(pos, t, s.cfg, now, lastTrade);
    if (d) this.#sell(s, t, d.tokens, d.reason, d.nextTpIndex);
  }

  async #sellImpl(s, t, tokensWanted, reason, nextTpIndex) {
    const P = s.portfolio;
    const pos = P.positions.get(t.mint);
    if (!pos || s.inflight.has(t.mint)) return;
    // restje stof meenemen zodat er geen onverkoopbare dust achterblijft
    const tokens = pos.tokens - tokensWanted < pos.initialTokens * 0.02 ? pos.tokens : Math.min(tokensWanted, pos.tokens);
    s.inflight.add(t.mint);
    const res = await this.exec.sell(t, tokens);
    s.inflight.delete(t.mint);
    if (!res.ok) {
      s.c.sellFails++;
      P.chargeFailed(res.lost);
      this.rep.log('fail', s.tag(`Verkoop $${t.symbol} mislukt: ${res.reason} — opnieuw proberen`), { mint: t.mint, noTg: !s.isMain });
      return;
    }
    s.c.sells++;
    if (nextTpIndex !== undefined) pos.tpIndex = nextTpIndex;
    const x = t.price / pos.entryPrice;
    const rec = P.reduce(t.mint, tokens, res, reason);
    if (!rec) {
      this.rep.log('sell', s.tag(`$${t.symbol} deel verkocht (${reason}) +${res.solOut.toFixed(4)} SOL · ${x.toFixed(2)}×`), { mint: t.mint, strategy: s.id, noTg: !s.isMain });
    } else {
      s.c.exits++;
      const st = s.st.get(t.mint); if (st) st.status = 'closed';
      const type = rec.pnlSol >= 0 ? 'sell' : 'stop';
      this.rep.log(type, s.tag(`$${t.symbol} dicht (${reason}) ${rec.pnlSol >= 0 ? '+' : ''}${rec.pnlSol.toFixed(4)} SOL · ${rec.x.toFixed(2)}×`), {
        mint: t.mint, pnl: rec.pnlSol, x: rec.x, strategy: s.id, noTg: !s.isMain,
      });
      if (s.guard.onClosed(rec.pnlSol)) this.rep.log('guard', s.tag(`${s.cfg.lossStreakPause} verliezen op rij — ${s.cfg.lossStreakCooldownMin} min pauze`));
      this.#release(t);
    }
    this.save();
  }

  // ── elke 2 seconden ──────────────────────────────────────
  housekeeping(now = Date.now()) {
    for (const t of this.tokens.values()) {
      const age = (now - t.createdAt) / 1000;
      const held = this.strategies.some(s => s.portfolio.positions.has(t.mint) || s.inflight.has(t.mint));
      if (t.status === 'watching') {
        if (!held && t.known && age > this.cfg.deadAfterSec && t.buyers.size < this.cfg.deadMinBuyers) {
          for (const s of this.strategies) { const st = s.st.get(t.mint); if (st?.status === 'watching') st.status = 'expired'; }
          this.c.dead++;
          bump(this.reasons, 'dood (geen kopers)');
        } else {
          for (const s of this.strategies) {
            const st = s.st.get(t.mint);
            if (!st || st.status !== 'watching' || s.portfolio.positions.has(t.mint)) continue;
            if (age > s.cfg.maxAgeSec) {
              st.status = 'expired'; s.c.expired++;
              bump(s.reasons, st.reason || 'geen signaal');
            } else this.evaluateEntry(s, t, now);
          }
        }
        this.#release(t, now);
      }
      for (const s of this.strategies) if (s.portfolio.positions.has(t.mint)) this.evaluateExit(s, t, null, now);
      if (t.doneAt && now - t.doneAt > 120_000 && !this.strategies.some(s => s.portfolio.positions.has(t.mint))) {
        this.tokens.delete(t.mint);
        for (const s of this.strategies) { s.st.delete(t.mint); s.attempts.delete(t.mint); }
      }
    }
    this.c.watching = [...this.tokens.values()].filter(t => t.status === 'watching').length;
    for (const s of this.strategies) s.guardStatus = s.guard.check(this.equity(s), s.portfolio.startBalance, s.portfolio.positions.size, now);
    if (now % 60_000 < 2000) this.registry.prune(now);
    this.rep.maybeRecap(this.main.portfolio, this.equity(this.main), this.sol.usd, new Date(now), this.strategies.map(s => ({ name: s.name, equity: this.equity(s), start: s.portfolio.startBalance, stats: s.portfolio.stats(now - 24 * 3600_000) })));
  }

  mark(s, pos) {
    const t = this.tokens.get(pos.mint);
    return t ? this.exec.liquidationValue(t, pos.tokens) : 0;
  }

  equity(s = this.main) { return s.portfolio.equity(p => this.mark(s, p)); }

  // ── voor het dashboard ───────────────────────────────────
  #downsample(curve, n = 200) {
    if (curve.length <= n) return curve;
    const step = curve.length / n, out = [];
    for (let i = 0; i < n; i++) out.push(curve[Math.floor(i * step)]);
    out.push(curve[curve.length - 1]);
    return out;
  }

  snapshot(sid) {
    const s = this.strategies.find(x => x.id === sid) || this.main;
    const now = Date.now();
    const eq = this.equity(s);
    const P = s.portfolio;
    const positions = [...P.positions.values()].map(p => {
      const t = this.tokens.get(p.mint);
      const value = this.mark(s, p);
      return {
        id: p.id, mint: p.mint, symbol: p.symbol, source: p.source, openedAt: p.openedAt,
        costSol: p.costSol, realizedSol: p.realizedSol, valueSol: value,
        pnlSol: p.realizedSol + value - p.costSol, x: t ? t.price / p.entryPrice : 1,
        mcapUsd: t ? t.mcapSol * this.sol.usd : 0, tpIndex: p.tpIndex,
        entryPrice: p.entryPrice, series: t ? t.series.slice(-300) : [],
      };
    });
    const watch = [...this.tokens.values()].filter(t => s.st.get(t.mint)?.status === 'watching').slice(-8).map(t => ({
      symbol: t.symbol, mint: t.mint, ageSec: Math.round((now - t.createdAt) / 1000),
      mcapUsd: t.mcapSol * this.sol.usd, buyers: t.buyers.size, waiting: s.st.get(t.mint)?.reason || '…',
    }));
    const reasons = { ...this.reasons };
    for (const [k, v] of Object.entries(s.reasons)) reasons[k] = (reasons[k] || 0) + v;
    const strategies = this.strategies.map(x => {
      const e = this.equity(x);
      return {
        id: x.id, name: x.name, desc: x.desc, equity: e, x: e / x.portfolio.startBalance,
        open: x.portfolio.positions.size, stats: x.portfolio.stats(), guard: x.guardStatus,
        curve: this.#downsample(x.portfolio.equityCurve.slice(-2000)).concat([[now, e]]),
      };
    });
    return {
      now, demo: this.cfg.demo, startedAt: P.startedAt,
      feed: { ...this.feed.stats, subscribed: this.feed.tokens.size },
      solUsd: this.sol.usd, solLive: this.sol.live, feedUp: this.feed.connected,
      selected: s.id, selectedName: s.name, strategies,
      equity: eq, cash: P.cash, startBalance: P.startBalance, feesPaid: P.feesPaid,
      stats: P.stats(), counters: { ...this.c, ...s.c }, guard: s.guardStatus,
      paused: s.guard.manualPause, reasons,
      positions, watch, closed: P.closed.slice(-40).reverse(),
      equityCurve: P.equityCurve.slice(-1500).concat([[now, eq]]),
      log: this.rep.ring.slice(-80).reverse(),
      config: {
        latencyMs: s.cfg.latencyMs, riskPerTradePct: s.cfg.riskPerTradePct, stopLossPct: s.cfg.stopLossPct,
        dailyMaxDrawdownPct: s.cfg.dailyMaxDrawdownPct, takeProfits: s.cfg.takeProfits,
        maxOpenPositions: s.cfg.maxOpenPositions, copyWallets: s.copy ? this.copySet.size : 0,
        minUniqueBuyers: s.cfg.minUniqueBuyers, minMcapSol: s.cfg.minMcapSol, maxMcapSol: s.cfg.maxMcapSol,
        hasFeedKey: Boolean(this.cfg.feedApiKey) || this.cfg.demo || this.cfg.feedMode !== 'pumpportal', maxTradeMsgsPerDay: this.cfg.maxTradeMsgsPerDay,
      },
    };
  }

  setPaused(v) {
    for (const s of this.strategies) s.guard.manualPause = !!v;
    this.rep.log('guard', v ? 'Handmatig gepauzeerd — geen nieuwe trades (exits lopen door)' : 'Hervat');
    this.save();
  }

  resetAccount() {
    for (const s of this.strategies) {
      for (const m of s.portfolio.positions.keys()) s.st.delete(m);
      s.portfolio.reset();
      s.guard = new DrawdownGuard(s.cfg);
      for (const k of Object.keys(s.c)) s.c[k] = 0;
      s.reasons = {};
    }
    for (const k of Object.keys(this.c)) this.c[k] = 0;
    this.reasons = {};
    for (const t of this.tokens.values()) this.#release(t);
    this.rep.log('info', `Alle paper-accounts gereset naar ${this.cfg.startBalanceSol} SOL`);
    this.save();
  }
}
