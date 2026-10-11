# Pastonmartin

Value-Wetten für Sporttip. Die App sagt nicht „wer gewinnt?“, sondern
„ab welcher Quote lohnt sich diese Wette?“. Am Automaten vergleichst du dann nur
noch die Sporttip-Quote mit der **Mindestquote** in der App.

## Die wichtigste Erkenntnis aus dem Backtest

Gewinn entsteht nicht durch ein schlaueres Modell, sondern dort, **wo ein Buchmacher von
der fairen Quote abweicht**. Die fairste Quote der Welt kommt von Pinnacle und Betfair.
Darum rechnet die App die faire Quote aus deren Quoten aus. Wichtig ist dann, wo man wettet:

- Mit der jeweils besten Quote vieler Buchmacher („Max“, Ø Marge 1.4 %) findet das System viel
  Value, und das robust: über 16'000 Wetten, CLV +2.5 % in jeder einzelnen Saison.
  So machen professionelle Wetter ihren Gewinn. In der Schweiz ist das legal aber nicht möglich.
- Bei einem einzelnen Buchmacher mit ca. 6 % Marge (Bet365) bleibt kleiner, echter Value (CLV ca. +0.8 %).
- Bei einem Buchmacher mit ca. 10 % Marge (unsere Sporttip-Schätzung) gibt es nur noch
  ca. 10 bis 20 Value-Wetten pro Saison über alle 9 Ligen.

Wie gut Sporttip wirklich ist, misst das Tagebuch („Gemessene Sporttip-Marge“).
Das eigene Modell (Tore, Schüsse aufs Tor, Dixon-Coles) ist deutlich besser geworden,
schlägt den Markt aber nicht und bekommt darum 0 % Gewicht. Die Ergebnisse aller
Experimente stehen auf der Website unter „Backtest“.

## Wie es funktioniert

```
 football-data.co.uk ─► Resultate, Schüsse ─► [1] Poisson-Modell ─────────► Modellchance
                    └─► Marktquoten ─► Plausibilität ─► Power/Shin ───────► faire Marktchance
                                                                                 │
                                    [2] Kombination (log-Pool, Gewicht aus dem Backtest)
                                                                                 │
                         [3] Nebenmärkte über erwartete Tore: Doppelte Chance, Ü/U 1.5/3.5, Beide treffen
                                                                                 │
                                           Mindestquote = (1 + Mindest-Value) / Chance
                                                                                 │
              Website: Sporttip-Quote eintragen ─► Value? Einsatz? ─► Tagebuch / Kombi
```

1. **Faire Marktchance:** Pro Spiel die erste vollständige und plausible Quotengruppe
   (Pinnacle, sonst Betfair Exchange, sonst Marktschnitt). Die Marge wird mit der Methode
   herausgerechnet, die im Backtest am genausten war (Power- oder Shin-Methode, beide
   etwas genauer als die einfache): Sie geben Aussenseitern weniger Chance.
2. **Eigenes Modell:** Jedes Team hat eine Angriffs- und eine Abwehrstärke, gelernt aus Toren
   und Schüssen aufs Tor der letzten drei Jahre (neuere Spiele zählen mehr), mit
   Dixon-Coles-Korrektur für 0:0 und 1:1.
3. **Kombination:** logarithmischer Pool von Markt und Modell. Die Gewichte lernt der Backtest,
   gewählt wird per Kreuzvalidierung.
4. **Nebenmärkte:** Aus Sieger- und Torquoten werden die erwarteten Tore bestimmt
   (`markets.implied_goals`). Daraus folgen Doppelte Chance, Über/Unter 1.5/3.5 und Beide treffen.
   Der Backtest prüft, dass diese Chancen stimmen (Kalibrierung).
5. **Einsatz:** ¼-Kelly, höchstens 2 % vom Budget.

### Der Backtest (`engine/backtest.py`)

- Saisons 2016/17–2021/22: hier wird gewählt (Modellvariante, Margen-Methode, Kombination,
  Mindest-Value, Höchstquote). 27 Modellvarianten laufen parallel auf allen CPU-Kernen.
- Saisons 2022/23–2025/26: **einmal** testen. Nur dieses Resultat ist ehrlich.
- Verglichen wird: früh (1–3 Tage vorher) gegen kurz vor Anpfiff, und
  Sporttip-Schätzung (Bet365 minus 4 %) gegen Bet365 gegen Höchstquote aller Buchmacher.

### Ligen

Premier League, Championship, Bundesliga, 2. Bundesliga, Serie A, La Liga, Ligue 1,
Eredivisie und die Schweizer Super League (dort nur Schlussquoten, darum weniger aussagekräftig).
Unter **„Sport“** auf der Website gibt es zusätzlich einen Value-Finder für jede Sportart, die
The Odds API kennt (Tennis, Eishockey, Basketball, …), nur mit Live-Marktquoten.

### Ehrliche Grenzen

- **football-data.co.uk liefert seit ca. Januar 2026 keine Pinnacle-Quoten mehr** (dann Betfair).
  Für Pinnacle braucht es den Odds-API-Schlüssel (siehe Einrichten).
- Historische **Sporttip-Quoten gibt es nicht**. Die App misst die echte Sporttip-Marge, sobald
  du alle Quoten eines Marktes eintippst.
- Ein Plus im Backtest kann Glück sein. Darum zeigt die App bei jedem Resultat, wie
  wahrscheinlich es auch ohne echten Vorteil wäre, und den **CLV** (Closing Line Value).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `engine/config.py` | **Alle Einstellungen** (Ligen, Saisons, Grenzwerte, getestete Varianten) |
| `engine/data.py` | Daten laden, Spalten vereinheitlichen, Plausibilität der Quoten |
| `engine/odds.py` | Marge herausrechnen (proportional, Power, Shin), Value, Kelly |
| `engine/markets.py` | Wettarten aus erwarteten Toren und umgekehrt |
| `engine/model.py` | Eigenes Poisson-Modell |
| `engine/combine.py` | Markt und Modell kombinieren |
| `engine/backtest.py` | Alle Experimente, Auswahl, Test |
| `engine/tips.py` | Tipps für kommende Spiele, Resultate fürs Tagebuch |
| `site/` | Die Website (statisch, Cloudflare Pages) |
| `site/js/fair.js` | Dieselbe Rechnung in JavaScript (für Live-Quoten); ein Test prüft, dass sie gleich rechnet |
| `site/data/` | Von GitHub Actions erzeugt: `tips.json`, `backtest.json`, `results.json` |
| `functions/api/odds.js` | Live-Quoten von The Odds API (5 Minuten zwischengespeichert) |
| `functions/api/bets.js` | Wett-Tagebuch in Cloudflare D1 |
| `../.github/workflows/pastonmartin.yml` | Der Zeitplan |

### Wann läuft was?

Cloudflare Pages kann nichts regelmässig laufen lassen, GitHub Actions schon (gratis).

- **Täglich 2×:** neue Resultate laden, Modell neu lernen, Tipps schreiben.
- **Montags und bei jeder Änderung an `engine/`:** ganzer Backtest (ca. 2 Minuten).
- **Von Hand:** GitHub → Actions → Pastonmartin → *Run workflow*.
- **Live-Quoten:** auf der Website per Knopfdruck (Cloudflare-Function, nicht GitHub).

Der Roboter committet die neuen JSON-Dateien. Cloudflare Pages veröffentlicht sie dann automatisch.

## Einrichten

1. **Cloudflare Pages:** neues Projekt aus diesem Repo.
   - Root directory: `Pastonmartin`
   - Build output directory: `site` (relativ zum Root directory, also *nicht* `Pastonmartin/site`)
   - Kein Build-Befehl
   - Domain `pastonmartin.odermatts.ch` + CNAME bei Hostpoint
2. **Tagebuch in der Cloud (empfohlen):** D1-Datenbank erstellen und im Pages-Projekt als
   Binding **`DB`** verbinden. Zusätzlich eine Variable **`JOURNAL_KEY`** setzen (beliebiges
   Passwort), sonst kann jeder mit dem Link dein Tagebuch lesen und ändern. Ohne D1
   speichert die Seite im Browser, dann ist das Tagebuch nur auf diesem einen Gerät.
3. **Live-Quoten (sehr empfohlen):** Gratis-Schlüssel bei [the-odds-api.com](https://the-odds-api.com)
   holen und im Pages-Projekt als Variable **`ODDS_API_KEY`** speichern (als Secret).
   Jede Liga kostet pro Abfrage 2 der 500 Gratis-Abfragen pro Monat.
   Optional zusätzlich als GitHub-Secret `ODDS_API_KEY`: dann holt auch der Roboter am
   Nachmittag Pinnacle-Quoten (ca. 18 Abfragen pro Lauf).
4. **Tipp:** Bei den anderen Pages-Projekten unter *Build watch paths* nur ihren eigenen
   Ordner eintragen. Sonst bauen sie bei jedem Daten-Commit des Roboters unnötig neu.

## Lokal ausprobieren

```bash
cd Pastonmartin/engine
pip install -r requirements.txt
python -m unittest          # Tests (ohne Internet; mit Node.js auch die JavaScript-Tests)
python run.py backtest      # ein paar Minuten
python run.py tips
cd ../site && python -m http.server   # -> http://localhost:8000 (ohne Live-Quoten und Cloud-Tagebuch)
```
