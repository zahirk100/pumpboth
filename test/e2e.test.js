// End-to-end: echte Feed-code ↔ mock PumpPortal-server ↔ engine, inclusief herstart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults } from '../src/config.js';
import { Feed } from '../src/feed.js';
import { PaperExecutor } from '../src/executor.js';
import { Reporter } from '../src/reporter.js';
import { Engine } from '../src/engine.js';
import { startMockMarket } from '../src/sim/mockMarket.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SMART = 'DemoSmartMoney11111111111111111111111111111';

function build(cfg) {
  const rep = new Reporter(cfg); rep.quiet = true;
  const feed = new Feed(cfg.feedUrl, { log: () => {} });
  const engine = new Engine(cfg, { feed, executor: new PaperExecutor(cfg), reporter: rep, solPrice: { usd: 140, live: false } });
  return { engine, rep };
}

test('bot draait tegen de feed, boekhouding klopt, staat overleeft herstart', { timeout: 120_000 }, async () => {
  const mock = await startMockMarket({ copyWallets: [SMART], launchEverySec: 0.5 });
  const cfg = {
    ...defaults, demo: true, feedUrl: mock.url, copyWallets: [SMART], latencyMs: 50,
    minAgeSec: 8, minTrades: 15, minUniqueBuyers: 10, maxOpenPositions: 5,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nd-')),
  };
  let { engine, rep } = build(cfg);
  try {
  engine.start();
  await sleep(45_000);

  const c = engine.c;
  assert.equal(engine.strategies.length, 7, 'zeven strategieën');
  assert.ok(c.newPairs > 30, `newPairs ${c.newPairs}`);
  assert.ok(c.trades > 500, `trades ${c.trades}`);
  const sum = k => engine.strategies.reduce((a, s) => a + s.c[k], 0);
  assert.ok(c.scanRejected + sum('botRejected') > 0, 'filters moeten iets weigeren');
  assert.ok(sum('buys') > 0, `buys ${sum('buys')}`);
  const perStrat = engine.strategies.map(s => s.c.buys);
  assert.ok(perStrat.filter(n => n > 0).length >= 2, `meerdere strategieën handelen: ${perStrat}`);
  assert.equal(rep.ring.filter(e => /Interne fout|Onverwachte/.test(e.text)).length, 0);

  // boekhouding per strategie: cash = start + Σ gesloten P/L − Σ inleg open + Σ deelverkopen open − gefaalde tx-kosten
  for (const s of engine.strategies) {
    const P = s.portfolio;
    const closedPnl = P.closed.reduce((a, c) => a + c.pnlSol, 0);
    const open = [...P.positions.values()];
    const expected = P.startBalance + closedPnl - open.reduce((a, p) => a + p.costSol, 0) + open.reduce((a, p) => a + p.realizedSol, 0) - P.failedTxCost;
    assert.ok(Math.abs(P.cash - expected) < 1e-9, `${s.id}: cash ${P.cash} ≠ ${expected}`);
  }

  for (const s of engine.strategies) {
    const snap = engine.snapshot(s.id);
    assert.equal(snap.selected, s.id);
    assert.equal(snap.strategies.length, 7);
    assert.ok(snap.equity > 0);
  }

  // herstart: elke strategie houdt zijn eigen staat
  await sleep(200);
  const before = engine.strategies.map(s => ({ cash: s.portfolio.cash, open: s.portfolio.positions.size, closed: s.portfolio.closed.length }));
  const beforeTrades = engine.c.trades;
  engine.stop();
  ({ engine } = build(cfg));
  engine.start();
  engine.strategies.forEach((s, i) => {
    assert.equal(s.portfolio.cash, before[i].cash, s.id);
    assert.equal(s.portfolio.positions.size, before[i].open, s.id);
    assert.equal(s.portfolio.closed.length, before[i].closed, s.id);
  });
  assert.equal(engine.c.trades, beforeTrades, 'globale tellers hersteld');
  await sleep(3000);
  } finally {
    engine.stop();
    mock.close();
  }
});
