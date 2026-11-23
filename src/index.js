#!/usr/bin/env node
// Start:  npm start         → live data van pump.fun (paper trading)
//         npm run demo      → synthetische markt, werkt offline
import { loadConfig } from './config.js';
import { Feed } from './feed.js';
import { PaperExecutor } from './executor.js';
import { Reporter } from './reporter.js';
import { SolPrice } from './solPrice.js';
import { Engine } from './engine.js';
import { startServer } from './server.js';

const demo = process.argv.includes('--demo');
const cfg = loadConfig({ demo });

let mock = null;
if (demo) {
  if (!cfg.copyWallets.length) cfg.copyWallets = ['DemoSmartMoney11111111111111111111111111111'];
  const { startMockMarket } = await import('./sim/mockMarket.js');
  mock = await startMockMarket({ copyWallets: cfg.copyWallets });
  cfg.feedUrl = mock.url;
}

const reporter = new Reporter(cfg);
const solPrice = new SolPrice(demo ? 140 : cfg.solUsdFallback, { offline: demo });
solPrice.start();
const feed = new Feed(cfg.feedUrl, { silenceSec: cfg.feedSilenceReconnectSec, log: (_, t) => reporter.log('feed', t) });
const engine = new Engine(cfg, { feed, executor: new PaperExecutor(cfg), reporter, solPrice });

console.log(`\n  🌙 NIGHT DESK ${demo ? '— DEMO (synthetische markt)' : '— LIVE data · PAPER trading'}`);
console.log(`  Dashboard: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}${cfg.dashboardPassword ? ' (met wachtwoord)' : ''}\n`);

engine.start();
const server = startServer(engine, cfg);
server.on('error', e => {
  console.error(`Dashboard kon niet starten op poort ${cfg.port}: ${e.message}. Zet een andere PORT in .env`);
  process.exit(1);
});

const shutdown = () => {
  console.log('\nAfsluiten — staat opslaan…');
  engine.stop();
  solPrice.stop();
  server.close();
  mock?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Waakhond: komt er 10 minuten lang geen enkele nieuwe token binnen, dan is er iets
// structureel mis met de feed. Stoppen → Railway (of pm2) start de bot schoon opnieuw.
if (!demo) {
  const bootAt = Date.now();
  setInterval(() => {
    const f = feed.stats, last = Math.max(f.lastCreateAt, bootAt);
    if (Date.now() - last > 10 * 60_000) {
      reporter.log('fail', 'Al 10 minuten geen nieuwe tokens van de feed — herstarten');
      engine.stop();
      setTimeout(() => process.exit(1), 500);
    }
  }, 30_000);
}

process.on('unhandledRejection', e => reporter.log('fail', `Onverwachte fout: ${e?.message || e}`));
