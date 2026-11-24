import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpotDesk } from '../src/spot/desk.js';
import { Book } from '../src/spot/sim.js';
import { ema, sma } from '../src/spot/indicators.js';

const DAY = 86400e3;
// Nep-Bitvavo: per coin een koers die eerst daalt en dan stijgt
function fakeMarket(nowRef) {
  const price = (coin, t) => { const d = (t - Date.UTC(2022, 8, 1)) / DAY, k = coin.length; return 100 * k * (1 + 0.4 * Math.sin(d / 40)) + d * 0.1; };
  return async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/ticker/price')) return { ok: true, json: async () => ['BTC', 'ETH', 'SOL'].map(c => ({ market: `${c}-EUR`, price: String(price(c, nowRef.t)) })) };
    const m = u.pathname.match(/\/v2\/(\w+)-EUR\/candles/);
    if (m) {
      const iv = u.searchParams.get('interval') === '4h' ? 4 * 3600e3 : DAY;
      const start = +u.searchParams.get('start'), end = +u.searchParams.get('end');
      const rows = [];
      for (let t = Math.ceil(start / iv) * iv; t <= end && rows.length < 1440; t += iv) rows.push([t, price(m[1], t), price(m[1], t) * 1.01, price(m[1], t) * .99, price(m[1], t + iv), 1]);
      return { ok: true, json: async () => rows.reverse() };   // Bitvavo: nieuwste eerst
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('indicatoren', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = ema([1, 1, 1, 10], 3); assert.equal(e[1], null); assert.ok(e[3] > 1 && e[3] < 10);
});

test('boekhouding: kosten en minimum order', () => {
  const b = new Book(100, 10);
  const f = b.buy('BTC', 100, 0, () => 100);
  assert.equal(f.eur, 10); assert.ok(Math.abs(b.cash - 90) < 1e-9);
  const t = b.sell('BTC', 100, 1);
  assert.ok(t.pnl < 0 && t.pnl > -0.07, 'zonder koersbeweging verlies je alleen kosten (~0,6%)');
  const small = new Book(40, 10); assert.equal(small.buy('ETH', 1, 0, () => 1), null, 'onder €5 wordt niet gekocht');
});

test('Spot Desk: draait backtest, opent posities, slaat op en laadt terug', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-'));
  const nowRef = { t: Date.UTC(2026, 10, 24, 9) };
  const mk = () => new SpotDesk({ dataDir: dir, spotStartEur: 100 }, { fetchFn: fakeMarket(nowRef), now: () => nowRef.t, coins: ['BTC', 'ETH', 'SOL'] });
  const d = mk();
  await d.init();
  const s = d.snapshot();
  assert.equal(s.status, 'actief');
  const hold = s.strategies.find(x => x.id === 'hold');
  assert.equal(hold.positions.length, 3, 'vasthouden koopt alle coins');
  assert.ok(hold.backtest && hold.backtest.curve.length > 100);
  for (const x of s.strategies) assert.ok(Math.abs(x.live.eq - 100) < 3, `${x.id} begint rond €100`);
  // nieuwe dag → candles bijwerken, geen dubbele aankopen
  nowRef.t += DAY; await d.step();
  const fills = d.books.hold.fills.length; nowRef.t += 3600e3; await d.step();
  assert.equal(d.books.hold.fills.length, fills, 'zelfde candle wordt niet nog eens verwerkt');
  d.stop();
  const d2 = mk();
  assert.equal(Object.keys(d2.books.hold.pos).length, 3, 'posities blijven na herstart');
  await d2.reset();
  assert.equal(d2.events.at(-1)?.kind === 'koop' || d2.events.some(e => e.text.includes('opnieuw')), true);
});
