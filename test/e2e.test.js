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
  engine.start();
  await sleep(45_000);

  const c = engine.c;
  assert.ok(c.newPairs > 30, `newPairs ${c.newPairs}`);
  assert.ok(c.trades > 500, `trades ${c.trades}`);
  assert.ok(c.scanRejected + c.botRejected > 0, 'filters moeten iets weigeren');
  assert.ok(c.buys > 0, `buys ${c.buys}`);
  assert.equal(rep.ring.filter(e => /Interne fout|Onverwachte/.test(e.text)).length, 0);

  // boekhouding: cash = start + Σ gesloten P/L − Σ inleg open − gefaalde tx-kosten + Σ deelverkopen open
  const P = engine.portfolio;
  const closedPnl = P.closed.reduce((s, c) => s + c.pnlSol, 0);
  const open = [...P.positions.values()];
  const expected = P.startBalance + closedPnl - open.reduce((s, p) => s + p.costSol, 0) + open.reduce((s, p) => s + p.realizedSol, 0) - P.failedTxCost;
  assert.ok(Math.abs(P.cash - expected) < 1e-9, `cash ${P.cash} ≠ ${expected}`);

  const snap = engine.snapshot();
  assert.ok(snap.equity > 0 && JSON.stringify(snap).length > 100);

  // herstart
  await sleep(200);
  const before = { cash: P.cash, open: P.positions.size, closed: P.closed.length };
  engine.stop();
  ({ engine } = build(cfg));
  engine.start();
  assert.equal(engine.portfolio.cash, before.cash);
  assert.equal(engine.portfolio.positions.size, before.open);
  assert.equal(engine.portfolio.closed.length, before.closed);
  await sleep(3000);
  engine.stop();
  mock.close();
});
