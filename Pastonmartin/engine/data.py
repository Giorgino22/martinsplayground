"""Daten von football-data.co.uk holen und in ein einheitliches Format bringen.

Jede Liga/Saison ist dort eine CSV-Datei. Leider heissen die Spalten nicht in
allen Jahren gleich, deshalb übersetzen wir alles in unsere eigenen Spaltennamen:

    league, season, date, time, home, away, hg, ag            (Spiel + Resultat)
    shots_h, shots_a, sot_h, sot_a                            (Schüsse / Schüsse aufs Tor)
    ref_h, ref_d, ref_a, ref_over, ref_under                  (Referenzquote vor dem Spiel, siehe unten)
    avg_*                                                     (Marktdurchschnitt vor dem Spiel)
    book_*                                                    (ein einzelner Buchmacher: Bet365)
    max_*                                                     (höchste Quote aller Buchmacher)
    refc_*, bookc_*, maxc_*                                   (dasselbe als Schlussquote kurz vor Anpfiff)
    ref_name                                                  (woher die Referenz kommt)

Referenz = die genaueste Quote, die es gibt: Pinnacle. Seit Anfang 2026 liefert
football-data.co.uk keine Pinnacle-Quoten mehr, dann nehmen wir Betfair Exchange
(eine Wettbörse, fast ohne Marge) und sonst den Durchschnitt aller Buchmacher.

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

# Quoten kommen immer als Gruppe: (Heim, Remis, Gast) oder (Über 2.5, Unter 2.5).
# Pro Spiel nehmen wir die ERSTE Gruppe, deren Quoten vollständig und plausibel sind.
# So mischen wir nie Quoten verschiedener Buchmacher, und kaputte Quoten (z.B. von einer
# Wettbörse ohne Umsatz: 1.02 und 1.25) fliegen raus.
WINNER = ("h", "d", "a")
GOALS = ("over", "under")


def _trio(prefix):
    return (f"{prefix}H", f"{prefix}D", f"{prefix}A")


def _duo(prefix):
    return (f"{prefix}>2.5", f"{prefix}<2.5")


ODDS_GROUPS = {
    # (unser Präfix, Ausgänge): Kandidaten in der Reihenfolge, in der sie bevorzugt werden
    ("ref", WINNER): [_trio("PS"), _trio("BFE"), _trio("Avg"), _trio("BbAv")],
    ("ref", GOALS): [_duo("P"), _duo("BFE"), _duo("Avg"), _duo("BbAv")],
    ("avg", WINNER): [_trio("Avg"), _trio("BbAv")],
    ("avg", GOALS): [_duo("Avg"), _duo("BbAv")],
    ("book", WINNER): [_trio("B365")],
    ("book", GOALS): [_duo("B365"), _duo("Avg"), _duo("BbAv")],
    ("max", WINNER): [_trio("Max"), _trio("BbMx")],
    ("max", GOALS): [_duo("Max"), _duo("BbMx")],
    # Schlussquoten (kurz vor Anpfiff)
    ("refc", WINNER): [_trio("PSC"), _trio("BFEC"), _trio("AvgC")],
    ("refc", GOALS): [_duo("PC"), _duo("BFEC"), _duo("AvgC")],
    ("bookc", WINNER): [_trio("B365C")],
    ("bookc", GOALS): [_duo("B365C")],
    ("maxc", WINNER): [_trio("MaxC")],
    ("maxc", GOALS): [_duo("MaxC")],
}

# Die Extra-Ligen (z.B. Schweiz) haben nur Schlussquoten. Dann nehmen wir diese
# auch als "Quote vor dem Spiel". Das ist weniger realistisch, aber besser als nichts.
CLOSING_FALLBACK = {
    ("ref", WINNER): [_trio("PSC"), _trio("BFEC"), _trio("AvgC")],
    ("avg", WINNER): [_trio("AvgC")],
    ("book", WINNER): [_trio("B365C"), _trio("AvgC")],
    ("max", WINNER): [_trio("MaxC")],
}

# Plausible Summe der Wahrscheinlichkeiten (1/Quote). Höchstquoten aus vielen Buchmachern
# dürfen unter 100 % liegen, ein einzelner Buchmacher kaum.
PLAUSIBLE = {"max": (0.85, 1.15), "maxc": (0.85, 1.15)}
PLAUSIBLE_DEFAULT = (0.97, 1.25)

# Welche Quelle steckt in der Referenz? (für die Anzeige auf der Website)
REFERENCE_NAMES = {"PS": "Pinnacle", "PSC": "Pinnacle", "BFE": "Betfair", "BFEC": "Betfair",
                   "Avg": "Marktschnitt", "AvgC": "Marktschnitt", "BbAv": "Marktschnitt"}

# Spielstatistik (nicht in allen Ligen vorhanden)
STAT_COLUMNS = {"shots_h": ["HS"], "shots_a": ["AS"], "sot_h": ["HST"], "sot_a": ["AST"]}

ODDS_COLUMNS = [f"{prefix}_{suffix}" for prefix, suffixes in ODDS_GROUPS for suffix in suffixes]
COLUMNS = (["league", "season", "date", "time", "home", "away", "hg", "ag"]
           + list(STAT_COLUMNS) + ODDS_COLUMNS + ["ref_name"])


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
    """Werte aus der ersten Spalte von `names`, Lücken gefüllt aus den nächsten."""
    result = pd.Series(np.nan, index=df.index)
    for name in names:
        if name in df.columns:
            result = result.fillna(pd.to_numeric(df[name], errors="coerce"))
    return result


def _pick_group(raw, candidates, bounds):
    """Pro Spiel die erste Spaltengruppe, deren Quoten vollständig und plausibel sind.

    Gibt (Quoten-Tabelle, Name der gewählten Gruppe pro Spiel) zurück.
    """
    width = len(candidates[0])
    quotes = np.full((len(raw), width), np.nan)
    chosen = np.full(len(raw), None, dtype=object)
    for columns in candidates:
        if not all(c in raw.columns for c in columns):
            continue
        values = np.column_stack([pd.to_numeric(raw[c], errors="coerce").to_numpy(dtype=float) for c in columns])
        with np.errstate(divide="ignore", invalid="ignore"):
            total = (1.0 / np.where(values > 1.0, values, np.nan)).sum(axis=1)   # NaN, wenn eine Quote fehlt
        usable = (total >= bounds[0]) & (total <= bounds[1]) & np.isnan(quotes[:, 0])
        quotes[usable] = values[usable]
        chosen[usable] = columns[0]
    return quotes, chosen


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
    for column, names in STAT_COLUMNS.items():
        df[column] = _pick(raw, names)

    is_extra = "HomeTeam" not in raw.columns
    for (prefix, suffixes), candidates in ODDS_GROUPS.items():
        if is_extra:
            candidates = candidates + CLOSING_FALLBACK.get((prefix, suffixes), [])
        quotes, chosen = _pick_group(raw, candidates, PLAUSIBLE.get(prefix, PLAUSIBLE_DEFAULT))
        for i, suffix in enumerate(suffixes):
            df[f"{prefix}_{suffix}"] = quotes[:, i]
        if (prefix, suffixes) == ("ref", WINNER):
            # "PSH" -> "PS" -> "Pinnacle"
            df["ref_name"] = [REFERENCE_NAMES.get(c[:-1]) if c else None for c in chosen]

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
