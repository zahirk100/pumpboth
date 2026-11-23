// Slimme wallets, onderzoeksmodus en de Smart money-strategie
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { defaults } from '../src/config.js';
import { WalletTracker } from '../src/wallets.js';
import { Research } from '../src/research.js';
import { Engine } from '../src/engine.js';
import { PaperExecutor } from '../src/executor.js';
import { Reporter } from '../src/reporter.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nd-'));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const rid = (n = 44) => Array.from({ length: n }, () => B58[Math.floor(Math.random() * 58)]).join('');
const create = (mint, ts, dev = 'DEV') => ({ kind: 'create', mint, trader: dev, ts, vSol: 30, vTokens: 1.073e9, initialBuy: 1e7, symbol: 'T', signature: rid(88) });
const trade = (mint, trader, side, sol, tokens, ts, vSol = 32, vTokens = 1.0e9) => ({ kind: 'trade', mint, trader, side, solAmount: sol, tokenAmount: tokens, ts, vSol, vTokens, pool: 'pump', signature: rid(88) });

test('wallets: rondes, winst, en snipers/devs niet op de ranglijst', () => {
  const cfg = { ...defaults, dataDir: tmp() };
  const w = new WalletTracker(cfg);
  let ts = 1_000_000;
  for (let i = 0; i < 10; i++) {
    const mint = rid() + 'pump';
    w.onRaw(create(mint, ts, 'DEVX'));
    // slimme wallet: instap na 40s, 2 min vasthouden, 8/10 winst
    w.onRaw(trade(mint, 'SMART', 'buy', 1, 1e6, ts + 40_000));
    w.onRaw(trade(mint, 'SMART', 'sell', i < 8 ? 1.5 : 0.7, 1e6, ts + 160_000));
    // sniper: instap na 1s, wint ook
    w.onRaw(trade(mint, 'SNIPER', 'buy', 1, 1e6, ts + 1000));
    w.onRaw(trade(mint, 'SNIPER', 'sell', 2, 1e6, ts + 60_000));
    // dev verkoopt met winst
    w.onRaw(trade(mint, 'DEVX', 'buy', 1, 1e6, ts + 20_000));
    w.onRaw(trade(mint, 'DEVX', 'sell', 3, 1e6, ts + 90_000));
    ts += 300_000;
  }
  w.tick(ts);
  const top = w.top.map(x => x.addr);
  assert.deepEqual(top, ['SMART']);
  const s = w.top[0];
  assert.equal(s.rounds, 10);
  assert.equal(s.winRate, 0.8);
  assert.ok(Math.abs(s.realized - (8 * 0.5 - 2 * 0.3)) < 1e-9);
  assert.ok(s.avgEntrySec >= 40 && s.avgHoldSec >= 120);
  // opslaan en herladen
  w.save();
});

test('onderzoek: momentopname op 30s en "eerst +30%" uitkomst', async () => {
  const cfg = { ...defaults, dataDir: tmp() };
  let now = 5_000_000;
  const r = new Research(cfg, { now: () => now });
  const mint = rid() + 'pump';
  r.onRaw(create(mint, now));
  for (let i = 0; i < 10; i++) r.onRaw(trade(mint, 'b' + i, 'buy', 0.3, 1e7, now + 1000 * (i + 1), 31 + i * 0.3, 1.04e9 - i * 1e7));
  now += 31_000; r.tick(now);
  assert.equal(r.summary().snapshots, 1);
  const base = [...r.tokens.values()][0].snaps[0].price;
  // prijs +40% → eerst 'up', daarna −50%
  r.onRaw(trade(mint, 'x', 'buy', 5, 1e8, now + 1000, 40, 0.86e9));
  r.onRaw(trade(mint, 'y', 'sell', 5, 1e8, now + 2000, 25, 1.3e9));
  now += 601_000; r.tick(now);
  await new Promise(res => setTimeout(res, 100));
  const rows = fs.readFileSync(path.join(cfg.dataDir, 'research.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const row = rows.find(x => x.cp === 30);
  assert.equal(row.first, 'up');
  assert.ok(row.maxX > 1.3 && row.minX < 0.8, JSON.stringify(row));
  assert.ok(base > 0 && row.buyers >= 10);
});

test('engine: Smart money kopieert koop en verkoop van een slimme wallet', async () => {
  const cfg = { ...defaults, dataDir: tmp(), latencyMs: 0, txFailRate: 0, demo: true };
  const feed = new EventEmitter();
  Object.assign(feed, { stats: { tradeMsgsToday: 0 }, tokens: new Set(), connected: true, start() {}, stop() {},
    watchTokens(m) { m.forEach(x => this.tokens.add(x)); }, unwatchTokens(m) { m.forEach(x => this.tokens.delete(x)); },
    forceUnwatch() {}, watchAccounts() {}, unwatchAccounts() {} });
  const rep = new Reporter(cfg); rep.quiet = true;
  const engine = new Engine(cfg, { feed, executor: new PaperExecutor(cfg, () => 0.99), reporter: rep, solPrice: { usd: 75 } });
  engine.start();
  const smart = engine.strategies.find(s => s.id === 'smart');
  assert.ok(smart && smart.copyOnly);
  const W = rid();
  engine.setSmartWallets([W]);
  const mint = rid(40) + 'pump';
  const now = Date.now();
  feed.emit('create', { ...create(mint, now - 60_000), symbol: 'COPY' });
  feed.emit('trade', trade(mint, W, 'buy', 1.0, 3e7, now, 33, 0.97e9));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(smart.portfolio.positions.size, 1, 'smart opent positie');
  assert.equal([...smart.portfolio.positions.values()][0].copiedFrom, W);
  assert.equal(engine.main.portfolio.positions.size, 0, 'Streng kopieert niet');
  feed.emit('trade', trade(mint, rid(), 'buy', 0.5, 1e7, Date.now(), 34, 0.95e9));
  feed.emit('trade', trade(mint, W, 'sell', 1.1, 3e7, Date.now(), 33, 0.98e9));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(smart.portfolio.positions.size, 0, 'dicht na verkoop van de wallet');
  assert.equal(smart.portfolio.closed[0].exitReason, 'gekopieerde wallet verkoopt');
  assert.ok(smart.portfolio.closed[0].features.buyers >= 1);
  engine.stop();
});

test('lange termijn: PumpSwap-token krijgt momentopname elke 5 min en een uitkomst na 60 min', async () => {
  const { LongResearch } = await import('../src/research-long.js');
  const cfg = { ...defaults, dataDir: tmp() };
  let now = 10_000_000;
  const L = new LongResearch(cfg, { now: () => now });
  const mint = rid() + 'pump';
  const amm = (side, sol, vSol, vTok, t) => ({ kind: 'trade', mint, trader: rid(), side, solAmount: sol, tokenAmount: 1e6, ts: t, vSol, vTokens: vTok, mcapSol: vSol / vTok * 1e9, pool: 'pump-amm' });
  L.onRaw({ kind: 'migration', mint, ts: now });
  // 15 min handel, rustig stijgend
  for (let i = 0; i < 90; i++) L.onRaw(amm(i % 3 ? 'buy' : 'sell', 0.5, 80 + i * 0.05, 2e8, now + i * 10_000));
  now += 900_000; L.tick(now);
  assert.equal(L.summary().pending, 1, 'eerste momentopname');
  const snap = [...L.tokens.values()][0].snaps[0];
  assert.equal(snap.f.pool, 'pump-amm');
  assert.ok(snap.f.vol15 > 2 && snap.f.ret15 > 0 && snap.f.sinceMigrationMin >= 14);
  // prijs +25% → first20 = up, daarna rustig
  L.onRaw(amm('buy', 5, 110, 2e8, now + 60_000));
  now += 61 * 60_000; L.onRaw(amm('sell', 0.5, 100, 2e8, now - 1000)); L.tick(now);
  await new Promise(r => setTimeout(r, 100));
  const rows = fs.readFileSync(path.join(cfg.dataDir, 'research-long.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].first20, 'up');
  assert.equal(rows[0].first50, 'none');
  assert.ok(rows[0].x60m > 1);
});
