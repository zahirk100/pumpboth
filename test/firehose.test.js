// PumpAPI-firehose + automatische overstap naar reserve
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { FirehoseFeed } from '../src/firehose.js';
import { FeedRouter } from '../src/router.js';
import { Feed } from '../src/feed.js';
import { startMockMarket } from '../src/sim/mockMarket.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'GjUoHK6cuQqZLV2ZaKhE9wnDQGHBMaDsVT24JYjEpump';

function pumpApiServer(port) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const send = obj => { for (const c of wss.clients) c.send(JSON.stringify(obj)); };
  return { wss, send, close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

// Berichten in PumpAPI-formaat (velden zoals in hun documentatie)
const create = { signature: 'SIGCREATE', action: 'create', pool: 'pump', mint: MINT, quoteMint: WSOL, txSigner: 'DEV', initialBuy: 97545454.545454,
  quoteAmount: 3.0, name: 'ROUNDHILL MEME STOCK ETF', symbol: 'MEME', uri: 'https://x/meta.json', vTokensInBondingCurve: 975454545.454546, vQuoteInBondingCurve: 33.0, marketCapQuote: 33.83 };
const devBuySameTx = { signature: 'SIGCREATE', action: 'buy', pool: 'pump', mint: MINT, quoteMint: WSOL, txSigner: 'DEV', tokenAmount: 97545454.5, quoteAmount: 3.0, vTokensInBondingCurve: 975454545.45, vQuoteInBondingCurve: 33.0 };
const buy = { signature: 'SIGBUY', action: 'buy', pool: 'pump', mint: MINT, quoteMint: WSOL, txSigner: 'ALICE', tokenAmount: 2900000, quoteAmount: 0.1, vTokensInBondingCurve: 972554545.45, vQuoteInBondingCurve: 33.1, marketCapQuote: 34.03 };
const ammBuy = { signature: 'SIGAMM', action: 'buy', pool: 'pump-amm', mint: MINT, quoteMint: WSOL, txSigner: 'BOB', tokenAmount: 118025691.45, quoteAmount: 6.78, tokensInPool: 412000309.77, quoteInPool: 16.52, marketCapQuote: 67.24 };
const usdc = { ...ammBuy, signature: 'SIGUSDC', quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
const noise = [{ action: 'transfer', mint: MINT, amount: 5 }, { action: 'buy', pool: 'raydium-cpmm', mint: MINT }, { action: 'create', pool: 'pump-amm', mint: 'OTHERpump' }];

test('PumpAPI: filtert ruis, telt dev-buy niet dubbel, herkent migratie', async () => {
  const srv = pumpApiServer(8831);
  const f = new FirehoseFeed('ws://127.0.0.1:8831', {});
  const got = { create: [], trade: [], migration: [] };
  for (const k of Object.keys(got)) f.on(k, e => got[k].push(e));
  f.start();
  await sleep(300);
  srv.send(create); srv.send(devBuySameTx); noise.forEach(srv.send);
  srv.send(buy); // nog niet gevolgd → geen trade-event
  await sleep(150);
  f.watchTokens([MINT]);
  srv.send({ ...buy, signature: 'SIGBUY2' }); srv.send(ammBuy); srv.send(usdc);
  srv.send([{ ...buy, signature: 'SIGBATCH' }]);           // batch als array
  srv.send({ action: 'create', pool: 'pump-amm', mint: MINT, signature: 'SIGMIG' });
  await sleep(300);
  f.stop(); await srv.close();

  assert.equal(got.create.length, 1);
  assert.equal(got.create[0].symbol, 'MEME');
  assert.equal(got.create[0].trader, 'DEV');
  assert.equal(got.create[0].vSol, 33);
  assert.deepEqual(got.trade.map(t => t.signature), ['SIGBUY2', 'SIGAMM', 'SIGBATCH'], 'dev-buy, ongevolgd, USDC en ruis eruit');
  assert.equal(got.trade[0].trader, 'ALICE');
  assert.equal(got.trade[0].solAmount, 0.1);
  assert.equal(got.trade[1].pool, 'pump-amm');
  assert.ok(Math.abs(got.trade[1].vSol - 16.52) < 1e-9);
  assert.equal(got.migration.length, 1);
});

test('Router: valt automatisch terug op PumpPortal en schakelt weer terug', { timeout: 60_000 }, async () => {
  let srv = pumpApiServer(8832);
  const mock = await startMockMarket({ launchEverySec: 0.3 });
  const logs = [];
  const r = new FeedRouter({
    primary: new FirehoseFeed('ws://127.0.0.1:8832', { silenceSec: 3 }),
    fallback: new Feed(mock.url, {}),
    log: (_, t) => logs.push(t), failoverSec: 1, recoverSec: 1,
  });
  const creates = [];
  r.on('create', e => creates.push(e.source));
  r.start();
  await sleep(500);
  srv.send(create);
  await sleep(300);
  assert.equal(r.stats.source, 'PumpAPI');
  assert.deepEqual(creates, ['primary']);

  await srv.close();                       // PumpAPI valt uit
  await sleep(8000);
  assert.ok(r.fallbackOn, 'reserve moet aan staan');
  assert.ok(creates.includes('fallback'), 'data via reserve');
  assert.equal(r.stats.source, 'PumpPortal');
  assert.ok(r.connected);

  srv = pumpApiServer(8832);               // PumpAPI komt terug
  const keep = setInterval(() => srv.send({ action: 'transfer' }), 500);
  await sleep(25_000);
  clearInterval(keep);
  assert.equal(r.fallbackOn, false, 'reserve weer uit');
  assert.equal(r.stats.source, 'PumpAPI');
  assert.ok(logs.some(l => /reserve-databron PumpPortal wordt gestart/.test(l)));
  assert.ok(logs.some(l => /reserve PumpPortal gestopt/.test(l)));
  r.stop(); mock.close(); await srv.close();
});
