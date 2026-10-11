# Pastonmartin

Sportwetten-Analyse: alte Daten auswerten, eigene Wahrscheinlichkeiten berechnen
und mit den Quoten der Buchmacher vergleichen. Ziel ist nicht „wer gewinnt?“,
sondern „wo ist die Quote zu hoch für das echte Risiko?“ (Value Bets).

> Status: Konzeptphase. Noch kein Code — zuerst Richtung festlegen.

## Kernidee in einem Satz

Wette nur, wenn `deine Wahrscheinlichkeit × Quote > 1`.
Beispiel: Modell sagt 50 %, Quote ist 2.20 → 0.50 × 2.20 = 1.10 → +10 % erwarteter Gewinn.

## Mögliche Richtungen

| Option | Was es macht | Realistisch? |
|---|---|---|
| A. Prognose-Modell (z.B. Fussball, Poisson/Elo) | Rechnet Torwahrscheinlichkeiten aus alten Resultaten | Gut zum Lernen, schlägt den Markt selten allein |
| B. Value-Finder | Vergleicht scharfe Quoten (Marktkonsens) mit weichen Buchmachern | Bewährteste Methode, braucht Quoten-API |
| C. Wett-Tagebuch + Auswertung | Trackt jede Wette, Rendite, Closing Line Value | Einfach, ehrlich, sehr nützlich |

Vorschlag: A + C zuerst (lernen + messen), B später.

## Mögliche Datenquellen

- football-data.co.uk — gratis CSVs mit Resultaten **und** historischen Quoten (Fussball)
- The Odds API — aktuelle Quoten vieler Buchmacher (Free-Tier vorhanden)

## Bankroll-Regeln (fest eingebaut)

- Fixes Wett-Budget, nie nachschiessen.
- Einsatz pro Wette: 1–2 % des Budgets (oder ¼-Kelly).
- Jede Wette loggen; nach ≥ 300 Wetten ehrlich auswerten.
