import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteBuy, quoteSell, priceSol } from '../src/curve.js';
import { normalize } from '../src/feed.js';
import { TokenState } from '../src/tracker.js';
import { botFilter } from '../src/agents/botFilter.js';
import { momentum } from '../src/agents/momentum.js';
import { planExit } from '../src/agents/exitPlanner.js';
import { sizePosition, DrawdownGuard } from '../src/agents/risk.js';
import { Registry, scan } from '../src/agents/contractScan.js';
import { defaults } from '../src/config.js';

const cfg = { ...defaults };
const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

test('curve: kopen en direct verkopen kost ongeveer 2× fee', () => {
  const b = quoteBuy(30, 1_073_000_000, 1, 1.25);
  assert.ok(b.newSol > 30 && b.newTokens < 1_073_000_000);
  assert.ok(priceSol(b.newSol, b.newTokens) > priceSol(30, 1_073_000_000));
  const s = quoteSell(b.newSol, b.newTokens, b.tokensOut, 1.25);
  assert.ok(s.solOut < 1 && s.solOut > 0.97, `terug: ${s.solOut}`);
});

test('feed: normaliseert PumpPortal create/trade/migrate', () => {
  const c = normalize({ signature: 'x', mint: MINT, traderPublicKey: 'dev', txType: 'create', initialBuy: 5e7, solAmount: 1.5,
    vTokensInBondingCurve: 1.02e9, vSolInBondingCurve: 31.5, marketCapSol: 30.9, name: 'Test', symbol: 'TST', uri: 'https://x' });
  assert.equal(c.kind, 'create'); assert.equal(c.vSol, 31.5); assert.equal(c.symbol, 'TST');
  const t = normalize({ signature: 'y', mint: MINT, traderPublicKey: 'a', txType: 'sell', tokenAmount: 1e6, solAmount: 0.03, newTokenBalance: 0,
    vTokensInBondingCurve: 1.02e9, vQuoteInBondingCurve: 31_000_000_000 });
  assert.equal(t.kind, 'trade'); assert.equal(t.side, 'sell'); assert.equal(t.vSol, 31);
  assert.equal(normalize({ signature: 'z', mint: MINT, txType: 'migrate', pool: 'pump-amm' }).kind, 'migration');
  // echt PumpPortal-bericht na migratie (pump-amm): pool-reserves i.p.v. curve-reserves
  const amm = normalize({ signature: 'a', mint: MINT, traderPublicKey: 'x', txType: 'buy', tokenAmount: 1329148.43, solAmount: 0.562,
    tokensInPool: 203303246.012162, solInPool: 68.962173526, marketCapSol: 339.208, pool: 'pump-amm' });
  assert.equal(amm.kind, 'trade'); assert.equal(amm.pool, 'pump-amm');
  assert.ok(Math.abs(amm.vSol / amm.vTokens * 1e9 - 339.2) < 0.1);
  assert.equal(normalize({ message: 'Successfully subscribed' }), null);
});

function token(over = {}) {
  const t = new TokenState({ mint: MINT, symbol: 'TST', creator: 'dev', createdAt: Date.now() - 60_000 }, cfg);
  t.applyCreate({ trader: 'dev', initialBuy: 2e7, vSol: 30.6, vTokens: 1.053e9, ts: t.createdAt });
  return Object.assign(t, over);
}

test('bot filter: dev die >8% koopt wordt geweigerd', () => {
  const t = new TokenState({ mint: MINT, symbol: 'X', creator: 'dev', createdAt: Date.now() }, cfg);
  t.applyCreate({ trader: 'dev', initialBuy: 1.2e8, vSol: 34, vTokens: 9.5e8, ts: Date.now() });
  const r = botFilter(t, t.metrics(), cfg);
  assert.equal(r.ok, false); assert.equal(r.fatal, true);
});

test('bot filter: gemiste bundle-kopen worden uit de reserves afgeleid', () => {
  const t = new TokenState({ mint: MINT, symbol: 'X', creator: 'dev', createdAt: Date.now() }, cfg);
  t.applyCreate({ trader: 'dev', initialBuy: 1e7, vSol: 30.3, vTokens: 1.063e9, ts: Date.now() });
  // eerste trade die we zien: reserves zijn al 200M tokens lager → iemand kocht stil 200M
  t.applyTrade({ trader: 'a', side: 'buy', tokenAmount: 1e6, solAmount: 0.04, vSol: 39, vTokens: 0.862e9, ts: Date.now() + 3000 });
  const m = t.metrics();
  assert.ok(m.sniperPct > 15, `sniperPct ${m.sniperPct}`);
  assert.equal(botFilter(t, m, cfg).reason, 'gebundelde launch / snipers');
});

test('momentum: geeft score bij gezonde flow, weigert bij verkoopdruk', () => {
  const base = { ageSec: 60, uniqueBuyers: 30, trades: 50, mcapSol: 80, ratio: 2.5, netInflow: 6, drawFromPeakPct: 5, top10Pct: 15 };
  const ok = momentum(base, cfg); assert.equal(ok.ok, true); assert.ok(ok.score > 50);
  assert.equal(momentum({ ...base, ratio: 1.1 }, cfg).ok, false);
  assert.equal(momentum({ ...base, mcapSol: 300 }, cfg).fatal, true);
});

test('momentum: weigert whale-pomp en het najagen van een piek', () => {
  const base = { ageSec: 60, uniqueBuyers: 30, trades: 50, mcapSol: 80, ratio: 2.5, netInflow: 6, drawFromPeakPct: 5, top10Pct: 15, topBuyerSharePct: 20, windowBuyers: 20, chasePct: 10 };
  assert.equal(momentum(base, cfg).ok, true);
  assert.equal(momentum({ ...base, topBuyerSharePct: 70 }, cfg).reason, 'één wallet pompt');
  assert.equal(momentum({ ...base, chasePct: 120 }, cfg).reason, 'te steil (top kopen)');
});

test('tracker: meet aandeel grootste koper en recente stijging', () => {
  const t = token();
  const now = Date.now();
  t.trades = [];
  t.applyTrade({ trader: 'w1', side: 'buy', tokenAmount: 1e6, solAmount: 0.1, vSol: 31, vTokens: 1.04e9, ts: now - 20_000 });
  t.applyTrade({ trader: 'whale', side: 'buy', tokenAmount: 1e8, solAmount: 8, vSol: 39, vTokens: 0.83e9, ts: now - 3000 });
  t.applyTrade({ trader: 'w2', side: 'buy', tokenAmount: 1e6, solAmount: 0.2, vSol: 39.2, vTokens: 0.826e9, ts: now - 1000 });
  const m = t.metrics(now);
  assert.ok(m.topBuyerSharePct > 90, `top ${m.topBuyerSharePct}`);
  assert.ok(m.chasePct > 40, `chase ${m.chasePct}`);
});

test('exit planner: stop, take-profit ladder en trailing stop', () => {
  const t = token();
  const pos = { entryPrice: t.price, tokens: 1e6, initialTokens: 1e6, tpIndex: 0, openedAt: Date.now(), peakX: 1 };
  t.price = pos.entryPrice * 0.7;
  assert.match(planExit(pos, t, cfg).reason, /stop/);
  t.price = pos.entryPrice * 2.1;
  const d = planExit(pos, t, cfg);
  assert.equal(d.reason, 'take-profit 2×'); assert.equal(d.tokens, 4e5); assert.equal(d.nextTpIndex, 1);
  pos.tpIndex = 1; pos.tokens = 6e5;
  t.price = pos.entryPrice * 3.5; assert.equal(planExit(pos, t, cfg), null);
  t.price = pos.entryPrice * 2.2; assert.equal(planExit(pos, t, cfg).reason, 'trailing stop');
});

test('exit planner: dev dumpt → direct eruit', () => {
  const t = token();
  const pos = { entryPrice: t.price, tokens: 1e6, initialTokens: 1e6, tpIndex: 0, openedAt: Date.now(), peakX: 1 };
  t.applyTrade({ trader: 'dev', side: 'sell', tokenAmount: 2e7, solAmount: 0.5, newTokenBalance: 0, vSol: 30, vTokens: 1.07e9, ts: Date.now() });
  assert.equal(planExit(pos, t, cfg).reason, 'dev verkoopt');
});

test('sizer en drawdown guard', () => {
  assert.equal(sizePosition(0.5, 0.5, cfg), 0.02);
  assert.equal(sizePosition(0.1, 0.02, cfg), 0); // te weinig cash
  const g = new DrawdownGuard(cfg);
  assert.equal(g.check(1, 1, 0).ok, true);
  assert.match(g.check(0.7, 1, 0).reason, /dagverlies/);
  const g2 = new DrawdownGuard(cfg);
  for (let i = 0; i < 5; i++) g2.onClosed(-0.01);
  assert.match(g2.check(1, 1, 0).reason, /afkoelen/);
  assert.match(new DrawdownGuard(cfg).check(0.3, 1, 0).reason, /gestopt/);
});

test('contract scan: serial launcher en copycat', () => {
  const r = new Registry(), now = Date.now();
  for (let i = 0; i < 3; i++) r.record({ creator: 'dev', symbol: 'AAA', createdAt: now });
  assert.equal(scan({ mint: MINT, symbol: 'AAA', creator: 'dev' }, r, cfg, now).reason, 'serial launcher');
  assert.equal(scan({ mint: MINT, symbol: 'AAA', creator: 'other' }, r, cfg, now).reason, 'copycat ticker');
  assert.equal(scan({ mint: MINT, symbol: 'BBB', creator: 'other' }, r, cfg, now).ok, true);
});
