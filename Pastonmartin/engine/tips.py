"""Tipps für die kommenden Spiele + die letzten Resultate fürs Wett-Tagebuch.

Schreibt zwei Dateien für die Website:
  site/data/tips.json     kommende Spiele: faire Quoten und Mindestquoten für viele Wettarten
  site/data/results.json  Resultate der letzten 60 Tage (zum Abrechnen der Wetten)

Rechenweg pro Spiel (genau wie im Backtest):
  1. Marktquote (Pinnacle/Betfair/Schnitt) -> Marge herausrechnen -> faire Marktchance
  2. Eigenes Modell -> Modellchance
  3. Beide kombinieren (mit den Gewichten aus dem Backtest)
  4. Aus 1X2 + Über/Unter 2.5 die erwarteten Tore bestimmen -> Nebenmärkte
     (Doppelte Chance, Über/Unter 1.5/3.5, Beide treffen)
  5. Mindestquote = (1 + Mindest-Value) / Chance
"""
import json
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

import config
import data
import markets
import model
import oddsapi
import odds
from backtest import MARKETS, apply_combination, clean, odds_matrix

# Welche Schwellen gelten für welchen Markt? Nebenmärkte verlangen etwas mehr Value,
# weil sie nicht direkt aus einer Marktquote kommen, sondern berechnet sind.
MARKET_RULES = {"1X2": ("1X2", False), "DC": ("1X2", False), "OU": ("OU", False),
                "OU15": ("OU", True), "OU35": ("OU", True), "BTTS": ("OU", True)}


def load_params():
    """Die Einstellungen, die der letzte Backtest gewählt hat."""
    path = config.OUT_DIR / "backtest.json"
    if path.exists():
        saved = json.loads(path.read_text())
        if saved.get("version") == 2:
            return {**config.DEFAULT_PARAMS, **saved["params"]}
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
    return None if value is None or pd.isna(value) else round(float(value), 4)


def probabilities(params, ref_odds, model_goals):
    """Faire Chancen aller Wettarten für viele Spiele auf einmal.

    ref_odds:    {"1X2": Tabelle (Spiele x 3), "OU": Tabelle (Spiele x 2)} Marktquoten
    model_goals: Tabelle (Spiele x 2) erwartete Tore des eigenen Modells (NaN = unbekannt)
    Gibt {"final": {Schlüssel: Array}, "market": {…}, "model": {…}} zurück.
    """
    rho = params.get("derived_rho", 0.0)          # für die Nebenmärkte
    p_ref = {m: odds.devig(ref_odds[m], params["devig"]) for m in MARKETS}
    with np.errstate(invalid="ignore"):
        model_all = markets.from_goals(model_goals[:, 0], model_goals[:, 1], params["model"]["rho"])
    p_model = {m: np.column_stack([model_all[s] for s in sel]) for m, sel in MARKETS.items()}
    kind = params["combine"]["kind"]
    final = {m: apply_combination(kind, params["combine"][m], p_ref[m], p_model[m]) for m in MARKETS}

    def expand(p1x2, pou):
        """1X2 + Über/Unter 2.5 -> alle Wettarten (Nebenmärkte über die erwarteten Tore)."""
        result = {"H": p1x2[:, 0], "D": p1x2[:, 1], "A": p1x2[:, 2],
                  "1X": p1x2[:, 0] + p1x2[:, 1], "12": p1x2[:, 0] + p1x2[:, 2],
                  "X2": p1x2[:, 1] + p1x2[:, 2], "O": pou[:, 0], "U": pou[:, 1]}
        with_both = ~np.isnan(p1x2).any(axis=1) & ~np.isnan(pou).any(axis=1)
        derived = {k: np.full(len(p1x2), np.nan) for k in ("O15", "U15", "O35", "U35", "BY", "BN")}
        if with_both.any():
            goals_home, goals_away = markets.implied_goals(
                p1x2[with_both, 0], p1x2[with_both, 1], p1x2[with_both, 2], pou[with_both, 0], rho)
            implied = markets.from_goals(goals_home, goals_away, rho)
            for key in derived:
                derived[key][with_both] = implied[key]
        return {**result, **derived}

    return {"final": expand(final["1X2"], final["OU"]),
            "market": expand(p_ref["1X2"], p_ref["OU"]),
            "model": model_all}


def market_entries(params, probs, i):
    """Alle Wettarten eines Spiels mit fairer Quote und Mindestquote."""
    entries = {}
    for market, info in markets.MARKETS.items():
        base, derived = MARKET_RULES[market]
        edge_needed = params["edge"][base] + (params["derived_extra_edge"] if derived else 0.0)
        max_odds = params["max_odds"][base]
        selections = []
        for key, (short, name) in info["selections"].items():
            p = probs["final"][key][i]
            p_market = probs["market"][key][i]
            p_model = probs["model"][key][i]
            if np.isnan(p):
                selections = None
                break
            selections.append({
                "key": key, "short": short, "name": name,
                "p": number(p), "p_market": number(p_market), "p_model": number(p_model),
                "fair": number(1 / p), "min_odds": number(odds.min_odds(p, edge_needed)),
            })
        if selections:
            entries[market] = {"edge": edge_needed, "max_odds": max_odds, "derived": derived,
                               "selections": selections}
    return entries


def run():
    params = load_params()
    today = pd.Timestamp.now(tz="Europe/Zurich").normalize().tz_localize(None)
    current = config.season_of(today)
    print(f"Einstellungen: {params}")

    # 1. Modell pro Liga mit allen Spielen bis heute lernen
    histories, models = {}, {}
    for code in config.LEAGUES:
        histories[code] = data.load_league(code, current - 2, current)
        models[code] = model.fit(histories[code], today + pd.Timedelta(days=1),
                                 params["model"]["decay"], params["model"]["shots_weight"])
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
    fixtures = fixtures.reset_index(drop=True)

    # 3. Chancen für alle Spiele auf einmal
    model_goals = np.full((len(fixtures), 2), np.nan)
    for i, row in enumerate(fixtures.itertuples()):
        fitted = models.get(row.league)
        expected = fitted.expected_goals(row.home, row.away) if fitted else None
        if expected:
            model_goals[i] = expected
    ref_odds = {m: odds_matrix(fixtures, "ref", m) for m in MARKETS}
    probs = probabilities(params, ref_odds, model_goals)

    matches = []
    for i, row in enumerate(fixtures.itertuples()):
        entries = market_entries(params, probs, i)
        has_model = not np.isnan(model_goals[i, 0])
        if not entries and not has_model:
            continue
        matches.append({
            "id": data.match_id(row.league, row.date, row.home, row.away),
            "league": row.league,
            "date": f"{row.date:%Y-%m-%d}",
            "kickoff": row.kickoff if isinstance(row.kickoff, str) else None,
            "home": row.home, "away": row.away,
            # Woher die Marktquote kommt: Pinnacle, Betfair, Marktschnitt (oder keine)
            "reference": ("Pinnacle live" if row.ref_source == "odds-api"
                          else (row.ref_name if isinstance(row.ref_name, str) else None)),
            # Rohdaten, damit die Website mit frischen Quoten alles neu rechnen kann
            "ref_odds": {m: [number(x) for x in ref_odds[m][i]] for m in MARKETS},
            "model": {m: [number(probs["model"][s][i]) for s in MARKETS[m]] for m in MARKETS}
                     if has_model else None,
            "expected_goals": [round(float(g), 2) for g in model_goals[i]] if has_model else None,
            "markets": entries,
        })

    tips = {
        "version": 2,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "params": params,
        "kelly_fraction": config.KELLY_FRACTION,
        "max_stake": config.MAX_STAKE,
        "leagues": {code: cfg["name"] for code, cfg in config.LEAGUES.items()},
        "odds_api_sports": {code: cfg["odds_api"] for code, cfg in config.LEAGUES.items() if cfg.get("odds_api")},
        "team_aliases": oddsapi.ALIASES,
        "market_names": {k: v["name"] for k, v in markets.MARKETS.items()},
        "odds_api": bool(api_key),
        "matches": matches,
    }
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    (config.OUT_DIR / "tips.json").write_text(json.dumps(clean(tips), indent=1, ensure_ascii=False))
    print(f"{len(matches)} kommende Spiele -> tips.json")

    write_results(params, histories, today)


def write_results(params, histories, today):
    """Resultate der letzten 60 Tage mit fairen Schlussquoten (für den CLV im Tagebuch)."""
    recent = pd.concat(histories.values(), ignore_index=True)
    recent = recent[recent["date"] >= today - pd.Timedelta(days=60)].reset_index(drop=True)
    # Schlussquoten genau wie Tipps behandeln, nur ohne Modell (CLV misst gegen den Markt)
    market_only = {**params, "combine": {"kind": "pool", **{m: {"full": None, "ref_only": {
        "bias": [0.0] * len(MARKETS[m]), "w_market": 1.0, "w_model": 0.0}} for m in MARKETS}}}
    closing = probabilities(market_only, {m: odds_matrix(recent, "refc", m) for m in MARKETS},
                            np.full((len(recent), 2), np.nan))["final"]
    results = []
    for i, row in enumerate(recent.itertuples()):
        results.append({
            "id": data.match_id(row.league, row.date, row.home, row.away),
            "league": row.league, "date": f"{row.date:%Y-%m-%d}",
            "home": row.home, "away": row.away, "hg": int(row.hg), "ag": int(row.ag),
            "closing_fair": {key: number(p[i]) for key, p in closing.items() if not np.isnan(p[i])},
        })
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (config.OUT_DIR / "results.json").write_text(json.dumps(clean(
        {"generated": generated, "results": results}), indent=1, ensure_ascii=False))
    print(f"{len(results)} Resultate -> results.json")

