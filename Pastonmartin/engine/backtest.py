"""Backtest v2: alle Verbesserungen gegeneinander testen und die beste wählen.

Ablauf:
  1. Daten aller Ligen laden.
  2. Eigenes Modell: für jede Variante (decay x Schüsse) jedes alte Spiel vorhersagen,
     nur mit Daten von VOR dem Spiel ("walk-forward"). Läuft parallel auf allen CPU-Kernen.
  3. Im Anpassungs-Zeitraum (TUNE) wählen:
       a) die beste Modellvariante (+ Dixon-Coles rho)
       b) die beste Methode, die Marge aus den Marktquoten herauszurechnen
       c) die beste Art, Markt und Modell zu kombinieren
       d) pro Strategie: ab wie viel Value und bis zu welcher Quote gewettet wird
  4. Mit genau diesen Einstellungen EINMAL die Test-Saisons (TEST) durchspielen:
     früh vs. kurz vor Anpfiff, bei Sporttip (geschätzt), Bet365 und der Höchstquote.
  5. Prüfen, ob die Nebenmärkte (Beide treffen, Über/Unter 1.5/3.5) stimmen.

Gewählt wird IMMER nur mit dem Anpassungs-Zeitraum. Würden wir nach dem Test-
Resultat auswählen, wäre der Test geschönt und nichts mehr wert.
Alles landet in site/data/backtest.json und wird auf der Website angezeigt.
"""
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.stats import norm

import combine
import config
import data
import markets
import model
import odds

MARKETS = {"1X2": ["H", "D", "A"], "OU": ["O", "U"]}
SUFFIX = {"H": "h", "D": "d", "A": "a", "O": "over", "U": "under"}
TIMINGS = {
    "early": {"name": "Früh (1–3 Tage vorher)", "book": "book", "max": "max"},
    "late": {"name": "Kurz vor Anpfiff", "book": "bookc", "max": "maxc"},
}
SCENARIOS = {
    "sporttip": {"name": "Sporttip-Schätzung", "source": "book", "haircut": config.SPORTTIP_HAIRCUT},
    "book": {"name": "Bet365", "source": "book", "haircut": 0.0},
    "max": {"name": "Höchstquote aller Buchmacher", "source": "max", "haircut": 0.0},
}
COMBINATIONS = {
    "market": "Nur Markt",
    "market_cal": "Markt, kalibriert",
    "linear": "Markt + Modell, linear (wie v1)",
    "pool_outcome": "Markt + Modell, log-Pool, gelernt an Resultaten",
    "pool_close": "Markt + Modell, log-Pool, gelernt an Schlussquoten",
}


# --- Kleine Helfer ----------------------------------------------------------------
def odds_matrix(df, source, market):
    """Quoten einer Quelle (z.B. 'ref', 'book', 'maxc') als Tabelle (Spiele x Ausgänge)."""
    return df[[f"{source}_{SUFFIX[s]}" for s in MARKETS[market]]].to_numpy(dtype=float)


def outcomes(df):
    """Was ist passiert? 1X2: 0=Heim, 1=Remis, 2=Gast.  OU: 0=über 2.5, 1=unter 2.5"""
    hg, ag = df["hg"].to_numpy(), df["ag"].to_numpy()
    return {"1X2": np.select([hg > ag, hg == ag], [0, 1], 2), "OU": np.where(hg + ag >= 3, 0, 1)}


def has(probs):
    """Zeilen, in denen alle Wahrscheinlichkeiten vorhanden sind."""
    return ~np.isnan(probs).any(axis=1)


def log_loss_on(probs, outcome, rows):
    ok = rows & has(probs)
    return odds.log_loss(probs[ok], outcome[ok]) if ok.any() else None


def total_log_loss(probs_by_market, outcome, rows):
    """Summe der Log-Losses beider Märkte (unser Gütemass beim Auswählen)."""
    values = [log_loss_on(probs_by_market[m], outcome[m], rows) for m in MARKETS]
    return None if None in values else sum(values)


# --- 1. Prognosen des eigenen Modells -------------------------------------------------
def walk_forward(matches, decay, shots_weight, first_season):
    """Erwartete Tore für alle Spiele ab `first_season`, jede Woche neu gelernt."""
    target = matches[matches["season"] >= first_season]
    monday = target["date"] - pd.to_timedelta(target["date"].dt.weekday, unit="D")
    goals = np.full((len(target), 2), np.nan)
    row_of = {index: i for i, index in enumerate(target.index)}
    for week_start, games in target.groupby(monday):
        fitted = model.fit(matches, week_start, decay, shots_weight)
        if fitted is None:
            continue
        for game in games.itertuples():
            expected = fitted.expected_goals(game.home, game.away)
            if expected:
                goals[row_of[game.Index]] = expected
    return goals


def _walk_forward_job(job):
    return walk_forward(*job)


def model_probs(goals, rho):
    """Erwartete Tore -> Wahrscheinlichkeiten für 1X2 und Über/Unter 2.5."""
    with np.errstate(invalid="ignore"):
        probs = markets.from_goals(goals[:, 0], goals[:, 1], rho)
    return {market: np.column_stack([probs[s] for s in sel]) for market, sel in MARKETS.items()}


def variant_name(decay, shots, rho):
    months = round(np.log(2) / decay / 30.4)
    parts = [f"Halbwertszeit {months} Mt."]
    parts.append(f"Schüsse {shots:.0%}" if shots else "nur Tore")
    if rho:
        parts.append(f"Dixon-Coles {rho}")
    return ", ".join(parts)


# --- 2. Kombination von Markt und Modell -------------------------------------------
def best_linear_weight(p_ref, p_model, outcome, rows):
    ok = rows & has(p_ref) & has(p_model)
    if not ok.any():
        return 0.0
    scores = {w: odds.log_loss((w * p_model + (1 - w) * p_ref)[ok], outcome[ok]) for w in config.BLEND_GRID}
    return min(scores, key=scores.get)


def build_combination(kind, p_ref, p_model, p_close, outcome, rows):
    """Lernt eine Kombination auf `rows` und wendet sie auf alle Spiele an.

    Gibt (Parameter, Wahrscheinlichkeiten) für beide Märkte zurück.
    """
    params, probs = {}, {}
    for market in MARKETS:
        ref, mod, close, y = p_ref[market], p_model[market], p_close[market], outcome[market]
        with_ref = rows & has(ref)
        with_both = with_ref & has(mod)
        if kind == "market":
            params[market] = {"full": None, "ref_only": combine.identity(ref.shape[1])}
        elif kind == "market_cal":
            params[market] = {"full": None, "ref_only": combine.fit(ref[with_ref], y[with_ref])}
        elif kind == "linear":
            params[market] = {"w": best_linear_weight(ref, mod, y, rows)}
        else:
            if kind == "pool_close":       # Lernziel: die faire Schlussquote statt das Resultat
                with_ref, with_both = with_ref & has(close), with_both & has(close)
                target_ref, target_both = close[with_ref], close[with_both]
            else:
                target_ref, target_both = y[with_ref], y[with_both]
            params[market] = {"full": combine.fit(ref[with_both], target_both, mod[with_both]),
                              "ref_only": combine.fit(ref[with_ref], target_ref)}
        probs[market] = apply_combination(kind, params[market], ref, mod)
    return params, probs


def cross_validated_loss(kind, p_ref, p_model, p_close, outcome, rows, seasons):
    """Log-Loss im Anpassungs-Zeitraum, aber ehrlich gemessen ("Kreuzvalidierung"):

    Jede Saison wird mit Gewichten vorhergesagt, die nur aus den ANDEREN Saisons
    gelernt wurden. Sonst sähen Varianten mit vielen gelernten Gewichten zu gut aus,
    weil sie die Daten, an denen sie gemessen werden, schon kennen.
    """
    loss = {m: 0.0 for m in MARKETS}
    count = {m: 0 for m in MARKETS}
    for season in np.unique(seasons[rows]):
        held_out = rows & (seasons == season)
        _, probs = build_combination(kind, p_ref, p_model, p_close, outcome, rows & ~held_out)
        for m in MARKETS:
            ok = held_out & has(probs[m])
            if ok.any():
                loss[m] += odds.log_loss(probs[m][ok], outcome[m][ok]) * ok.sum()
                count[m] += ok.sum()
    return sum(loss[m] / count[m] for m in MARKETS if count[m])


def apply_combination(kind, params, p_ref, p_model):
    """Kombinierte Wahrscheinlichkeiten. Ohne Modellprognose zählt nur der (kalibrierte) Markt."""
    with np.errstate(invalid="ignore"):
        if kind == "linear":
            w = params["w"]
            return np.where(has(p_model)[:, None], w * p_model + (1 - w) * p_ref, p_ref)
        market_only = combine.apply(params["ref_only"], p_ref)
        if params.get("full") is None:
            return market_only
        both = combine.apply(params["full"], p_ref, p_model)
        return np.where(has(p_model)[:, None], both, market_only)


# --- 3. Wetten simulieren ----------------------------------------------------------
def simulate(meta, rows, probs, quotes, close_fair, outcome, edge_min, max_odds):
    """Alle Wetten, die das System auf `rows` gemacht hätte (max. eine pro Spiel und Markt)."""
    probs, quotes, close_fair, outcome = probs[rows], quotes[rows], close_fair[rows], outcome[rows]
    with np.errstate(invalid="ignore"):
        value = probs * quotes - 1
    value[np.isnan(value) | (quotes > max_odds)] = -np.inf
    pick = value.argmax(axis=1)                       # beste Wette im Spiel
    index = np.arange(len(value))
    best = value[index, pick]
    take = best >= edge_min
    taken = quotes[index, pick][take]
    won = (outcome == pick)[take]
    return pd.DataFrame({
        "date": meta["date"].to_numpy()[rows][take],
        "league": meta["league"].to_numpy()[rows][take],
        "season": meta["season"].to_numpy()[rows][take],
        "odds": taken,
        "edge": best[take],
        "won": won,
        "profit": np.where(won, taken - 1, -1.0),
        # Closing Line Value: war unsere Quote besser als die faire Schlussquote?
        "clv": taken * close_fair[index, pick][take] - 1,
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


def tune_thresholds(simulate_with, market):
    """Bestes (Mindest-Value, Höchstquote) im Anpassungs-Zeitraum.

    Kriterium ist der gesamte CLV (erwarteter Gewinn gemessen an der Schlussquote).
    Der ist viel weniger zufällig als der tatsächliche Gewinn und darum ein
    besserer Wegweiser, besonders bei wenigen Wetten.
    """
    grid = []
    for edge_min in config.EDGE_GRID:
        for max_odds in config.MAX_ODDS_GRID:
            bets = simulate_with(edge_min, max_odds)
            clv = bets["clv"].dropna()
            grid.append({"edge": edge_min, "max_odds": max_odds, "bets": len(bets),
                         "roi": float(bets["profit"].mean()) if len(bets) else None,
                         "clv": float(clv.mean()) if len(clv) else None,
                         "clv_total": float(clv.sum()) if len(clv) else 0.0})
    good = [g for g in grid if g["bets"] >= config.MIN_BETS_FOR_TUNING[market] and (g["clv"] or 0) > 0]
    if good:
        return max(good, key=lambda g: g["clv_total"]), grid, True
    some = [g for g in grid if g["bets"] >= 30 and g["clv"] is not None]
    if some:
        return max(some, key=lambda g: g["clv"]), grid, False
    return max(grid, key=lambda g: (g["edge"], -g["max_odds"])), grid, False


def equity_curve(bets, max_points=300):
    """Kumulierter Gewinn über die Zeit, auf max_points Punkte ausgedünnt."""
    if bets.empty:
        return []
    bets = bets.sort_values("date", kind="stable")
    cumulative = bets["profit"].cumsum().to_numpy()
    dates = pd.to_datetime(bets["date"]).dt.strftime("%Y-%m-%d").to_numpy()
    step = max(1, len(bets) // max_points)
    keep = sorted(set(range(0, len(bets), step)) | {len(bets) - 1})
    return [[dates[i], round(float(cumulative[i]), 2)] for i in keep]


# --- 4. Nebenmärkte prüfen ------------------------------------------------------------
DERIVED_CHECKS = {
    "BY": ("Beide treffen", lambda hg, ag: (hg > 0) & (ag > 0)),
    "O15": ("Über 1.5 Tore", lambda hg, ag: hg + ag >= 2),
    "O35": ("Über 3.5 Tore", lambda hg, ag: hg + ag >= 4),
}


def binary_loss(p, happened):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return float(-(happened * np.log(p) + (~happened) * np.log(1 - p)).mean())


def implied_markets(probs, rows, rho):
    """Nebenmärkte aus den kombinierten 1X2- und Über/Unter-Chancen (über die erwarteten Tore)."""
    ok = rows & has(probs["1X2"]) & has(probs["OU"])
    p1, pou = probs["1X2"][ok], probs["OU"][ok]
    goals_home, goals_away = markets.implied_goals(p1[:, 0], p1[:, 1], p1[:, 2], pou[:, 0], rho)
    return ok, markets.from_goals(goals_home, goals_away, rho)


def choose_derived_rho(df, rows, probs):
    """Welche Dixon-Coles-Korrektur macht die Nebenmärkte am genausten? (Anpassungs-Zeitraum)"""
    hg, ag = df["hg"].to_numpy(), df["ag"].to_numpy()
    scores = {}
    for rho in config.RHO_GRID:
        ok, implied = implied_markets(probs, rows, rho)
        scores[rho] = sum(binary_loss(implied[key], rule(hg[ok], ag[ok]))
                          for key, (_, rule) in DERIVED_CHECKS.items())
    return min(scores, key=scores.get), scores


def check_derived(df, rows, probs, model_goals, model_rho, rho, base_rows):
    """Wie gut stimmen die aus dem Markt abgeleiteten Nebenmärkte? (Log-Loss + Kalibrierung)"""
    ok, implied = implied_markets(probs, rows, rho)
    with np.errstate(invalid="ignore"):
        from_model = markets.from_goals(model_goals[ok, 0], model_goals[ok, 1], model_rho)
    hg, ag = df["hg"].to_numpy(), df["ag"].to_numpy()

    table = []
    for key, (name, rule) in DERIVED_CHECKS.items():
        happened = rule(hg[ok], ag[ok])
        base = rule(hg[base_rows], ag[base_rows]).mean()          # Häufigkeit im Anpassungs-Zeitraum
        p = implied[key]
        has_model = ~np.isnan(from_model[key])
        bins = []
        edges = np.quantile(p, [0, 0.2, 0.4, 0.6, 0.8, 1])
        for low, high in zip(edges[:-1], edges[1:]):
            inside = (p >= low) & (p <= high)
            bins.append({"predicted": float(p[inside].mean()), "actual": float(happened[inside].mean()),
                         "games": int(inside.sum())})
        table.append({
            "key": key, "name": name, "games": int(ok.sum()),
            "loss_market": binary_loss(p, happened),
            "loss_model": binary_loss(from_model[key][has_model], happened[has_model]) if has_model.any() else None,
            "loss_base": binary_loss(np.full(len(p), base), happened),
            "predicted": float(p.mean()), "actual": float(happened.mean()),
            "bins": bins,
        })
    return table


# --- Alles zusammen ------------------------------------------------------------------
def coverage(df):
    """Wie viele Spiele pro Liga und Saison haben welche Daten? (zum Prüfen der Daten)"""
    def share(column):
        return (column, lambda s: s.notna().mean())

    return df.groupby(["league", "season"]).agg(
        games=("home", "size"),
        pinnacle=("ref_name", lambda s: (s == "Pinnacle").mean()),
        betfair=("ref_name", lambda s: (s == "Betfair").mean()),
        reference=share("ref_h"),
        reference_ou=share("ref_over"),
        bet365=share("book_h"),
        bet365_close=share("bookc_h"),
        max=share("max_h"),
        shots=share("sot_h"),
    ).reset_index()


def run():
    started = time.time()
    tune, test = list(config.TUNE_SEASONS), list(config.TEST_SEASONS)

    print("Lade Daten …")
    leagues = {code: data.load_league(code, config.FIRST_SEASON, test[-1]) for code in config.LEAGUES}
    leagues = {code: df for code, df in leagues.items() if not df.empty}
    for code, df in leagues.items():
        print(f"  {code}: {len(df)} Spiele")
    df = pd.concat([m[m["season"] >= tune[0]] for m in leagues.values()], ignore_index=True)
    in_tune = df["season"].isin(tune).to_numpy()
    in_test = df["season"].isin(test).to_numpy()
    outcome = outcomes(df)
    cov = coverage(df)
    print(cov.to_string(index=False, float_format=lambda x: f"{x:.2f}"))

    # 1. Eigenes Modell: alle Varianten parallel durchrechnen
    variants = [(decay, shots) for decay in config.DECAY_GRID for shots in config.SHOTS_GRID]
    jobs = [(leagues[code], decay, shots, tune[0]) for decay, shots in variants for code in leagues]
    workers = int(os.environ.get("PASTONMARTIN_WORKERS", os.cpu_count() or 1))
    print(f"Walk-forward: {len(variants)} Modellvarianten x {len(leagues)} Ligen auf {workers} Kernen …")
    if workers > 1:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(_walk_forward_job, jobs))
    else:
        results = [_walk_forward_job(job) for job in jobs]
    goals = {variant: np.vstack(results[i * len(leagues):(i + 1) * len(leagues)])
             for i, variant in enumerate(variants)}
    print(f"  fertig nach {time.time() - started:.0f} s")

    # 2a. Beste Modellvariante: auf Spielen, die ALLE Varianten vorhersagen (fairer Vergleich)
    common = np.logical_and.reduce([~np.isnan(g[:, 0]) for g in goals.values()])
    model_table = []
    for (decay, shots), g in goals.items():
        for rho in config.RHO_GRID:
            probs = model_probs(g, rho)
            model_table.append({
                "decay": decay, "shots_weight": shots, "rho": rho,
                "name": variant_name(decay, shots, rho),
                "tune": total_log_loss(probs, outcome, in_tune & common),
                "test": total_log_loss(probs, outcome, in_test & common),
            })
    best_model = min(model_table, key=lambda r: r["tune"])
    chosen_model = {k: best_model[k] for k in ("decay", "shots_weight", "rho")}
    model_goals = goals[(best_model["decay"], best_model["shots_weight"])]
    p_model = model_probs(model_goals, best_model["rho"])
    print(f"Modell: {best_model['name']} (Anpassung {best_model['tune']:.4f})")

    # 2b. Beste Methode, die Marge herauszurechnen
    devig_table = []
    for method in odds.DEVIG_METHODS:
        probs = {m: odds.devig(odds_matrix(df, "ref", m), method) for m in MARKETS}
        devig_table.append({"method": method,
                            "tune": total_log_loss(probs, outcome, in_tune),
                            "test": total_log_loss(probs, outcome, in_test)})
    method = min(devig_table, key=lambda r: r["tune"])["method"]
    p_ref = {m: odds.devig(odds_matrix(df, "ref", m), method) for m in MARKETS}
    p_close = {m: odds.devig(odds_matrix(df, "refc", m), method) for m in MARKETS}
    print(f"Marge herausrechnen: {method}")

    # Zum Vergleich: wie gut ist der Markt selbst (auf denselben Spielen wie das Modell)?
    market_loss = {"tune": total_log_loss(p_ref, outcome, in_tune & common),
                   "test": total_log_loss(p_ref, outcome, in_test & common)}

    # 2c. Beste Kombination (früh wetten), gewählt nach Kreuzvalidierung
    combos = {}
    seasons = df["season"].to_numpy()
    for kind in COMBINATIONS:
        params, probs = build_combination(kind, p_ref, p_model, p_close, outcome, in_tune)
        close_loss = 0.0
        for m in MARKETS:
            ok = in_test & has(probs[m]) & has(p_close[m])
            close_loss += odds.cross_entropy(probs[m][ok], p_close[m][ok])
        combos[kind] = {
            "params": params, "probs": probs,
            "tune": cross_validated_loss(kind, p_ref, p_model, p_close, outcome, in_tune, seasons),
            "test": total_log_loss(probs, outcome, in_test),
            # Wie nahe an der Schlussquote? (das wichtigste Mass für frühe Wetten)
            "test_close": close_loss,
        }
    combo_kind = min(combos, key=lambda k: combos[k]["tune"])
    value_kind = min(["market", "market_cal"], key=lambda k: combos[k]["tune"])
    print(f"Kombination: {combo_kind} / Value-Finder: {value_kind}")
    for kind, c in combos.items():
        print(f"  {kind}: Anpassung {c['tune']:.5f}, Test {c['test']:.5f}, Schlussquote {c['test_close']:.5f}, "
              f"Parameter {c['params']}")

    # Kurz vor Anpfiff: die Schlussquote ist die Referenz. Gleiche Art Kombination, neu gelernt.
    late_kind = {"pool_close": "pool_outcome"}.get(combo_kind, combo_kind)
    _, combo_late = build_combination(late_kind, p_close, p_model, p_close, outcome, in_tune)
    _, value_late = build_combination(value_kind, p_close, p_model, p_close, outcome, in_tune)

    strategy_probs = {
        "value": {"early": combos[value_kind]["probs"], "late": value_late},
        "model": {"early": p_model, "late": p_model},
        "combo": {"early": combos[combo_kind]["probs"], "late": combo_late},
        # Version 1 zum Vergleich: einfache Marge, nur Markt, fixe Schwellen
        "v1": {"early": {m: odds.devig(odds_matrix(df, "ref", m), "proportional") for m in MARKETS},
               "late": {m: odds.devig(odds_matrix(df, "refc", m), "proportional") for m in MARKETS}},
    }
    strategy_names = {"value": "Value-Finder (nur Markt)", "model": "Eigenes Modell allein",
                      "combo": "Kombination", "v1": "Version 1 (alt)"}

    # 3. Schwellen wählen (früh, Bet365, Anpassungs-Zeitraum) und alles simulieren
    def quotes_for(timing, scenario, market):
        source = TIMINGS[timing][SCENARIOS[scenario]["source"]]
        return odds_matrix(df, source, market) * (1 - SCENARIOS[scenario]["haircut"])

    strategies, tuning_grids, curves, all_bets = [], {}, {}, {}
    for key, name in strategy_names.items():
        thresholds, reliable = {}, {}
        for market in MARKETS:
            if key == "v1":
                thresholds[market] = {"edge": 0.02, "max_odds": 8.0}
                reliable[market] = None
                continue

            def simulate_with(edge_min, max_odds, market=market, key=key):
                return simulate(df, in_tune, strategy_probs[key]["early"][market],
                                quotes_for("early", config.TUNING_SCENARIO, market), p_close[market],
                                outcome[market], edge_min, max_odds)

            chosen, grid, ok = tune_thresholds(simulate_with, market)
            thresholds[market] = {"edge": chosen["edge"], "max_odds": chosen["max_odds"]}
            reliable[market] = ok
            if key == "combo":
                tuning_grids[market] = grid

        results = {}
        for timing in TIMINGS:
            results[timing] = {}
            for scenario in SCENARIOS:
                results[timing][scenario] = {}
                for period, rows in [("tune", in_tune), ("test", in_test)]:
                    per_market, together = {}, []
                    for market in MARKETS:
                        bets = simulate(df, rows, strategy_probs[key][timing][market],
                                        quotes_for(timing, scenario, market), p_close[market],
                                        outcome[market], thresholds[market]["edge"],
                                        thresholds[market]["max_odds"])
                        per_market[market] = summarize(bets)
                        together.append(bets)
                    bets = pd.concat(together, ignore_index=True)
                    per_market["total"] = summarize(bets)
                    results[timing][scenario][period] = per_market
                    if period == "test":
                        all_bets[(key, timing, scenario)] = bets
        strategies.append({"key": key, "name": name, "thresholds": thresholds,
                           "reliable": reliable, "results": results})
        for timing in TIMINGS:
            for scenario in SCENARIOS:
                t = results[timing][scenario]["test"]["total"]
                print(f"  {name} | {timing} | {scenario}: {t.get('bets')} Wetten, ROI {t.get('roi')}, "
                      f"CLV {t.get('clv')}, Glück {t.get('p_luck')}")
        print(f"    Schwellen {thresholds}, verlässlich {reliable}")

    for key, timing, scenario in [("combo", "early", "sporttip"), ("combo", "late", "sporttip"),
                                  ("combo", "early", "book"), ("combo", "early", "max"),
                                  ("value", "early", "sporttip"), ("model", "early", "sporttip"),
                                  ("v1", "early", "sporttip")]:
        curves[f"{key}|{timing}|{scenario}"] = equity_curve(all_bets[(key, timing, scenario)])

    combo_bets = all_bets[("combo", "early", "sporttip")]
    by_league = [{"league": code, "name": config.LEAGUES[code]["name"], **summarize(group)}
                 for code, group in combo_bets.groupby("league")]
    by_season = [{"season": config.season_label(int(season)), **summarize(group)}
                 for season, group in combo_bets.groupby("season")]

    # 4. Nebenmärkte
    print("Prüfe Nebenmärkte …")
    derived_rho, rho_scores = choose_derived_rho(df, in_tune, combos[combo_kind]["probs"])
    print(f"  Dixon-Coles für Nebenmärkte: {derived_rho} ({rho_scores})")
    derived = check_derived(df, in_test, combos[combo_kind]["probs"], model_goals,
                            best_model["rho"], derived_rho, in_tune)
    for d in derived:
        print(f"  {d['name']}: Markt {d['loss_market']:.4f}, Modell {d['loss_model']}, "
              f"Schnitt {d['loss_base']:.4f}, erwartet {d['predicted']:.3f}, eingetroffen {d['actual']:.3f}")

    # 5. Ergebnis für Website und Tipps
    combo = next(s for s in strategies if s["key"] == "combo")
    chosen_params = combos[combo_kind]["params"]
    params = {
        "model": chosen_model,
        "devig": method,
        "combine": {"kind": "linear" if combo_kind == "linear" else "pool", **chosen_params},
        "combine_name": COMBINATIONS[combo_kind],
        "model_share": {m: (chosen_params[m]["w"] if combo_kind == "linear"
                            else combine.model_share(chosen_params[m]["full"]) if chosen_params[m].get("full")
                            else 0.0) for m in MARKETS},
        "edge": {m: combo["thresholds"][m]["edge"] for m in MARKETS},
        "max_odds": {m: combo["thresholds"][m]["max_odds"] for m in MARKETS},
        "derived_extra_edge": config.DERIVED_EXTRA_EDGE,
        "derived_rho": derived_rho,
        "haircut": config.SPORTTIP_HAIRCUT,
        "tuning_scenario": config.TUNING_SCENARIO,
    }
    result = {
        "version": 2,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seasons": {
            "tune": f"{config.season_label(tune[0])} – {config.season_label(tune[-1])}",
            "test": f"{config.season_label(test[0])} – {config.season_label(test[-1])}",
        },
        "params": params,
        "timings": {k: v["name"] for k, v in TIMINGS.items()},
        "scenarios": {k: v["name"] for k, v in SCENARIOS.items()},
        "experiments": experiments_tables(model_table, best_model, market_loss, devig_table, method,
                                          combos, combo_kind, strategies, derived, derived_rho),
        "strategies": strategies,
        "tuning_grid": tuning_grids,
        "by_league": by_league,
        "by_season": by_season,
        "curves": curves,
        "derived": derived,
        "coverage": cov.to_dict(orient="records"),
        "runtime_seconds": round(time.time() - started),
    }
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = config.OUT_DIR / "backtest.json"
    out.write_text(json.dumps(clean(result), indent=1, ensure_ascii=False))
    print(f"Geschrieben: {out} ({time.time() - started:.0f} s)")
    return result


def experiments_tables(model_table, best_model, market_loss, devig_table, method,
                       combos, combo_kind, strategies, derived, derived_rho):
    """Die Experimente als Tabellen für die Website (Spalten + Zeilen)."""
    loss_columns = [{"label": "Variante", "kind": "text"},
                    {"label": "Anpassung", "kind": "loss"}, {"label": "Test", "kind": "loss"}]
    top = sorted(model_table, key=lambda r: r["tune"])[:5]
    model_rows = [{"cells": [r["name"], r["tune"], r["test"]], "chosen": r is best_model} for r in top]
    v1_model = next((r for r in model_table
                     if r["decay"] == 0.003 and r["shots_weight"] == 0 and r["rho"] == 0), None)
    if v1_model and v1_model not in top:
        model_rows.append({"cells": [v1_model["name"] + " (v1)", v1_model["tune"], v1_model["test"]],
                           "chosen": False})
    model_rows.append({"cells": ["Zum Vergleich: der Markt", market_loss["tune"], market_loss["test"]],
                       "chosen": False, "reference": True})

    method_names = {"proportional": "Proportional (v1)", "power": "Power-Methode", "shin": "Shin-Methode"}

    strategy_rows = []
    for s in strategies:
        for timing in TIMINGS:
            for scenario in SCENARIOS:
                if s["key"] != "combo" and (timing != "early" or scenario != "sporttip"):
                    continue
                r = s["results"][timing][scenario]["test"]["total"]
                strategy_rows.append({
                    "cells": [f"{s['name']} · {TIMINGS[timing]['name']} · {SCENARIOS[scenario]['name']}",
                              r.get("bets", 0), r.get("roi"), r.get("clv"), r.get("p_luck")],
                    "chosen": s["key"] == "combo" and timing == "early" and scenario == "sporttip"})

    return [
        {"title": "Eigenes Modell", "metric": "Log-Loss, 1X2 + Tore (tiefer = besser)",
         "note": f"{len(model_table)} Varianten getestet (Gedächtnis, Schüsse aufs Tor, Dixon-Coles). "
                 "Gezeigt: die 5 besten.",
         "columns": loss_columns, "rows": model_rows},
        {"title": "Marge herausrechnen", "metric": "Log-Loss der fairen Marktquoten",
         "note": "Wie verteilt der Buchmacher seine Marge auf die Ausgänge?",
         "columns": loss_columns,
         "rows": [{"cells": [method_names[r["method"]], r["tune"], r["test"]], "chosen": r["method"] == method}
                  for r in devig_table]},
        {"title": "Markt und Modell kombinieren",
         "metric": "Log-Loss; „Schlussquote“ = Abstand zur fairen Schlussquote",
         "note": "Die wichtigste Frage: Bringt das eigene Modell etwas zusätzlich zum Markt? "
                 "„Anpassung“ ist kreuzvalidiert: Jede Saison wird mit Gewichten aus den anderen "
                 "Saisons vorhergesagt.",
         "columns": loss_columns + [{"label": "Schlussquote", "kind": "loss"}],
         "rows": [{"cells": [COMBINATIONS[k], c["tune"], c["test"], c["test_close"]], "chosen": k == combo_kind}
                  for k, c in combos.items()]},
        {"title": "Wann und wo wetten", "metric": "Test-Saisons, alle Märkte zusammen",
         "note": "Gleiche Prognosen, verschiedene Quoten. „Glück?“ = Wahrscheinlichkeit, dass so ein "
                 "Resultat ohne echten Vorteil zustande kommt.",
         "columns": [{"label": "Strategie", "kind": "text"}, {"label": "Wetten", "kind": "int"},
                     {"label": "ROI", "kind": "signed"}, {"label": "CLV", "kind": "signed"},
                     {"label": "Glück?", "kind": "luck"}],
         "rows": strategy_rows},
        {"title": "Nebenmärkte (aus Marktquoten berechnet)", "metric": "Log-Loss in den Test-Saisons",
         "note": "Stimmen die fairen Quoten für Beide treffen und Über/Unter 1.5/3.5? "
                 "„Erwartet“ und „Eingetroffen“ sollten nahe beieinander liegen. "
                 f"Dixon-Coles-Korrektur dafür: {derived_rho}.",
         "columns": [{"label": "Markt", "kind": "text"}, {"label": "Aus Markt", "kind": "loss"},
                     {"label": "Eig. Modell", "kind": "loss"}, {"label": "Nur Schnitt", "kind": "loss"},
                     {"label": "Erwartet", "kind": "pct"}, {"label": "Eingetroffen", "kind": "pct"}],
         "rows": [{"cells": [d["name"], d["loss_market"], d["loss_model"], d["loss_base"],
                             d["predicted"], d["actual"]], "chosen": True} for d in derived]},
    ]


def clean(value):
    """Macht numpy-Zahlen und NaN JSON-tauglich (NaN gibt es in JSON nicht -> null)."""
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return None if np.isnan(value) else round(float(value), 5)
    return value
