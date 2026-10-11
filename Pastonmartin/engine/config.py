"""Alle Einstellungen an einem Ort.

Wer etwas am System ändern will (Ligen, Saisons, Grenzwerte), ändert es hier.
"""
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent
CACHE_DIR = ENGINE_DIR / "cache"                     # heruntergeladene CSVs (nicht im Git)
OUT_DIR = ENGINE_DIR.parent / "site" / "data"        # JSON für die Website

# --- Ligen -----------------------------------------------------------------
# Schlüssel = Code bei football-data.co.uk.
# "odds_api" = Name der Liga bei The Odds API (optional, für frische Pinnacle-Quoten).
# "extra" = Liga aus der "Extra Leagues"-Sammlung (anderes Dateiformat, nur Schlussquoten).
LEAGUES = {
    "E0":  {"name": "Premier League",   "country": "England",     "odds_api": "soccer_epl"},
    "E1":  {"name": "Championship",     "country": "England",     "odds_api": "soccer_efl_champ"},
    "D1":  {"name": "Bundesliga",       "country": "Deutschland", "odds_api": "soccer_germany_bundesliga"},
    "D2":  {"name": "2. Bundesliga",    "country": "Deutschland", "odds_api": "soccer_germany_bundesliga2"},
    "I1":  {"name": "Serie A",          "country": "Italien",     "odds_api": "soccer_italy_serie_a"},
    "SP1": {"name": "La Liga",          "country": "Spanien",     "odds_api": "soccer_spain_la_liga"},
    "F1":  {"name": "Ligue 1",          "country": "Frankreich",  "odds_api": "soccer_france_ligue_one"},
    "N1":  {"name": "Eredivisie",       "country": "Niederlande", "odds_api": "soccer_netherlands_eredivisie"},
    "SWZ": {"name": "Super League",     "country": "Schweiz",     "odds_api": "soccer_switzerland_superleague",
            "extra": True},
}

# --- Saisons ---------------------------------------------------------------
# Eine Saison wird über ihr Startjahr angegeben: 2016 = Saison 2016/17.
FIRST_SEASON = 2014                 # ab hier Daten laden (die ersten 2 Saisons nur zum "Aufwärmen")
TUNE_SEASONS = range(2016, 2022)    # 2016/17 – 2021/22: hier darf das System angepasst werden
TEST_SEASONS = range(2022, 2026)    # 2022/23 – 2025/26: nur EINMAL prüfen, nicht mehr daran drehen

# --- Modell ----------------------------------------------------------------
# Der Backtest probiert alle Kombinationen und wählt die beste (im Anpassungs-Zeitraum).
DECAY_GRID = [0.002, 0.003, 0.005]   # wie schnell alte Spiele an Gewicht verlieren (pro Tag)
SHOTS_GRID = [0.0, 0.4, 0.7]         # wie stark Schüsse aufs Tor statt Tore zählen
RHO_GRID = [0.0, -0.05, -0.1]        # Dixon-Coles-Korrektur für 0:0 und 1:1
RIDGE = 1.0                          # bremst extreme Teamstärken (wichtig bei wenig Daten)
HISTORY_DAYS = 3 * 365               # nur die letzten 3 Jahre anschauen
MIN_TEAM_MATCHES = 6.0               # so viele (gewichtete) Spiele braucht ein Team, sonst keine Prognose
MAX_GOALS = 10                       # Tore pro Team, die wir durchrechnen

# --- Wetten ----------------------------------------------------------------
BLEND_GRID = [i / 20 for i in range(21)]        # nur für die alte, lineare Mischung (v1)
EDGE_GRID = [0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.10]   # Mindest-Value, ab dem gewettet wird
MAX_ODDS_GRID = [2.5, 4.0, 8.0]     # höchste Quote, auf die gewettet wird
MIN_BETS_FOR_TUNING = {"1X2": 150, "OU": 75}   # weniger Wetten = zu viel Zufall
DERIVED_EXTRA_EDGE = 0.01           # Nebenmärkte (aus erwarteten Toren berechnet): 1 % mehr Value verlangen

# Sporttip-Quoten gibt es nicht historisch. Im Backtest nehmen wir Bet365
# und ziehen zusätzlich so viel ab. Das ist eine Schätzung, die die Website mit
# echten Sporttip-Quoten überprüft (Anzeige "Sporttip-Marge").
SPORTTIP_HAIRCUT = 0.04

KELLY_FRACTION = 0.25               # Einsatz = ¼ des Kelly-Einsatzes
MAX_STAKE = 0.02                    # nie mehr als 2 % des Budgets auf eine Wette

# Fallback-Werte, falls noch kein Backtest gelaufen ist.
DEFAULT_PARAMS = {
    "model": {"decay": 0.003, "shots_weight": 0.0, "rho": 0.0},
    "devig": "power",
    "combine": {"kind": "pool",
                "1X2": {"full": None, "ref_only": {"bias": [0, 0, 0], "w_market": 1.0, "w_model": 0.0}},
                "OU": {"full": None, "ref_only": {"bias": [0, 0], "w_market": 1.0, "w_model": 0.0}}},
    "edge": {"1X2": 0.03, "OU": 0.03},
    "max_odds": {"1X2": 4.0, "OU": 4.0},
    "derived_extra_edge": DERIVED_EXTRA_EDGE,
    "derived_rho": 0.0,
}


# --- Hilfsfunktionen für Saisons -------------------------------------------
def season_of(d):
    """Startjahr der Saison, in der das Datum liegt (Saisonwechsel am 1. Juli)."""
    return d.year if d.month >= 7 else d.year - 1


def season_code(year):
    """2016 -> '1617' (so heissen die Ordner bei football-data.co.uk)."""
    return f"{year % 100:02d}{(year + 1) % 100:02d}"


def season_label(year):
    """2016 -> '2016/17'."""
    return f"{year}/{(year + 1) % 100:02d}"
