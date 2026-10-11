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
PIN = {"H": "pin_h", "D": "pin_d", "A": "pin_a", "O": "pin_over", "U": "pin_under"}
BOOK = {"H": "book_h", "D": "book_d", "A": "book_a", "O": "book_over", "U": "book_under"}
CLOSE = {"H": "pinc_h", "D": "pinc_d", "A": "pinc_a", "O": "pinc_over", "U": "pinc_under"}


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
    """Wahrscheinlichkeiten und Mindestquoten für einen Markt eines Spiels."""
    keys = [key for key, _, _ in SELECTIONS[market]]
    pin_odds = [number(getattr(row, PIN[k], None)) for k in keys]
    pin = fair_probs(*pin_odds) if all(pin_odds) else None
    mod = [prediction[k] for k in keys] if prediction else None
    if pin is None and mod is None:
        return None

    entries = []
    for i, (key, short, name) in enumerate(SELECTIONS[market]):
        p_pin = float(pin[i]) if pin is not None else None
        p_mod = mod[i] if mod is not None else None
        if p_pin is not None and p_mod is not None:
            p = w * p_mod + (1 - w) * p_pin
        else:
            p = p_pin if p_pin is not None else p_mod
        entries.append({
            "key": key, "short": short, "name": name,
            "p_model": p_mod, "p_market": p_pin, "p": p,
            "fair": 1 / p, "min_odds": min_odds(p, edge_needed),
            "bet365": number(getattr(row, BOOK[key], None)),
        })
    return {
        "source": "kombiniert" if pin is not None and mod is not None
                  else ("nur Pinnacle" if pin is not None else "nur Modell"),
        "edge": edge_needed,
        "selections": entries,
    }


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
    fixtures["pin_source"] = "football-data"
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
            "odds_source": row.pin_source,
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
