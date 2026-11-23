# 🌙 Night Desk — paper-trading bot voor pump.fun

Een bot die **live** alle nieuwe pump.fun-launches op Solana volgt, ze door een rij agents (filters) haalt en **met nepgeld** handelt. Hij rekent fees, vertraging en mislukte transacties net zo door als in het echt. Alles is te volgen op een live dashboard.

> Er wordt **niet met echt geld gehandeld**. Alleen de live data van PumpPortal kost een klein bedrag (zie *PumpPortal API key*). Het doel is meten of een strategie na alle kosten winst maakt, vóórdat je er echt geld op zet.

---

## Snel starten

Vereist: **Node.js 20 of nieuwer** ([nodejs.org](https://nodejs.org)). Wil je hem online laten draaien, kijk dan bij *24/7 online via Railway*.

```bash
cd night-desk
npm install
npm run demo     # offline met een synthetische markt, om alles te zien werken
npm start        # live pump.fun-data, paper trading
```

Open daarna **http://127.0.0.1:8787** in je browser.

Met `Ctrl+C` stop je de bot. De staat wordt opgeslagen in `data/` (live) of `data-demo/` (demo). Bij een herstart gaat hij verder waar hij was, inclusief open posities.

`npm test` draait de tests: 9 unit tests en 1 end-to-end test van feed → bot → herstart.

---

## Hoe het werkt

```
 PumpPortal websocket (gratis, live)
        │  nieuwe tokens · trades · migraties · trades van gevolgde wallets
        ▼
 NEW PAIRS ──► CONTRACT SCAN ──► BOT FILTER ──► MOMENTUM ──► DRAWDOWN GUARD ──► SIZER ──► EXECUTOR
                                                     ▲                                           │
                                               COPY TRADER                                       ▼
                                                                         EXIT PLANNER ◄── open posities
                                                                               │
                                                                          REPORTER (log, dashboard, Telegram)
```

| Agent | Wat hij doet |
|---|---|
| **New Pairs** | Abonneert op elke nieuwe pump.fun-token en volgt die maximaal 4 minuten. |
| **Contract Scan** | Pump.fun zet mint- en freeze-authority zelf uit, en er is geen tax. Deze agent blokkeert daarom wat wél misgaat: *serial launchers* (dezelfde wallet die steeds nieuwe tokens lanceert), copycat-tickers en optioneel tokens zonder socials. |
| **Bot Filter** | Blokkeert gebundelde launches en snipers. Daarvoor kijkt hij naar kopers in de eerste 2 seconden, en rekent hij uit de reserves terug welke kopen in hetzelfde blok als de create vielen. Ook blokkeert hij devs die te veel kopen of al verkopen, en een top-10 die te geconcentreerd is. |
| **Momentum** | Koopt alleen bij brede, echte vraag: genoeg unieke kopers en trades, een goede koop/verkoop-ratio, netto SOL-instroom, de juiste mcap-range en een prijs die nog niet gedumpt is. |
| **Copy Trader** | Volgt wallets die jij opgeeft. Als zo'n wallet koopt, koopt de bot een halve positie mee (na de veiligheidscheck). Verkoopt de wallet, dan verkoopt de bot ook. |
| **Drawdown Guard** | Max 3 posities tegelijk. Pauzeert bij −25% op een dag, na 5 verliezen op rij, en stopt helemaal onder 40% van de start. |
| **Sizer** | Zet 4% van de equity in per trade, met minimum- en maximumbedragen. |
| **Executor** | Paper: wacht 1,5 s (latency), weigert de trade bij meer dan 15% slippage en laat 6% van de transacties mislukken (de fee ben je dan wel kwijt). Hij rekent de curve-fee, priority fee en Jito-tip mee. De prijs komt uit de echte bonding-curve-formule. |
| **Exit Planner** | Stop-loss −25%. Neemt winst in stappen: 40% bij 2×, 30% bij 4× en 20% bij 8×. Daarna een trailing stop van 35%. Direct verkopen als de dev verkoopt of een whale dumpt. Verder een exit als er geen momentum, geen handel of te veel tijd verstreken is, of als de token migreert. |
| **Reporter** | Schrijft het nachtlog (`data/log.jsonl`), werkt het dashboard bij en stuurt optioneel Telegram-meldingen plus een recap om 07:00. |

### Waarom geen "Grok" in de beslissingen?
Een taalmodel doet er seconden over om te antwoorden. Op pump.fun is een token in die tijd al 30% verschoven. De beslissingen zijn daarom harde, controleerbare regels. Een AI is wel nuttig voor de nachtrecap of om de resultaten te analyseren. Dat kan later worden toegevoegd.

---

## PumpPortal API key (nodig voor live data)

PumpPortal stuurt sinds 1 mei 2026 alleen nog trades als je een API key hebt. Nieuwe tokens zijn gratis, maar handelsdata kost **0,01 SOL per 10.000 trade-berichten**. Die kosten worden afgeschreven van een wallet die aan je key gekoppeld is. Die wallet moet minstens 0,02 SOL bevatten.

1. Ga naar pumpportal.fun en maak een API key aan. Je krijgt daarbij een nieuwe wallet. **Bewaar de private key veilig.** Gebruik deze wallet alleen voor datakosten.
2. Zet er een klein bedrag op, bijvoorbeeld 0,1 SOL.
3. Zet in Railway onder **Variables**: `PUMPPORTAL_API_KEY` = je key.

De bot houdt de kosten in de hand. Standaard verwerkt hij maximaal 50.000 trade-berichten per dag (≈ 0,05 SOL), in te stellen met `MAX_TRADE_MSGS_PER_DAY`. Hij laat tokens zonder kopers na 45 seconden los, en volgt maximaal 40 tokens tegelijk. Het verbruik van vandaag staat op het dashboard bij NEW PAIRS.

## Instellingen

Alle knoppen staan met uitleg in `src/config.js`. Wil je iets aanpassen, kopieer dan `config.example.json` naar `config.json` en zet daar alleen de waarden in die je wilt wijzigen.

Geheimen en omgevingsvariabelen gaan in `.env` (kopieer `.env.example`):

| Variabele | Wat |
|---|---|
| `PORT` | Poort van het dashboard (standaard 8787; Railway zet deze zelf) |
| `DASHBOARD_PASSWORD` | Wachtwoord voor het dashboard (verplicht online) |
| `DATA_DIR` | Map voor opslag, bijvoorbeeld `/data` op een Railway-volume |
| `START_BALANCE_SOL` | Startkapitaal van het paper-account |
| `PUMPPORTAL_API_KEY` | Nodig voor trade-data (zie hierboven) |
| `MAX_TRADE_MSGS_PER_DAY` | Databudget per dag (standaard 50000 ≈ 0,05 SOL) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Meldingen op je telefoon. Maak een bot via @BotFather en vraag je chat-id op via @userinfobot. |
| `COPY_WALLETS` | Komma-gescheiden wallet-adressen om te kopiëren |

**Tip:** test één instelling tegelijk. Draai een versie minstens een week voordat je hem vergelijkt met een andere.

---

## Hoe beoordeel je of het "werkt"?

Kijk naar het blok **Prestaties** op het dashboard. Een paar mooie trades zeggen niets. Ga pas verder als dit allemaal klopt:

- ✅ minstens **200 trades** over **2+ weken** live data (demo telt niet)
- ✅ **profit factor > 1,3** (bruto winst / bruto verlies, na alle fees)
- ✅ **winst per trade** duidelijk positief, en niet afhankelijk van één uitschieter
- ✅ **max drawdown** die je emotioneel aankunt

De meeste memecoin-strategieën halen dit **niet**. Dat is precies waarom je eerst op papier test.

---

## 24/7 online via Railway (aanbevolen)

1. Ga naar [railway.com](https://railway.com) en log in met GitHub.
2. Kies **New Project → Deploy from GitHub repo** en selecteer deze repository. Railway herkent Node.js en start de bot met `npm start`.
3. Klik op de service en voeg een **Volume** toe met mount path **`/data`**.
4. Zet onder **Variables**:
   - `DASHBOARD_PASSWORD` = een sterk wachtwoord (**verplicht**; zonder wachtwoord blijft het dashboard dicht)
   - `DATA_DIR` = `/data`
   - optioneel: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `COPY_WALLETS`
5. Ga naar **Settings → Networking → Generate Domain**. Dat is je dashboard-link.
6. Optioneel bij **Settings → Deploy**: Healthcheck Path `/health`.

Inloggen: de gebruikersnaam maakt niet uit, het wachtwoord is je `DASHBOARD_PASSWORD`.

Elke push naar GitHub wordt automatisch live gezet. Saldo, posities en log staan op het volume en blijven dus bewaard. Crasht de bot, of komt er 10 minuten geen nieuwe token van de feed binnen, dan stopt hij zichzelf en start Railway hem opnieuw.

### Of op een eigen server (VPS)

```bash
npm install -g pm2
pm2 start src/index.js --name night-desk
pm2 save && pm2 startup
```

Lokaal luistert het dashboard alleen op `127.0.0.1`. Bekijk het via een SSH-tunnel:

```bash
ssh -L 8787:127.0.0.1:8787 gebruiker@jouw-server
```

---

## Beperkingen (eerlijk)

- De data komt van **PumpPortal** (gratis, onofficieel). Gebruik maar één verbinding, anders blokkeren ze je. De bot doet dat al.
- Na een migratie naar PumpSwap volgt de bot de token niet verder. Hij verkoopt daarom op het migratiemoment.
- Paper trading blijft een benadering. Echte bots concurreren met snipers met snellere infrastructuur, dus in het echt zijn je fills vaak slechter. Daarom staan latency en failure rate bewust conservatief ingesteld.
- Er zit geen X- of Telegram-hype-meter in: de X API kost minimaal $200 per maand.

## Naar echt geld?

Dat zit er bewust **niet** in. Als de cijfers na weken overtuigen, is de executor de enige plek die moet veranderen. Je vervangt `PaperExecutor` dan door een versie die transacties ondertekent, via de PumpPortal Local Transaction API of Jupiter, met Jito voor MEV-bescherming. Gebruik daarvoor een **aparte wallet met alleen het bedrag dat je kwijt mag raken**. Deel je seed phrase nooit en installeer geen bots van TikTok of Telegram die je key vragen.

*Geen financieel advies.*
