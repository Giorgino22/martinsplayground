# Pastonmartin

Value-Wetten für Sporttip. Die App sagt nicht „wer gewinnt?“, sondern
„ab welcher Quote lohnt sich diese Wette?“. Am Automaten vergleichst du dann nur
noch die Sporttip-Quote mit der **Mindestquote** in der App.

## Wie es funktioniert

```
 football-data.co.uk ──► Resultate ──► [1] Poisson-Modell ──► Wahrscheinlichkeit A
                    └──► Marktquoten ──► [2] Value-Finder ──► Wahrscheinlichkeit B
                                                                        │
                                                 P = w·A + (1−w)·B   (Kombination)
                                                                        │
                                         Mindestquote = (1 + Mindest-Value) / P
                                                                        │
                       Website: Sporttip-Quote eingeben ──► Value? Einsatz? ──► [3] Tagebuch
```

1. **Modell:** Jedes Team hat eine Angriffs- und eine Abwehrstärke, gelernt aus den
   letzten drei Jahren (neuere Spiele zählen mehr). Daraus folgen die erwarteten Tore
   und mit der Poisson-Verteilung die Chancen für 1/X/2 und über/unter 2.5.
2. **Value-Finder:** Aus den Marktquoten wird die Marge herausgerechnet. Am besten ist
   Pinnacle (der schärfste Buchmacher). Fehlt Pinnacle, nimmt das System Betfair Exchange
   und sonst den Durchschnitt aller Buchmacher. Ohne Marktquote zeigt die App keine
   Mindestquote, denn das Modell allein hat im Backtest klar verloren.
3. **Kombination + Backtest:** Wie stark das eigene Modell zählt (`w`), ab wie viel Value
   gewettet wird und wie schnell alte Spiele vergessen werden, sucht der Backtest in den
   Saisons 2016/17–2021/22. Geprüft wird danach **einmal** auf 2022/23–2025/26. Nur dieses
   Test-Resultat ist ehrlich.
4. **Einsatz:** ¼-Kelly, höchstens 2 % vom Budget.

### Ligen

Premier League, Championship, Bundesliga, 2. Bundesliga, Serie A, La Liga, Ligue 1,
Eredivisie und die Schweizer Super League.

Warum diese: Sie haben die besten Daten mit Pinnacle-Quoten über viele Jahre, und
Sporttip bietet sie alle an. Die zweiten Ligen (Championship, 2. Bundesliga) sind dabei,
weil Buchmacher dort weniger genau sind. Dort hat ein Modell am ehesten eine Chance.
Die Super League ist dabei, weil Sporttip sie besonders gut abdeckt. Allerdings gibt es
dort nur Schlussquoten, daher ist ihr Backtest weniger aussagekräftig.

### Ehrliche Grenzen

- **football-data.co.uk liefert seit ca. Januar 2026 keine Pinnacle-Quoten mehr.** Für
  frische Pinnacle-Quoten braucht es darum den Odds-API-Schlüssel (siehe Einrichten).

- Historische **Sporttip-Quoten gibt es nicht**. Der Backtest nimmt Bet365 minus 4 % als
  Ersatz (`SPORTTIP_HAIRCUT` in `engine/config.py`). Die App zeigt die echte Sporttip-Marge
  an, sobald du alle Quoten eines Marktes eintippst. Damit lässt sich die Schätzung prüfen.
- Ein Plus im Backtest kann Glück sein. Darum zeigt die App bei jedem Resultat, wie
  wahrscheinlich es auch ohne echten Vorteil wäre, und den **CLV** (Closing Line Value).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `engine/` | Python: Daten laden, Modell, Backtest, Tipps. Läuft in GitHub Actions. |
| `engine/config.py` | **Alle Einstellungen** (Ligen, Saisons, Grenzwerte) |
| `site/` | Die Website (statisch, Cloudflare Pages) |
| `site/data/` | Von GitHub Actions erzeugt: `tips.json`, `backtest.json`, `results.json` |
| `functions/api/bets.js` | Wett-Tagebuch in Cloudflare D1 |
| `../.github/workflows/pastonmartin.yml` | Der Zeitplan |

### Wann läuft was? (`.github/workflows/pastonmartin.yml`)

Cloudflare Pages kann nichts regelmässig laufen lassen, GitHub Actions schon (gratis).

- **Täglich 2×:** neue Resultate laden, Modell neu lernen, Tipps schreiben. Am Nachmittag
  mit frischen Pinnacle-Quoten, falls ein Odds-API-Schlüssel gesetzt ist.
- **Montags und bei jeder Änderung an `engine/`:** ganzer Backtest.
- **Von Hand:** GitHub → Actions → Pastonmartin → *Run workflow*.

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
3. **Pinnacle-Quoten (sehr empfohlen):** Gratis-Schlüssel bei [the-odds-api.com](https://the-odds-api.com)
   holen und auf GitHub unter *Settings → Secrets and variables → Actions* als
   **`ODDS_API_KEY`** speichern. Ein Lauf braucht ca. 18 der 500 Gratis-Abfragen pro Monat.
4. **Tipp:** Bei den anderen Pages-Projekten unter *Build watch paths* nur ihren eigenen
   Ordner eintragen. Sonst bauen sie bei jedem Daten-Commit des Roboters unnötig neu.

## Lokal ausprobieren

```bash
cd Pastonmartin/engine
pip install -r requirements.txt
python -m unittest          # Tests (ohne Internet)
python run.py backtest      # dauert ein paar Minuten
python run.py tips
cd ../site && python -m http.server   # -> http://localhost:8000
```
