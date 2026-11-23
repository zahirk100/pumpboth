// ─────────────────────────────────────────────────────────────
//  NIGHT DESK — instellingen
//  Alles wat de strategie bepaalt staat hier. Pas aan, herstart.
//  Bedragen in SOL tenzij anders vermeld.
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const defaults = {
  // ── Account ────────────────────────────────────────────────
  startBalanceSol: 0.5,          // virtueel startkapitaal

  // ── Databronnen ───────────────────────────────────────────
  feedUrl: 'wss://pumpportal.fun/api/data',
  feedSilenceReconnectSec: 180,  // geen bericht ontvangen? → opnieuw verbinden
  // PumpPortal rekent sinds mei 2026 0.01 SOL per 10.000 trade-berichten (API key nodig).
  maxTradeMsgsPerDay: 50_000,    // ≈ 0.05 SOL/dag; daarboven geen nieuwe tokens meer volgen
  deadAfterSec: 45,              // token na zoveel sec nog < deadMinBuyers kopers → stoppen met volgen
  deadMinBuyers: 5,
  solUsdFallback: 150,           // als de SOL-prijs niet opgehaald kan worden

  // ── Pump.fun curve ─────────────────────────────────────────
  tokenSupply: 1_000_000_000,
  curveFeePct: 1.25,             // protocol + creator fee per trade (%)
  completeMcapSol: 400,          // rond dit punt migreert de token naar PumpSwap

  // ── Executie-realisme (paper) ─────────────────────────────
  latencyMs: 1500,               // tijd tussen besluit en landing on-chain
  maxSlippagePct: 15,            // prijs verder weg dan dit → order faalt
  txFailRate: 0.06,              // kans dat een tx niet landt (fee ben je wel kwijt)
  txFeeSol: 0.0003,              // netwerk + priority fee per transactie
  jitoTipSol: 0.0001,            // MEV-bescherming per transactie

  // ── NEW PAIRS: welke tokens we bekijken ───────────────────
  maxWatched: 40,                // max tegelijk gevolgde nieuwe tokens
  minAgeSec: 20,                 // nooit eerder instappen dan dit na launch
  maxAgeSec: 150,                // daarna stoppen met volgen als we niet instapten

  // ── CONTRACT SCAN / metadata ──────────────────────────────
  requireSocials: false,         // eisen dat metadata een X/Telegram/website heeft
  metadataTimeoutMs: 4000,
  maxCreatorLaunches6h: 2,       // creator die vaker lanceert = serial rugger
  maxSameSymbol30m: 2,           // copycat-tickers

  // ── BOT FILTER: snipers & bundles ─────────────────────────
  maxDevBuyPct: 8,               // % van supply dat de dev bij launch koopt
  bundleWindowMs: 2000,          // kopers binnen dit venster na create = snipers
  maxSniperPct: 15,              // max % supply in handen van snipers
  maxTop10Pct: 32,               // max % supply bij top-10 holders (excl. curve)
  maxDevHoldPct: 6,              // dev mag niet meer dan dit vasthouden bij entry

  // ── MOMENTUM: instapsignaal ───────────────────────────────
  minUniqueBuyers: 15,
  minTrades: 25,
  windowSec: 60,                 // venster voor flow-metingen
  minBuySellRatio: 1.6,          // SOL gekocht / SOL verkocht in het venster
  minNetInflowSol: 2,
  minMcapSol: 40,
  maxMcapSol: 200,
  maxDrawFromPeakPct: 25,        // niet instappen als de prijs al zoveel van de top af is

  // ── COPY TRADER ───────────────────────────────────────────
  copyWallets: [],               // wallet-adressen om te volgen
  copyMinSol: 0.5,               // alleen kopiëren als zij minstens dit kopen
  copySizeFactor: 0.5,           // positie t.o.v. normale grootte

  // ── SIZER ─────────────────────────────────────────────────
  riskPerTradePct: 4,            // % van equity per trade
  minPositionSol: 0.01,
  maxPositionSol: 0.25,

  // ── DRAWDOWN GUARD ────────────────────────────────────────
  maxOpenPositions: 3,
  dailyMaxDrawdownPct: 25,       // pauze tot de volgende dag
  lossStreakPause: 5,            // na zoveel verliezen op rij…
  lossStreakCooldownMin: 20,     // …zoveel minuten pauze
  hardFloorPct: 40,              // equity onder dit % van start → volledig stoppen

  // ── EXIT PLANNER ──────────────────────────────────────────
  stopLossPct: 25,
  takeProfits: [                 // x = veelvoud van instapprijs, sell = % van oorspronkelijke tokens
    { x: 2, sell: 40 },
    { x: 4, sell: 30 },
    { x: 8, sell: 20 },
  ],
  trailingStopPct: 35,           // actief na eerste take-profit
  stallSec: 240,                 // na zoveel sec nog geen +10% → eruit
  stallMinGainPct: 10,
  maxHoldMin: 30,
  staleSec: 120,                 // geen trades meer → eruit
  devSellExitPct: 20,            // dev verkoopt ≥ dit % van zijn tokens → direct eruit
  whaleDumpPct: 3,               // één wallet dumpt ≥ dit % van supply → eruit

  // ── REPORTER ──────────────────────────────────────────────
  recapHour: 7,                  // dagelijkse samenvatting (lokale tijd)
  telegramTradeAlerts: true,

  // ── STRATEGIEËN ───────────────────────────────────────────
  // Draaien allemaal tegelijk op dezelfde live data, elk met een eigen
  // virtueel saldo. 'overrides' overschrijft de instellingen hierboven.
  // De eerste is de hoofdstrategie (Telegram-meldingen, copy trading).
  strategies: [
    { id: 'streng', name: 'Streng', desc: 'Basis: brede vraag, strenge filters' },
    { id: 'los', name: 'Losser', desc: 'Eerder instappen met minder bewijs',
      overrides: { minUniqueBuyers: 8, minTrades: 12, minAgeSec: 12, minNetInflowSol: 1, minBuySellRatio: 1.3, minMcapSol: 33, maxTop10Pct: 40 } },
    { id: 'snel', name: 'Snelle winst', desc: 'Zelfde instap, snel winst pakken en krap stoppen',
      overrides: { takeProfits: [{ x: 1.5, sell: 50 }, { x: 2.5, sell: 30 }], stopLossPct: 15, trailingStopPct: 20, stallSec: 120, stallMinGainPct: 5 } },
    { id: 'laat', name: 'Laat-instapper', desc: 'Alleen tokens die al bewezen hebben te stijgen',
      overrides: { minAgeSec: 60, maxAgeSec: 420, minUniqueBuyers: 40, minTrades: 80, minMcapSol: 90, maxMcapSol: 300, minNetInflowSol: 4, maxDrawFromPeakPct: 20 } },
    { id: 'scalp', name: 'Scalper', desc: 'Veel trades: vroeg in, kleine winst pakken, binnen minuten eruit',
      overrides: { minAgeSec: 8, minUniqueBuyers: 6, minTrades: 8, minNetInflowSol: 0.5, minBuySellRatio: 1.2, minMcapSol: 30, maxTop10Pct: 45,
        takeProfits: [{ x: 1.25, sell: 60 }, { x: 1.6, sell: 40 }], stopLossPct: 10, trailingStopPct: 12,
        stallSec: 45, stallMinGainPct: 5, maxHoldMin: 4, maxOpenPositions: 5, riskPerTradePct: 6 } },
  ],

  // ── Dashboard ─────────────────────────────────────────────
  port: 8787,
  host: '127.0.0.1',
};

// Laad .env (zonder extra dependency)
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function loadConfig({ demo = false, root = PROJECT } = {}) {
  loadEnv(path.join(root, '.env'));
  let user = {};
  const userFile = path.join(root, 'config.json');
  if (fs.existsSync(userFile)) user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  const cfg = { ...defaults, ...user };
  cfg.demo = demo;
  const baseData = process.env.DATA_DIR || root;
  cfg.dataDir = process.env.DATA_DIR ? path.join(baseData, demo ? 'demo' : 'live') : path.join(root, demo ? 'data-demo' : 'data');
  cfg.port = Number(process.env.PORT || cfg.port);
  cfg.hosted = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.HOSTED);
  cfg.host = process.env.HOST || (cfg.hosted ? '0.0.0.0' : cfg.host);
  cfg.dashboardPassword = process.env.DASHBOARD_PASSWORD || '';
  // Bij een nieuwe deploy draait de oude versie nog even; even wachten voorkomt
  // twee gelijktijdige verbindingen (PumpPortal geeft daar een tijdelijke ban voor).
  cfg.feedStartDelayMs = Number(process.env.FEED_START_DELAY_SEC ?? (cfg.hosted ? 30 : 0)) * 1000;
  cfg.telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
  cfg.telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
  if (process.env.COPY_WALLETS) cfg.copyWallets = process.env.COPY_WALLETS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.FEED_URL) cfg.feedUrl = process.env.FEED_URL;
  cfg.feedApiKey = process.env.PUMPPORTAL_API_KEY || '';
  if (cfg.feedApiKey && !demo) cfg.feedUrl += (cfg.feedUrl.includes('?') ? '&' : '?') + 'api-key=' + encodeURIComponent(cfg.feedApiKey);
  if (process.env.MAX_TRADE_MSGS_PER_DAY) cfg.maxTradeMsgsPerDay = Number(process.env.MAX_TRADE_MSGS_PER_DAY);
  if (process.env.START_BALANCE_SOL) cfg.startBalanceSol = Number(process.env.START_BALANCE_SOL);
  return cfg;
}
