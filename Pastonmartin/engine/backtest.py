"""Backtest: das ganze System auf alte Saisons loslassen und schauen, was passiert wäre.

Ablauf:
  1. Für jedes alte Spiel eine Prognose machen, und zwar nur mit Daten von VOR dem Spiel
     (das Modell wird jede Woche neu gelernt = "walk-forward").
  2. In den Anpassungs-Saisons (TUNE) die Einstellungen suchen:
       - decay:  wie schnell alte Spiele vergessen werden
       - w:      wie stark das eigene Modell vs. Pinnacle zählt
       - edge:   ab wie viel Value gewettet wird
  3. Mit genau diesen Einstellungen EINMAL die Test-Saisons (TEST) durchspielen.
     Nur dieses Resultat ist ehrlich, weil das System diese Saisons nie gesehen hat.
"""
import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.stats import norm

import config
import data
import model
import odds

MARKETS = {"1X2": ["H", "D", "A"], "OU": ["O", "U"]}
COLUMN = {
    "pin":   {"H": "pin_h", "D": "pin_d", "A": "pin_a", "O": "pin_over", "U": "pin_under"},
    "book":  {"H": "book_h", "D": "book_d", "A": "book_a", "O": "book_over", "U": "book_under"},
    "close": {"H": "pinc_h", "D": "pinc_d", "A": "pinc_a", "O": "pinc_over", "U": "pinc_under"},
}
STRATEGIES = [
    {"key": "value", "name": "Value-Finder (nur Pinnacle)", "w": "zero"},
    {"key": "model", "name": "Eigenes Modell allein", "w": "one"},
    {"key": "combo", "name": "Kombination", "w": "tuned"},
]
SCENARIOS = {
    "sporttip": {"name": "Sporttip-Schätzung", "haircut": config.SPORTTIP_HAIRCUT},
    "book": {"name": "Bet365 (ohne Abzug)", "haircut": 0.0},
}


# --- 1. Prognosen ------------------------------------------------------------------
def walk_forward(matches, decay, first_season):
    """Modell-Wahrscheinlichkeiten für alle Spiele ab `first_season`.

    Jede Woche (ab Montag) wird das Modell mit allen Spielen davor neu gelernt
    und sagt dann die Spiele dieser Woche voraus.
    """
    target = matches[matches["season"] >= first_season]
    monday = target["date"] - pd.to_timedelta(target["date"].dt.weekday, unit="D")
    rows = {}
    for week_start, games in target.groupby(monday):
        fitted = model.fit(matches, week_start, decay)
        if fitted is None:
            continue
        for game in games.itertuples():
            probs = fitted.predict(game.home, game.away)
            if probs:
                rows[game.Index] = probs
    preds = pd.DataFrame.from_dict(rows, orient="index", columns=["H", "D", "A", "O", "U"])
    return preds.reindex(target.index).add_prefix("m_")


def add_market_probs(df):
    """Faire Wahrscheinlichkeiten aus den Pinnacle-Quoten (vor dem Spiel + Schluss)."""
    for source, prefix in [("pin", "pin_fair_"), ("close", "close_fair_")]:
        for selections in MARKETS.values():
            cols = [df[COLUMN[source][s]] for s in selections]
            for s, p in zip(selections, odds.fair_probs(*cols)):
                df[prefix + s] = p
    # Was ist passiert? 1X2: 0=Heim, 1=Remis, 2=Gast.  OU: 0=über 2.5, 1=unter 2.5
    df["res_1X2"] = np.select([df["hg"] > df["ag"], df["hg"] == df["ag"]], [0, 1], 2)
    df["res_OU"] = np.where(df["hg"] + df["ag"] >= 3, 0, 1)
    return df


def probs(df, prefix, market):
    return df[[prefix + s for s in MARKETS[market]]].to_numpy(dtype=float)


def blended(df, market, w):
    """w * Modell + (1-w) * Pinnacle. Fehlt das Modell, zählt nur Pinnacle."""
    m, pin = probs(df, "m_", market), probs(df, "pin_fair_", market)
    if w == 0:
        return pin
    if w == 1:
        return m
    mix = w * m + (1 - w) * pin
    return np.where(np.isnan(m), pin, mix)


# --- 2. Gütemass ----------------------------------------------------------------------
def compare_log_loss(df, market, w):
    """Log-Loss von Modell, Pinnacle und Mischung auf denselben Spielen."""
    m, pin = probs(df, "m_", market), probs(df, "pin_fair_", market)
    ok = ~np.isnan(m).any(axis=1) & ~np.isnan(pin).any(axis=1)
    outcome = df["res_" + market].to_numpy()[ok]
    return {
        "games": int(ok.sum()),
        "model": odds.log_loss(m[ok], outcome),
        "market": odds.log_loss(pin[ok], outcome),
        "blend": odds.log_loss((w * m + (1 - w) * pin)[ok], outcome),
    }


def best_blend_weight(df, market):
    """Das w, bei dem die Mischung im Anpassungs-Zeitraum am besten vorhersagt."""
    m, pin = probs(df, "m_", market), probs(df, "pin_fair_", market)
    ok = ~np.isnan(m).any(axis=1) & ~np.isnan(pin).any(axis=1)
    if not ok.any():
        return config.DEFAULT_PARAMS["w_1x2"]
    outcome = df["res_" + market].to_numpy()[ok]
    scores = {w: odds.log_loss((w * m + (1 - w) * pin)[ok], outcome) for w in config.BLEND_GRID}
    return min(scores, key=scores.get)


# --- 3. Wetten simulieren ----------------------------------------------------------
def simulate(df, market, w, edge_min, haircut):
    """Alle Wetten, die das System gemacht hätte (max. eine pro Spiel und Markt)."""
    selections = MARKETS[market]
    p = blended(df, market, w)
    # Unsere Ersatz-Quote für Sporttip: Bet365, um `haircut` verschlechtert
    quote = df[[COLUMN["book"][s] for s in selections]].to_numpy(float) * (1 - haircut)
    close = probs(df, "close_fair_", market)

    value = odds.edge(p, quote)
    value[np.isnan(value) | (quote > config.MAX_ODDS)] = -np.inf
    pick = value.argmax(axis=1)                       # beste Wette im Spiel
    rows = np.arange(len(df))
    best = value[rows, pick]
    take = best >= edge_min

    taken_odds = quote[rows, pick][take]
    won = (df["res_" + market].to_numpy() == pick)[take]
    return pd.DataFrame({
        "date": df["date"].to_numpy()[take],
        "league": df["league"].to_numpy()[take],
        "season": df["season"].to_numpy()[take],
        "market": market,
        "selection": np.array(selections)[pick[take]],
        "odds": taken_odds,
        "prob": p[rows, pick][take],
        "edge": best[take],
        "won": won,
        "profit": np.where(won, taken_odds - 1, -1.0),
        # Closing Line Value: war unsere Quote besser als die faire Schlussquote?
        "clv": taken_odds * close[rows, pick][take] - 1,
    })


def summarize(bets):
    """Kennzahlen einer Wett-Liste. Einsatz immer 1 Einheit pro Wette."""
    n = len(bets)
    if n == 0:
        return {"bets": 0}
    profit = bets["profit"].to_numpy()
    roi = profit.mean()
    stderr = profit.std(ddof=1) / np.sqrt(n) if n > 1 else np.nan
    clv = bets["clv"].dropna()
    return {
        "bets": n,
        "wins": int(bets["won"].sum()),
        "hit_rate": float(bets["won"].mean()),
        "avg_odds": float(bets["odds"].mean()),
        "avg_edge": float(bets["edge"].mean()),
        "profit": float(profit.sum()),
        "roi": float(roi),
        "roi_stderr": float(stderr),
        # Wie wahrscheinlich wäre so ein Resultat (oder besser) mit purem Glück, ohne echten Vorteil?
        "p_luck": float(norm.sf(roi / stderr)) if stderr and stderr > 0 else None,
        "clv": float(clv.mean()) if len(clv) else None,
        "clv_positive": float((clv > 0).mean()) if len(clv) else None,
    }


def best_edge(df, market, w, haircut):
    """Mindest-Value mit der besten Rendite im Anpassungs-Zeitraum (mit genug Wetten)."""
    grid = []
    for edge_min in config.EDGE_GRID:
        s = summarize(simulate(df, market, w, edge_min, haircut))
        grid.append({"edge": edge_min, "bets": s["bets"], "roi": s.get("roi")})
    enough = [g for g in grid if g["bets"] >= config.MIN_BETS_FOR_TUNING]
    chosen = max(enough, key=lambda g: g["roi"])["edge"] if enough else config.EDGE_GRID[0]
    return chosen, grid


def equity_curve(bets, max_points=300):
    """Kumulierter Gewinn über die Zeit, auf max_points Punkte ausgedünnt."""
    if bets.empty:
        return []
    bets = bets.sort_values("date", kind="stable")
    cumulative = bets["profit"].cumsum().to_numpy()
    dates = bets["date"].dt.strftime("%Y-%m-%d").to_numpy()
    step = max(1, len(bets) // max_points)
    keep = list(range(0, len(bets), step)) + [len(bets) - 1]
    return [[dates[i], round(float(cumulative[i]), 2)] for i in sorted(set(keep))]


# --- Alles zusammen ------------------------------------------------------------------
def coverage(df):
    """Wie viele Spiele pro Liga und Saison haben welche Quoten? (zum Prüfen der Daten)"""
    table = df.groupby(["league", "season"]).agg(
        games=("home", "size"),
        pinnacle=("pin_h", lambda s: s.notna().mean()),
        bet365=("book_h", lambda s: s.notna().mean()),
        pinnacle_ou=("pin_over", lambda s: s.notna().mean()),
        closing=("pinc_h", lambda s: s.notna().mean()),
    ).reset_index()
    return table


def run():
    tune, test = list(config.TUNE_SEASONS), list(config.TEST_SEASONS)
    first, last = config.FIRST_SEASON, test[-1]

    print("Lade Daten …")
    matches = {code: data.load_league(code, first, last) for code in config.LEAGUES}
    for code, df in matches.items():
        print(f"  {code}: {len(df)} Spiele")
    all_matches = pd.concat(matches.values(), ignore_index=True)
    cov = coverage(all_matches[all_matches["season"] >= tune[0]])
    print(cov.to_string(index=False, float_format=lambda x: f"{x:.2f}"))

    # 1. Prognosen für jede decay-Einstellung
    print("Walk-forward-Prognosen …")
    preds = {}
    for decay in config.DECAY_GRID:
        parts = []
        for code, df in matches.items():
            if df.empty:
                continue
            p = walk_forward(df, decay, tune[0])
            parts.append(df.loc[p.index].join(p))
        preds[decay] = add_market_probs(pd.concat(parts, ignore_index=True))
        print(f"  decay {decay}: fertig")

    # 2a. decay wählen: wer sagt im Anpassungs-Zeitraum die Spiele am besten voraus?
    # Verglichen wird nur auf Spielen, die ALLE Varianten vorhergesagt haben (fairer Vergleich).
    common = next(iter(preds.values()))["season"].isin(tune).to_numpy().copy()
    for df in preds.values():
        common &= ~np.isnan(probs(df, "m_", "1X2")).any(axis=1)
    decay_scores = []
    for decay, df in preds.items():
        m = probs(df, "m_", "1X2")[common]
        decay_scores.append({"decay": decay,
                             "log_loss": odds.log_loss(m, df["res_1X2"].to_numpy()[common])})
    decay = min(decay_scores, key=lambda d: d["log_loss"])["decay"]
    df = preds[decay]
    df_tune, df_test = df[df["season"].isin(tune)], df[df["season"].isin(test)]
    print(f"Gewählt: decay={decay}")

    # 2b. w pro Markt wählen
    weights = {market: best_blend_weight(df_tune, market) for market in MARKETS}
    print(f"Gewählt: w={weights}")

    # 2c. + 3. Pro Strategie den Mindest-Value wählen (TUNE) und dann testen (TEST)
    sporttip_cut = SCENARIOS["sporttip"]["haircut"]
    strategies, curves, tuning_grids, combo_bets = [], {}, {}, None
    for strategy in STRATEGIES:
        w = {m: {"zero": 0.0, "one": 1.0, "tuned": weights[m]}[strategy["w"]] for m in MARKETS}
        edges, results, test_bets = {}, {}, []
        for market in MARKETS:
            edges[market], grid = best_edge(df_tune, market, w[market], sporttip_cut)
            if strategy["key"] == "combo":
                tuning_grids[market] = grid
        for scenario_key, scenario in SCENARIOS.items():
            results[scenario_key] = {}
            for period, part in [("tune", df_tune), ("test", df_test)]:
                per_market = {}
                for market in MARKETS:
                    bets = simulate(part, market, w[market], edges[market], scenario["haircut"])
                    per_market[market] = summarize(bets)
                    if period == "test" and scenario_key == "sporttip":
                        test_bets.append(bets)
                results[scenario_key][period] = per_market
        bets = pd.concat(test_bets, ignore_index=True)
        curves[strategy["key"]] = equity_curve(bets)
        if strategy["key"] == "combo":
            combo_bets = bets
        strategies.append({**strategy, "weights": w, "edges": edges, "results": results,
                           "test_total": summarize(bets)})
        print(f"  {strategy['name']}: Test {strategies[-1]['test_total']}")

    combo = next(s for s in strategies if s["key"] == "combo")
    by_league = [{"league": code, "name": config.LEAGUES[code]["name"], **summarize(group)}
                 for code, group in combo_bets.groupby("league")]
    by_season = [{"season": config.season_label(int(season)), **summarize(group)}
                 for season, group in combo_bets.groupby("season")]

    result = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seasons": {
            "tune": f"{config.season_label(tune[0])} – {config.season_label(tune[-1])}",
            "test": f"{config.season_label(test[0])} – {config.season_label(test[-1])}",
        },
        "params": {
            "decay": decay, "w_1x2": weights["1X2"], "w_ou": weights["OU"],
            "edge_1x2": combo["edges"]["1X2"], "edge_ou": combo["edges"]["OU"],
            "haircut": sporttip_cut, "max_odds": config.MAX_ODDS,
            "min_bets_for_tuning": config.MIN_BETS_FOR_TUNING,
        },
        "scenarios": {k: v["name"] for k, v in SCENARIOS.items()},
        "decay_grid": decay_scores,
        "log_loss": {
            market: {"tune": compare_log_loss(df_tune, market, weights[market]),
                     "test": compare_log_loss(df_test, market, weights[market])}
            for market in MARKETS
        },
        "strategies": strategies,
        "tuning_grid": tuning_grids,
        "by_league": by_league,
        "by_season": by_season,
        "curves": curves,
        "coverage": cov.to_dict(orient="records"),
    }
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = config.OUT_DIR / "backtest.json"
    out.write_text(json.dumps(clean(result), indent=1, ensure_ascii=False))
    print(f"Geschrieben: {out}")
    return result


def clean(value):
    """Macht numpy-Zahlen und NaN JSON-tauglich (NaN gibt es in JSON nicht -> null)."""
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return None if np.isnan(value) else round(float(value), 5)
    return value
