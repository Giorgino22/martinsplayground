"""Tipps für die kommenden Spiele + die letzten Resultate fürs Wett-Tagebuch.

Schreibt zwei Dateien für die Website:
  site/data/tips.json     kommende Spiele mit Wahrscheinlichkeiten und Mindestquoten
  site/data/results.json  Resultate der letzten 60 Tage (zum Abrechnen der Wetten)
"""
import json
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

import config
import data
import model
import oddsapi
from backtest import clean
from odds import fair_probs, min_odds

SELECTIONS = {
    "1X2": [("H", "1", "Heimsieg"), ("D", "X", "Unentschieden"), ("A", "2", "Auswärtssieg")],
    "OU": [("O", "Ü2.5", "Über 2.5 Tore"), ("U", "U2.5", "Unter 2.5 Tore")],
}
REF = {"H": "ref_h", "D": "ref_d", "A": "ref_a", "O": "ref_over", "U": "ref_under"}
BOOK = {"H": "book_h", "D": "book_d", "A": "book_a", "O": "book_over", "U": "book_under"}
CLOSE = {"H": "refc_h", "D": "refc_d", "A": "refc_a", "O": "refc_over", "U": "refc_under"}


def load_params():
    """Die Einstellungen, die der letzte Backtest gewählt hat."""
    path = config.OUT_DIR / "backtest.json"
    if path.exists():
        return {**config.DEFAULT_PARAMS, **json.loads(path.read_text())["params"]}
    return dict(config.DEFAULT_PARAMS)


def kickoff_utc(day, time_text):
    """football-data gibt englische Zeit an. Wir speichern UTC, die Website zeigt Schweizer Zeit."""
    try:
        hour, minute = (int(x) for x in str(time_text).split(":")[:2])
    except ValueError:
        return None
    local = datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZoneInfo("Europe/London"))
    return local.astimezone(timezone.utc).isoformat()


def number(value):
    return None if value is None or pd.isna(value) else float(value)


def market_tips(row, prediction, market, w, edge_needed):
    """Wahrscheinlichkeiten und Mindestquoten für einen Markt eines Spiels.

    Ohne Marktquote gibt es keine Mindestquote: Das eigene Modell allein hat im
    Backtest klar verloren, darauf soll man nicht wetten.
    """
    keys = [key for key, _, _ in SELECTIONS[market]]
    ref_odds = [number(getattr(row, REF[k], None)) for k in keys]
    market_p = fair_probs(*ref_odds) if all(ref_odds) else None
    model_p = [prediction[k] for k in keys] if prediction else None
    if market_p is None and model_p is None:
        return None

    entries = []
    for i, (key, short, name) in enumerate(SELECTIONS[market]):
        p_market = float(market_p[i]) if market_p is not None else None
        p_model = model_p[i] if model_p is not None else None
        if p_market is None:
            p = None                                   # nicht wettbar
        elif p_model is None:
            p = p_market                               # Modell kennt ein Team nicht
        else:
            p = w * p_model + (1 - w) * p_market       # die Kombination
        entries.append({
            "key": key, "short": short, "name": name,
            "p_model": p_model, "p_market": p_market, "p": p,
            "fair": 1 / p if p else None,
            "min_odds": min_odds(p, edge_needed) if p else None,
            "bet365": number(getattr(row, BOOK[key], None)),
        })
    return {"bettable": market_p is not None, "edge": edge_needed, "selections": entries}


def run():
    params = load_params()
    today = pd.Timestamp.now(tz="Europe/Zurich").normalize().tz_localize(None)
    current = config.season_of(today)
    print(f"Einstellungen: {params}")

    # 1. Modell pro Liga mit allen Spielen bis heute lernen
    histories, models = {}, {}
    for code in config.LEAGUES:
        histories[code] = data.load_league(code, current - 2, current)
        models[code] = model.fit(histories[code], today + pd.Timedelta(days=1), params["decay"])
        print(f"  {code}: {len(histories[code])} Spiele, Modell {'ok' if models[code] else 'fehlt'}")

    # 2. Kommende Spiele + Quoten
    fixtures = data.load_fixtures()
    fixtures["kickoff"] = [kickoff_utc(d, t) for d, t in zip(fixtures["date"], fixtures["time"])]
    fixtures["ref_source"] = "football-data"
    api_key = os.environ.get("ODDS_API_KEY", "").strip()
    if api_key:
        known = {code: set(df["home"]) | set(df["away"]) for code, df in histories.items()}
        api_leagues = {k: v for k, v in config.LEAGUES.items() if v.get("odds_api")}
        fixtures = oddsapi.merge(fixtures, api_leagues, known, api_key)
    fixtures = fixtures[fixtures["date"] >= today].sort_values(["date", "kickoff", "league"], na_position="last")

    # 3. Tipps berechnen
    matches = []
    for row in fixtures.itertuples():
        fitted = models.get(row.league)
        prediction = fitted.predict(row.home, row.away) if fitted else None
        markets = {
            "1X2": market_tips(row, prediction, "1X2", params["w_1x2"], params["edge_1x2"]),
            "OU": market_tips(row, prediction, "OU", params["w_ou"], params["edge_ou"]),
        }
        markets = {k: v for k, v in markets.items() if v}
        if not markets:
            continue
        expected = fitted.expected_goals(row.home, row.away) if prediction else None
        matches.append({
            "id": data.match_id(row.league, row.date, row.home, row.away),
            "league": row.league,
            "date": f"{row.date:%Y-%m-%d}",
            "kickoff": row.kickoff if isinstance(row.kickoff, str) else None,
            "home": row.home, "away": row.away,
            "expected_goals": [round(float(g), 2) for g in expected] if expected else None,
            # Woher die Marktquote kommt: Pinnacle, Betfair, Marktschnitt (oder keine)
            "reference": ("Pinnacle live" if row.ref_source == "odds-api"
                          else (row.ref_name if isinstance(row.ref_name, str) else None)),
            "markets": markets,
        })

    tips = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "params": params,
        "kelly_fraction": config.KELLY_FRACTION,
        "max_stake": config.MAX_STAKE,
        "leagues": {code: cfg["name"] for code, cfg in config.LEAGUES.items()},
        "odds_api": bool(api_key),
        "matches": matches,
    }
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    (config.OUT_DIR / "tips.json").write_text(json.dumps(clean(tips), indent=1, ensure_ascii=False))
    print(f"{len(matches)} kommende Spiele -> tips.json")

    # 4. Resultate der letzten 60 Tage, mit fairen Schlussquoten (für den CLV im Tagebuch)
    recent = pd.concat(histories.values(), ignore_index=True)
    recent = recent[recent["date"] >= today - pd.Timedelta(days=60)]
    results = []
    for row in recent.itertuples():
        closing = {}
        for market in SELECTIONS.values():
            keys = [k for k, _, _ in market]
            closing_odds = [number(getattr(row, CLOSE[k])) for k in keys]
            if all(closing_odds):
                closing.update(zip(keys, (float(p) for p in fair_probs(*closing_odds))))
        results.append({
            "id": data.match_id(row.league, row.date, row.home, row.away),
            "league": row.league, "date": f"{row.date:%Y-%m-%d}",
            "home": row.home, "away": row.away, "hg": int(row.hg), "ag": int(row.ag),
            "closing_fair": closing,
        })
    (config.OUT_DIR / "results.json").write_text(json.dumps(clean(
        {"generated": tips["generated"], "results": results}), indent=1, ensure_ascii=False))
    print(f"{len(results)} Resultate -> results.json")
