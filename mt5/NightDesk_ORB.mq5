//+------------------------------------------------------------------+
//| NightDesk_ORB.mq5                                                |
//| Opening Range Breakout: neemt het hoog/laag van de eerste X      |
//| minuten na de opening, stapt in bij een uitbraak, stop aan de    |
//| andere kant van de range, winstdoel = WinstFactorR x risico.     |
//| Max 1 trade per dag, positie dicht op een vaste tijd.            |
//| Testen: Strategy Tester, periode M1, "Every tick based on real   |
//| ticks", en zet "Forward" op 1/3 voor een eerlijke test.          |
//+------------------------------------------------------------------+
#property copyright "Night Desk"
#property version   "1.00"
#property description "Opening Range Breakout met vast risico per trade. Alleen op demo testen."

#include <Trade/Trade.mqh>

enum ENUM_SESSIE
  {
   SESSIE_NEWYORK = 0,   // New York opening (16:30 brokertijd)
   SESSIE_LONDEN  = 1,   // Londen opening (10:00 brokertijd)
   SESSIE_EIGEN   = 2    // Eigen starttijd (hieronder)
  };

enum ENUM_RICHTING
  {
   RICHTING_BEIDE = 0,   // Long en short
   RICHTING_LONG  = 1,   // Alleen long
   RICHTING_SHORT = 2    // Alleen short
  };

input group "Sessie"
input ENUM_SESSIE  Sessie               = SESSIE_NEWYORK; // Welke opening
input int          EigenStartUur        = 16;   // Eigen starttijd: uur (brokertijd)
input int          EigenStartMinuut     = 30;   // Eigen starttijd: minuut
input int          RangeMinuten         = 15;   // Lengte van de openingsrange (minuten)
input int          LaatsteInstapMinuten = 150;  // Niet meer instappen na X minuten na de opening
input int          SluitNaMinuten       = 385;  // Positie sluiten X minuten na de opening

input group "Trade"
input double       WinstFactorR         = 2.0;  // Winstdoel = factor x risico (R)
input double       RisicoProcent        = 1.0;  // Risico per trade in % van het saldo
input ENUM_RICHTING Richting            = RICHTING_BEIDE;
input int          MaxSpreadPunten      = 0;    // Niet instappen bij grotere spread (0 = uit)
input double       MinRangePunten       = 0;    // Range kleiner dan dit: overslaan (0 = uit)
input double       MaxRangePunten       = 0;    // Range groter dan dit: overslaan (0 = uit)

input group "Overig"
input long         MagicNummer          = 240611;
input bool         Vrijdag              = true;  // Ook op vrijdag handelen

CTrade   trade;
int      g_dag       = -1;
bool     g_rangeKlaar = false;
bool     g_klaarVandaag = false;
double   g_hoog = 0, g_laag = 0;
datetime g_laatsteBar = 0;
string   g_status = "";

//+------------------------------------------------------------------+
int OnInit()
  {
   trade.SetExpertMagicNumber(MagicNummer);
   trade.SetDeviationInPoints(30);
   if(RangeMinuten < 1 || WinstFactorR <= 0 || RisicoProcent <= 0 || RisicoProcent > 10)
     {
      Print("Ongeldige instellingen");
      return INIT_PARAMETERS_INCORRECT;
     }
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { Comment(""); }

//+------------------------------------------------------------------+
datetime OpeningVandaag(const MqlDateTime &nu)
  {
   MqlDateTime o = nu;
   o.sec = 0;
   if(Sessie == SESSIE_NEWYORK)      { o.hour = 16; o.min = 30; }
   else if(Sessie == SESSIE_LONDEN)  { o.hour = 10; o.min = 0;  }
   else                              { o.hour = EigenStartUur; o.min = EigenStartMinuut; }
   return StructToTime(o);
  }

bool HeeftPositie()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNummer)
         return true;
     }
   return false;
  }

void SluitAlles(const string reden)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNummer)
        {
         if(trade.PositionClose(t)) PrintFormat("Positie gesloten (%s)", reden);
        }
     }
  }

// Lotgrootte zodat verlies bij de stop = RisicoProcent van het saldo
double BerekenLots(const double afstand)
  {
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickValue <= 0) tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double stap   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(tickSize <= 0 || tickValue <= 0 || stap <= 0 || afstand <= 0) return 0;

   double risicoGeld  = AccountInfoDouble(ACCOUNT_BALANCE) * RisicoProcent / 100.0;
   double verliesPerLot = afstand / tickSize * tickValue;
   double lots = MathFloor(risicoGeld / verliesPerLot / stap) * stap;
   if(lots < minLot)
     {
      // Kleinste lot is te groot voor dit saldo: alleen toestaan als het risico max 2x het doel is
      if(minLot * verliesPerLot <= 2.0 * risicoGeld) lots = minLot;
      else
        {
         PrintFormat("Overgeslagen: kleinste lot (%.2f) riskeert %.2f, doel is %.2f", minLot, minLot * verliesPerLot, risicoGeld);
         return 0;
        }
     }
   return MathMin(lots, maxLot);
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   datetime nu = TimeCurrent();
   MqlDateTime d;
   TimeToStruct(nu, d);
   if(d.day_of_week == 0 || d.day_of_week == 6) return;
   if(d.day_of_week == 5 && !Vrijdag) return;

   // nieuwe dag: alles resetten
   if(d.day_of_year != g_dag)
     {
      g_dag = d.day_of_year;
      g_rangeKlaar = false;
      g_klaarVandaag = false;
      g_hoog = 0; g_laag = 0;
     }

   datetime opening    = OpeningVandaag(d);
   datetime rangeEinde = opening + RangeMinuten * 60;
   datetime laatste    = opening + LaatsteInstapMinuten * 60;
   datetime sluit      = opening + SluitNaMinuten * 60;

   bool open = HeeftPositie();
   if(open && nu >= sluit) { SluitAlles("eindtijd"); open = false; }

   if(nu < rangeEinde)
     {
      g_status = StringFormat("Wacht op range %s - %s", TimeToString(opening, TIME_MINUTES), TimeToString(rangeEinde, TIME_MINUTES));
      Comment("Night Desk ORB\n", g_status);
      return;
     }

   // range bepalen uit de M1-candles van de opening
   if(!g_rangeKlaar)
     {
      MqlRates r[];
      int n = CopyRates(_Symbol, PERIOD_M1, opening, rangeEinde - 1, r);
      g_rangeKlaar = true;
      if(n < MathMax(1, RangeMinuten / 2))
        {
         g_klaarVandaag = true;   // feestdag / geen data
         g_status = "Geen data voor de range vandaag";
        }
      else
        {
         g_hoog = r[0].high; g_laag = r[0].low;
         for(int i = 1; i < n; i++) { g_hoog = MathMax(g_hoog, r[i].high); g_laag = MathMin(g_laag, r[i].low); }
         double rangePt = (g_hoog - g_laag) / _Point;
         if((MinRangePunten > 0 && rangePt < MinRangePunten) || (MaxRangePunten > 0 && rangePt > MaxRangePunten))
           {
            g_klaarVandaag = true;
            g_status = StringFormat("Range %.0f punten buiten grenzen, vandaag geen trade", rangePt);
           }
         else g_status = StringFormat("Range %s - %s, wacht op uitbraak", DoubleToString(g_laag, _Digits), DoubleToString(g_hoog, _Digits));
        }
     }

   Comment("Night Desk ORB\n", g_status);
   if(g_klaarVandaag || open || nu > laatste) return;

   // alleen beslissen op een afgesloten M1-candle
   datetime barTijd = iTime(_Symbol, PERIOD_M1, 0);
   if(barTijd == g_laatsteBar) return;
   g_laatsteBar = barTijd;
   double slot = iClose(_Symbol, PERIOD_M1, 1);
   if(iTime(_Symbol, PERIOD_M1, 1) < rangeEinde) return;

   if(MaxSpreadPunten > 0 && SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) > MaxSpreadPunten) return;

   int stopsLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   if(slot > g_hoog && Richting != RICHTING_SHORT)
     {
      double sl = g_laag, afstand = ask - sl;
      if(afstand <= stopsLevel * _Point) return;
      double tp = NormalizeDouble(ask + WinstFactorR * afstand, _Digits);
      double lots = BerekenLots(afstand);
      g_klaarVandaag = true;
      if(lots > 0 && trade.Buy(lots, _Symbol, 0, NormalizeDouble(sl, _Digits), tp, "NightDesk ORB long"))
         g_status = StringFormat("LONG %.2f lot, stop %s, doel %s", lots, DoubleToString(sl, _Digits), DoubleToString(tp, _Digits));
     }
   else if(slot < g_laag && Richting != RICHTING_LONG)
     {
      double sl = g_hoog, afstand = sl - bid;
      if(afstand <= stopsLevel * _Point) return;
      double tp = NormalizeDouble(bid - WinstFactorR * afstand, _Digits);
      double lots = BerekenLots(afstand);
      g_klaarVandaag = true;
      if(lots > 0 && trade.Sell(lots, _Symbol, 0, NormalizeDouble(sl, _Digits), tp, "NightDesk ORB short"))
         g_status = StringFormat("SHORT %.2f lot, stop %s, doel %s", lots, DoubleToString(sl, _Digits), DoubleToString(tp, _Digits));
     }
   Comment("Night Desk ORB\n", g_status);
  }
//+------------------------------------------------------------------+
