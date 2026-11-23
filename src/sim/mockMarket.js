// DEMO-MARKT — een nep-pump.fun die exact het PumpPortal-websocketformaat spreekt.
// De bot verbindt hiermee via precies dezelfde code als met de echte feed.
// Bevat duds, pump&dumps, rugs, gebundelde launches en (zeldzame) runners.
// LET OP: winst/verlies in demo-modus zegt NIETS over de echte markt.
import { WebSocketServer } from 'ws';
import { quoteBuy, quoteSell } from '../curve.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const rid = (n, suffix = '') => Array.from({ length: n - suffix.length }, () => B58[Math.floor(Math.random() * 58)]).join('') + suffix;
const exp = rate => -Math.log(1 - Math.random()) / rate;
const logn = (median, sigma) => median * Math.exp(sigma * (Math.random() * 2 - 1) * 1.2);
const pick = a => a[Math.floor(Math.random() * a.length)];

const WORDS = ['PEPE', 'DOGE', 'CAT', 'MOON', 'FROG', 'WIF', 'BONK', 'HOGE', 'FAT', 'BABY', 'CHAD', 'GROK', 'APE', 'SHIB', 'MIHAO', 'TURBO', 'NEIRO', 'GOAT', 'PNUT', 'MOODENG', 'SIGMA', 'BRETT', 'POPCAT', 'MEW'];
const ARCH = [['dud', 45], ['pumpdump', 18], ['rug', 15], ['bundle', 12], ['runner', 10]];
const FEE = 1.25;

function archetype() {
  let r = Math.random() * 100;
  for (const [a, w] of ARCH) { if ((r -= w) < 0) return a; }
  return 'dud';
}

export async function startMockMarket({ copyWallets = [], launchEverySec = 1.4 } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;
  const subs = new Map(); // ws → { newToken, migration, tokens:Set, accounts:Set }
  const traders = Array.from({ length: 400 }, () => rid(44));
  const smart = copyWallets[0];
  const live = new Map();

  wss.on('connection', ws => {
    const s = { newToken: false, migration: false, tokens: new Set(), accounts: new Set() };
    subs.set(ws, s);
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      const keys = Array.isArray(m.keys) ? m.keys : [];
      switch (m.method) {
        case 'subscribeNewToken': s.newToken = true; break;
        case 'subscribeMigration': s.migration = true; break;
        case 'subscribeTokenTrade': keys.forEach(k => s.tokens.add(k)); break;
        case 'unsubscribeTokenTrade': keys.forEach(k => s.tokens.delete(k)); break;
        case 'subscribeAccountTrade': keys.forEach(k => s.accounts.add(k)); break;
        default: return;
      }
      ws.send(JSON.stringify({ message: `Successfully subscribed (${m.method})` }));
    });
    ws.on('close', () => subs.delete(ws));
  });

  const send = (msg, filter) => {
    const data = JSON.stringify(msg);
    for (const [ws, s] of subs) if (filter(s) && ws.readyState === 1) ws.send(data);
  };

  class SimToken {
    constructor() {
      this.kind = archetype();
      const w = pick(WORDS), r = Math.random();
      this.symbol = r < 0.15 ? w : r < 0.55 ? `${w}${Math.floor(Math.random() * 999)}` : `${pick(WORDS).slice(0, 3)}${w}`.slice(0, 10);
      this.mint = rid(44, 'pump');
      this.curve = rid(44);
      this.dev = rid(44);
      this.vSol = 30; this.vTokens = 1_073_000_000;
      this.bal = new Map();
      this.born = Date.now();
      this.snipers = [];
      this.rugAt = 40 + Math.random() * 60;
      this.peakAge = this.kind === 'runner' ? 150 + Math.random() * 200 : 40 + Math.random() * 70;
      this.smartIn = smart && (this.kind === 'runner' ? Math.random() < 0.6 : this.kind === 'pumpdump' ? Math.random() < 0.25 : false);
      this.smartBuyAt = 15 + Math.random() * 30;
      this.smartSellAt = this.peakAge * (0.8 + Math.random() * 0.4);
      this.state = 'live';
    }

    get age() { return (Date.now() - this.born) / 1000; }
    get mcap() { return (this.vSol / this.vTokens) * 1e9; }

    trade(trader, side, amount, { silent = false } = {}) {
      let solAmount, tokenAmount;
      if (side === 'buy') {
        const q = quoteBuy(this.vSol, this.vTokens, amount, FEE);
        solAmount = amount; tokenAmount = q.tokensOut;
        this.vSol = q.newSol; this.vTokens = q.newTokens;
        this.bal.set(trader, (this.bal.get(trader) || 0) + tokenAmount);
      } else {
        tokenAmount = Math.min(amount, this.bal.get(trader) || 0);
        if (tokenAmount <= 1) return;
        const q = quoteSell(this.vSol, this.vTokens, tokenAmount, FEE);
        solAmount = q.solOut;
        this.vSol = q.newSol; this.vTokens = q.newTokens;
        const left = (this.bal.get(trader) || 0) - tokenAmount;
        if (left > 1) this.bal.set(trader, left); else this.bal.delete(trader);
      }
      if (silent) return;
      const msg = {
        signature: rid(88), mint: this.mint, traderPublicKey: trader, txType: side,
        tokenAmount, solAmount, newTokenBalance: this.bal.get(trader) || 0,
        bondingCurveKey: this.curve, vTokensInBondingCurve: this.vTokens,
        vSolInBondingCurve: this.vSol, marketCapSol: this.mcap, pool: 'pump',
      };
      send(msg, s => s.tokens.has(this.mint) || s.accounts.has(trader));
      if (this.mcap >= 410) this.migrate();
    }

    launch() {
      const devSol = this.kind === 'bundle' && Math.random() < 0.5 ? logn(3, 0.5) : logn(0.6, 0.8);
      const q = quoteBuy(this.vSol, this.vTokens, devSol, FEE);
      this.vSol = q.newSol; this.vTokens = q.newTokens;
      this.bal.set(this.dev, q.tokensOut);
      send({
        signature: rid(88), mint: this.mint, traderPublicKey: this.dev, txType: 'create',
        initialBuy: q.tokensOut, solAmount: devSol, bondingCurveKey: this.curve,
        vTokensInBondingCurve: this.vTokens, vSolInBondingCurve: this.vSol, marketCapSol: this.mcap,
        name: `${this.symbol} Coin`, symbol: this.symbol, uri: '', pool: 'pump',
      }, s => s.newToken);
      if (this.kind === 'bundle') {
        // zelfde blok als de create: deze ziet niemand via een token-abonnement
        for (let i = 0; i < 4; i++) { const w = rid(44); this.snipers.push(w); this.trade(w, 'buy', logn(1.8, 0.4), { silent: true }); }
        for (let i = 0; i < 4; i++) {
          const w = rid(44); this.snipers.push(w);
          setTimeout(() => this.trade(w, 'buy', logn(1.5, 0.4)), 60 + i * 120);
        }
      }
      this.loop();
    }

    // koopkans en intensiteit per archetype en leeftijd
    regime() {
      const a = this.age;
      switch (this.kind) {
        case 'dud': return { rate: 2 * Math.exp(-a / 25), pBuy: 0.5, size: 0.25 };
        case 'pumpdump': return a < this.peakAge ? { rate: 3.5, pBuy: 0.74, size: 0.5 } : { rate: 2.5 * Math.exp(-(a - this.peakAge) / 80), pBuy: 0.28, size: 0.35 };
        case 'rug': return a < this.rugAt ? { rate: 3.5, pBuy: 0.75, size: 0.5 } : { rate: 0.6 * Math.exp(-(a - this.rugAt) / 30), pBuy: 0.25, size: 0.15 };
        case 'bundle': return { rate: 2.5 * Math.exp(-a / 70), pBuy: 0.56, size: 0.35 };
        case 'runner': return a < this.peakAge ? { rate: 4, pBuy: 0.7, size: 0.7 } : { rate: 3 * Math.exp(-(a - this.peakAge) / 120), pBuy: 0.35, size: 0.5 };
      }
    }

    step() {
      const a = this.age;
      if (this.kind === 'rug' && !this.rugged && a >= this.rugAt) {
        this.rugged = true;
        this.trade(this.dev, 'sell', this.bal.get(this.dev) || 0);
        const top = [...this.bal.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
        top.forEach(([w, b], i) => setTimeout(() => this.trade(w, 'sell', b), 300 + i * 200));
      }
      if (this.kind === 'bundle' && !this.dumped && a > 35 + Math.random() * 30) {
        this.dumped = true;
        this.snipers.forEach((w, i) => setTimeout(() => this.trade(w, 'sell', this.bal.get(w) || 0), i * 150));
      }
      if (this.smartIn && !this.smartBought && a >= this.smartBuyAt) { this.smartBought = true; this.trade(smart, 'buy', logn(1.5, 0.3)); }
      if (this.smartBought && !this.smartSold && a >= this.smartSellAt) { this.smartSold = true; this.trade(smart, 'sell', this.bal.get(smart) || 0); }

      const { pBuy, size } = this.regime();
      if (Math.random() < pBuy) {
        const fresh = Math.random() < 0.55;
        this.trade(fresh ? rid(44) : pick(traders), 'buy', logn(size, 0.9));
      } else {
        const holders = [...this.bal.entries()].filter(([w]) => w !== this.dev && w !== smart && !this.snipers.includes(w));
        if (holders.length) {
          const [w, b] = pick(holders);
          this.trade(w, 'sell', b * (Math.random() < 0.6 ? 1 : 0.3 + Math.random() * 0.6));
        }
      }
    }

    loop() {
      if (this.state !== 'live') return;
      const { rate } = this.regime();
      if (rate < 0.02 || this.age > 600) return this.end();
      this.timer = setTimeout(() => { try { this.step(); } catch {} this.loop(); }, Math.min(30_000, exp(rate) * 1000));
    }

    migrate() {
      if (this.state !== 'live') return;
      send({ signature: rid(88), mint: this.mint, txType: 'migrate', pool: 'pump-amm' }, s => s.migration);
      this.end();
    }

    end() { this.state = 'done'; clearTimeout(this.timer); live.delete(this.mint); }
  }

  let launcher;
  const scheduleLaunch = () => {
    launcher = setTimeout(() => {
      if (live.size < 150) { const t = new SimToken(); live.set(t.mint, t); t.launch(); }
      scheduleLaunch();
    }, exp(1 / launchEverySec) * 1000);
  };
  scheduleLaunch();

  return {
    url: `ws://127.0.0.1:${port}`,
    close() { clearTimeout(launcher); for (const t of live.values()) t.end(); wss.close(); },
  };
}
