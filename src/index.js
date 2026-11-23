#!/usr/bin/env node
// Start:  npm start         → live data van pump.fun (paper trading)
//         npm run demo      → synthetische markt, werkt offline
import { loadConfig } from './config.js';
import { Feed } from './feed.js';
import { FirehoseFeed } from './firehose.js';
import { FeedRouter } from './router.js';
import { PaperExecutor } from './executor.js';
import { Reporter } from './reporter.js';
import { SolPrice } from './solPrice.js';
import { Engine } from './engine.js';
import { startServer } from './server.js';
import { Research } from './research.js';
import { WalletTracker } from './wallets.js';

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
const flog = (_, t) => reporter.log('feed', t);
const pumpportal = () => new Feed(cfg.feedUrl, { silenceSec: cfg.feedSilenceReconnectSec, log: flog });
let feed;
if (demo || cfg.feedMode === 'pumpportal') feed = pumpportal();
else {
  // Primair PumpAPI (gratis). Reserve PumpPortal alleen als er een API key is.
  const fallback = cfg.feedApiKey && cfg.feedMode !== 'pumpapi' ? pumpportal() : null;
  feed = new FeedRouter({ primary: new FirehoseFeed(cfg.firehoseUrl, { log: flog }), fallback, log: flog, failoverSec: cfg.failoverSec });
}
const engine = new Engine(cfg, { feed, executor: new PaperExecutor(cfg), reporter, solPrice });

console.log(`\n  🌙 NIGHT DESK ${demo ? '— DEMO (synthetische markt)' : '— LIVE data · PAPER trading'}`);
console.log(`  Dashboard: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}${cfg.dashboardPassword ? ' (met wachtwoord)' : ''}\n`);

engine.start();

// Onderzoek + slimme wallets draaien op de volledige marktstroom (alleen PumpAPI levert die)
const research = new Research(cfg, { registry: engine.registry });
const wallets = new WalletTracker(cfg);
engine.research = research;
engine.wallets = wallets;
feed.on('raw', ev => { try { research.onRaw(ev); wallets.onRaw(ev); } catch (e) { reporter.log('fail', `Onderzoek: ${e.message}`); } });
setInterval(() => { try { research.tick(); } catch (e) { reporter.log('fail', `Onderzoek: ${e.message}`); } }, 2000);
const refreshSmart = () => {
  wallets.tick();
  engine.setSmartWallets(wallets.top.slice(0, cfg.smartCopyTop).map(w => w.addr));
};
setTimeout(refreshSmart, 5000);
setInterval(refreshSmart, 60_000);
setInterval(() => wallets.save(), 10 * 60_000);
if (!demo && cfg.feedMode === 'pumpportal' && !cfg.feedApiKey) reporter.log('guard', 'Geen PUMPPORTAL_API_KEY ingesteld — PumpPortal stuurt dan geen trades, alleen nieuwe tokens. Zie README.');
if (!demo && cfg.feedMode !== 'pumpportal') reporter.log('info', `Databron: PumpAPI (gratis)${cfg.feedApiKey && cfg.feedMode !== 'pumpapi' ? ' · reserve: PumpPortal' : ' · geen reserve (geen PumpPortal-key)'}`);
const server = startServer(engine, cfg);
server.on('error', e => {
  console.error(`Dashboard kon niet starten op poort ${cfg.port}: ${e.message}. Zet een andere PORT in .env`);
  process.exit(1);
});

const shutdown = () => {
  console.log('\nAfsluiten — staat opslaan…');
  engine.stop();
  wallets.save();
  solPrice.stop();
  server.close();
  mock?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Waakhond: is de verbinding OPEN maar komt er 10 minuten geen enkele nieuwe token binnen,
// dan hangt er iets → stoppen zodat Railway (of pm2) schoon herstart.
// Kan PumpPortal niet bereikt worden (storing, 502)? Dan NIET stoppen: de feed blijft zelf
// opnieuw verbinden, en herstarten helpt dan niets.
if (!demo) {
  const bootAt = Date.now();
  setInterval(() => {
    const f = feed.stats, last = Math.max(f.lastCreateAt, f.connectedAt, bootAt);
    if (feed.connected && Date.now() - last > 10 * 60_000) {
      reporter.log('fail', 'Verbonden, maar al 10 minuten geen nieuwe tokens — herstarten');
      engine.stop();
      setTimeout(() => process.exit(1), 500);
    }
  }, 30_000);
}

process.on('unhandledRejection', e => reporter.log('fail', `Onverwachte fout: ${e?.message || e}`));
