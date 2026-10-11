"""Daten von football-data.co.uk holen und in ein einheitliches Format bringen.

Jede Liga/Saison ist dort eine CSV-Datei. Leider heissen die Spalten nicht in
allen Jahren gleich, deshalb übersetzen wir alles in unsere eigenen Spaltennamen:

    league, season, date, time, home, away, hg, ag            (Spiel + Resultat)
    pin_h, pin_d, pin_a, pin_over, pin_under                  (Pinnacle vor dem Spiel)
    avg_h, avg_d, avg_a, avg_over, avg_under                  (Marktdurchschnitt vor dem Spiel)
    book_h, book_d, book_a, book_over, book_under             (ein einzelner Buchmacher: Bet365)
    pinc_h, pinc_d, pinc_a, pinc_over, pinc_under             (Pinnacle Schlussquote)

Warum Bet365? Sporttip-Quoten gibt es nicht historisch. Ein einzelner Buchmacher
weicht (wie Sporttip) mal nach oben, mal nach unten vom Markt ab, ein Durchschnitt
dagegen glättet das weg. Darum ist Bet365 der realistischere Ersatz für Sporttip.
"""
import io
import time
import urllib.error
import urllib.request
from datetime import date

import numpy as np
import pandas as pd

import config

BASE_URL = "https://www.football-data.co.uk"

# Unser Spaltenname -> mögliche Namen in den CSVs (der erste vorhandene gewinnt).
ODDS_COLUMNS = {
    "pin_h": ["PSH"], "pin_d": ["PSD"], "pin_a": ["PSA"],
    "pin_over": ["P>2.5"], "pin_under": ["P<2.5"],
    "avg_h": ["AvgH", "BbAvH"], "avg_d": ["AvgD", "BbAvD"], "avg_a": ["AvgA", "BbAvA"],
    "avg_over": ["Avg>2.5", "BbAv>2.5"], "avg_under": ["Avg<2.5", "BbAv<2.5"],
    "book_h": ["B365H"], "book_d": ["B365D"], "book_a": ["B365A"],
    "book_over": ["B365>2.5", "Avg>2.5", "BbAv>2.5"], "book_under": ["B365<2.5", "Avg<2.5", "BbAv<2.5"],
    "pinc_h": ["PSCH"], "pinc_d": ["PSCD"], "pinc_a": ["PSCA"],
    "pinc_over": ["PC>2.5"], "pinc_under": ["PC<2.5"],
}

# Die Extra-Ligen (z.B. Schweiz) haben nur Schlussquoten. Dann nehmen wir diese
# auch als "Quote vor dem Spiel". Das ist weniger realistisch, aber besser als nichts.
CLOSING_FALLBACK = {
    "pin_h": ["PSCH"], "pin_d": ["PSCD"], "pin_a": ["PSCA"],
    "avg_h": ["AvgCH"], "avg_d": ["AvgCD"], "avg_a": ["AvgCA"],
    "book_h": ["B365CH", "AvgCH"], "book_d": ["B365CD", "AvgCD"], "book_a": ["B365CA", "AvgCA"],
}

COLUMNS = ["league", "season", "date", "time", "home", "away", "hg", "ag"] + list(ODDS_COLUMNS)


# --- Herunterladen mit Cache -------------------------------------------------
def fetch(path, max_age_hours=None):
    """Lädt BASE_URL/path und speichert die Datei im Cache.

    max_age_hours=None heisst: die Datei ändert sich nie mehr (alte Saison),
    also reicht die Kopie im Cache für immer. Gibt None zurück, wenn es die
    Datei (noch) nicht gibt.
    """
    cache_file = config.CACHE_DIR / path.replace("/", "_")
    if cache_file.exists():
        age_hours = (time.time() - cache_file.stat().st_mtime) / 3600
        if max_age_hours is None or age_hours < max_age_hours:
            return cache_file.read_bytes()

    url = f"{BASE_URL}/{path}"
    request = urllib.request.Request(url, headers={"User-Agent": "Pastonmartin/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content = response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        return _cached_or_raise(cache_file, url, error)
    except OSError as error:
        return _cached_or_raise(cache_file, url, error)

    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_bytes(content)
    return content


def _cached_or_raise(cache_file, url, error):
    if cache_file.exists():
        print(f"  ! {url} nicht erreichbar ({error}), nehme alte Kopie")
        return cache_file.read_bytes()
    raise RuntimeError(f"{url} nicht erreichbar: {error}") from error


def read_csv(content):
    """CSV-Bytes -> DataFrame. Manche Dateien sind nicht UTF-8, daher der Fallback."""
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    df = pd.read_csv(io.StringIO(text), on_bad_lines="skip", low_memory=False)
    return df.loc[:, ~df.columns.str.startswith("Unnamed")]


# --- Vereinheitlichen ----------------------------------------------------------
def _pick(df, names):
    """Erste vorhandene Spalte aus `names` als Zahlen, sonst eine leere Spalte."""
    for name in names:
        if name in df.columns:
            return pd.to_numeric(df[name], errors="coerce")
    return pd.Series(np.nan, index=df.index)


def normalize(raw, league):
    """Übersetzt eine football-data-CSV in unser Format (siehe oben)."""
    if raw.empty:
        return pd.DataFrame(columns=COLUMNS)

    # Hauptligen heissen "HomeTeam/FTHG", Extra-Ligen "Home/HG".
    home_col = "HomeTeam" if "HomeTeam" in raw.columns else "Home"
    away_col = "AwayTeam" if "AwayTeam" in raw.columns else "Away"

    df = pd.DataFrame(index=raw.index)
    df["league"] = league
    df["date"] = pd.to_datetime(raw["Date"], dayfirst=True, format="mixed", errors="coerce")
    df["time"] = raw["Time"].astype(str) if "Time" in raw.columns else ""
    df["home"] = raw[home_col].astype(str).str.strip()
    df["away"] = raw[away_col].astype(str).str.strip()
    df["hg"] = _pick(raw, ["FTHG", "HG"])
    df["ag"] = _pick(raw, ["FTAG", "AG"])

    for column, names in ODDS_COLUMNS.items():
        df[column] = _pick(raw, names)
        if column in CLOSING_FALLBACK:
            df[column] = df[column].fillna(_pick(raw, CLOSING_FALLBACK[column]))

    df = df.dropna(subset=["date"])
    df = df[(df["home"] != "nan") & (df["away"] != "nan")]
    df["season"] = df["date"].map(config.season_of)
    return df[COLUMNS]


def match_id(league, day, home, away):
    """Eindeutiger Name für ein Spiel, z.B. 'E0:2026-10-17:Arsenal:Chelsea'.

    Damit findet das Wett-Tagebuch später das Resultat zu einer Wette.
    """
    return f"{league}:{pd.Timestamp(day):%Y-%m-%d}:{home}:{away}"


# --- Ganze Ligen laden ---------------------------------------------------------
def load_league(league, first_season, last_season):
    """Alle gespielten Spiele einer Liga zwischen zwei Saisons, nach Datum sortiert."""
    current = config.season_of(date.today())
    frames = []

    if config.LEAGUES[league].get("extra"):
        # Extra-Ligen: eine einzige Datei mit allen Saisons.
        content = fetch(f"new/{league}.csv", max_age_hours=6)
        if content is not None:
            frames.append(normalize(read_csv(content), league))
    else:
        for season in range(first_season, last_season + 1):
            # Laufende Saison: alle 6 Stunden neu holen. Alte Saisons ändern sich nicht mehr.
            max_age = 6 if season >= current else None
            content = fetch(f"mmz4281/{config.season_code(season)}/{league}.csv", max_age)
            if content is not None:
                frames.append(normalize(read_csv(content), league))

    if not frames:
        return pd.DataFrame(columns=COLUMNS)
    df = pd.concat(frames, ignore_index=True)
    df = df[(df["season"] >= first_season) & (df["season"] <= last_season)]
    df = df.dropna(subset=["hg", "ag"])         # nur Spiele mit Resultat
    return df.sort_values("date", kind="stable").reset_index(drop=True)


def load_fixtures():
    """Kommende Spiele (mit Quoten) aus den Fixture-Dateien von football-data."""
    frames = []

    content = fetch("fixtures.csv", max_age_hours=2)
    if content is not None:
        raw = read_csv(content)
        if "Div" in raw.columns:
            for league in config.LEAGUES:
                part = raw[raw["Div"] == league]
                if len(part):
                    frames.append(normalize(part, league))

    # Extra-Ligen stehen in einer eigenen Datei, erkennbar am Land.
    extra = {cfg["country"]: code for code, cfg in config.LEAGUES.items() if cfg.get("extra")}
    content = fetch("new_league_fixtures.csv", max_age_hours=2)
    if content is not None:
        raw = read_csv(content)
        if "Country" in raw.columns:
            country_names = {"Schweiz": "Switzerland"}
            for country, league in extra.items():
                part = raw[raw["Country"] == country_names.get(country, country)]
                if len(part):
                    frames.append(normalize(part, league))

    if not frames:
        return pd.DataFrame(columns=COLUMNS)
    return pd.concat(frames, ignore_index=True)
