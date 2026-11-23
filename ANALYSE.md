# Analyse 23-11-2026

Data: 18.145 metingen van ±4.600 tokens (17:39–20:02 UTC) en 284 gesloten paper-trades.

## 1. Momentum voorspelt niets

Bij elke meting (na 30 s, 1, 2 en 5 min) is gekeken of de prijs daarna eerst **+30 %** of eerst **−20 %** raakt.

- Van de tokens die één van beide raakten, raakte **40,1 %** eerst +30 %.
- Zonder enige voorspelbaarheid (pure toeval) hoort dat precies **40 %** te zijn (0,20 / 0,50).
- Per meetmoment: 38,5 % (30 s) · 43,3 % (1 min) · 39,9 % (2 min) · 36,8 % (5 min).
- Geen enkel kenmerk verschuift dat structureel: kopers, flow, koop/verkoop-ratio, concentratie, dev-gedrag, snipers of mcap.
  Een machine-learningmodel dat getest is op data die het niet eerder zag, vond wel tokens die *meer bewegen*, maar niet tokens die *vaker stijgen*.
- Na kosten (≈4 % per trade) is de verwachte opbrengst daardoor overal **−4 à −5 % per trade**.

**Conclusie:** op pump.fun gedraagt de prijs zich na deze signalen als een munt opgooien, en de kosten maken het negatief.
Daarom zijn de momentum-strategieën Losser, Snelle winst, Scalper, Turbo en Laat-instapper gestopt. Streng blijft draaien als controle.

## 2. Waarom de momentum-trades verloren

- 86 van de 201 momentum-trades eindigden op **"dev verkoopt"**, met mediaan **10 s** na instap en gemiddeld 0,84×.
  De "momentum" werd vaak door de dev zelf gemaakt, en die verkocht direct daarna.
- Maar 15 % van de verliezende trades heeft ooit +10 % gestaan: de bot kocht steeds op de top.

## 3. Smart money: het enige spoor

83 trades, winrate 40 %, netto −0,05 SOL. Dat is bijna break-even, met uitschieters van 2,8×, 2,7× en 1,9×.

- Een exit omdat de gekopieerde wallet verkoopt: 43 trades, gemiddeld **1,05×**, **+0,098 SOL**.
- De verliezen komen vooral uit de **stop −30 %**: 14 trades, −0,253 SOL.
- Eén wallet (`sssssD…`, waarschijnlijk een bot) leverde 52 van de 83 trades, en daarop was het resultaat −0,128 SOL.
  De andere wallets samen: 31 trades, +0,077 SOL.

Daarom worden nu drie varianten naast elkaar getest:

| Strategie | Verschil |
|---|---|
| Smart money | huidige versie (stop −30 %) |
| Smart · volg de wallet | verkoopt alleen als de wallet verkoopt (noodstop −60 %) |
| Smart · alleen de beste | alleen wallets met 15+ rondes, 60 %+ winst en ≥ 90 s houdtijd |

De steekproef is klein. Over Smart money valt pas iets te zeggen na enkele honderden trades.

## 4. Volgende onderzoek: lange termijn (vanaf 23-11 21:30)

Gemeten worden tokens die op PumpSwap handelen (gemigreerd), of die langer dan 15 minuten actief zijn op de curve.

- Elke 5 minuten een meting per actieve token (minimaal 2 SOL volume in 15 min).
- Kenmerken: rendement en volume over 5, 15 en 60 min, koop/verkoop-ratio, aantal kopers, liquiditeit, afstand tot de top en de bodem van het afgelopen uur, en tijd sinds migratie.
- Uitkomst na 60 min: eerst +20 % vóór −10 %, en eerst +50 % vóór −25 %. Bij toeval is de kans op "eerst omhoog" in beide gevallen 33 %.
- Een voorsprong bestaat alleen als een groep metingen daar aantoonbaar boven zit, ook op data die het model niet eerder zag.
