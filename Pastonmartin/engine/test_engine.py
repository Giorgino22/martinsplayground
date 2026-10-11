"""Tests. Starten mit:  python -m unittest   (im Ordner engine/)

Die meisten Tests brauchen kein Internet. Der PipelineTest erfindet eine ganze Liga
mit bekannten Teamstärken und lässt Backtest + Tipps darauf laufen. FairJsTest prüft,
dass die Website (JavaScript) genau gleich rechnet wie Python.
"""
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

import backtest
import combine
import config
import data
import markets
import model
import oddsapi
import odds
import tips

SITE_JS = Path(__file__).resolve().parent.parent / "site" / "js"


class OddsTest(unittest.TestCase):
    def test_fair_probs_remove_margin(self):
        h, d, a = odds.fair_probs(2.00, 3.60, 3.90)
        self.assertAlmostEqual(h + d + a, 1.0)
        self.assertAlmostEqual(h, 0.4836, places=3)

    def test_devig_methods_add_up_and_shrink_longshots(self):
        quotes = np.array([[1.30, 5.50, 11.0], [2.0, 3.6, 3.9], [1.92, 1.92, np.nan]])
        proportional = odds.devig(quotes, "proportional")
        for method in odds.DEVIG_METHODS:
            p = odds.devig(quotes, method)
            self.assertAlmostEqual(p[0].sum(), 1.0)
            self.assertTrue(np.isnan(p[2]).all())          # fehlende Quote -> keine Wahrscheinlichkeit
            if method != "proportional":
                # Power und Shin geben dem Aussenseiter weniger als die einfache Methode
                self.assertLess(p[0, 2], proportional[0, 2])

    def test_devig_without_margin(self):
        p = odds.devig([[2.04, 3.75, 4.3]], "shin")         # Summe der 1/Quoten < 1 (Wettbörse)
        self.assertAlmostEqual(p.sum(), 1.0)

    def test_edge_and_min_odds(self):
        self.assertAlmostEqual(odds.edge(0.5, 2.2), 0.1)
        self.assertAlmostEqual(odds.min_odds(0.5, 0.05), 2.1)

    def test_kelly_is_capped(self):
        self.assertEqual(odds.kelly_stake(0.4, 2.0, 0.25, 0.02), 0.0)   # kein Value -> 0
        self.assertEqual(odds.kelly_stake(0.9, 2.0, 1.0, 0.02), 0.02)   # riesiger Value -> Deckel


class MarketsTest(unittest.TestCase):
    def test_all_markets_add_up(self):
        p = {k: float(v[0]) for k, v in markets.from_goals(1.6, 1.1).items()}
        self.assertAlmostEqual(p["H"] + p["D"] + p["A"], 1.0)
        self.assertAlmostEqual(p["1X"], p["H"] + p["D"])
        for over, under in [("O15", "U15"), ("O", "U"), ("O35", "U35"), ("BY", "BN")]:
            self.assertAlmostEqual(p[over] + p[under], 1.0)
        self.assertGreater(p["O15"], p["O"])
        self.assertGreater(p["O"], p["O35"])

    def test_dixon_coles_makes_draws_likelier(self):
        plain = markets.from_goals(1.3, 1.1)["D"][0]
        corrected = markets.from_goals(1.3, 1.1, rho=-0.1)["D"][0]
        self.assertGreater(corrected, plain)

    def test_implied_goals_round_trip(self):
        for rho in (0.0, -0.1):
            p = markets.from_goals([1.7, 0.9], [0.8, 1.4], rho)
            home, away = markets.implied_goals(p["H"], p["D"], p["A"], p["O"], rho)
            np.testing.assert_allclose(home, [1.7, 0.9], rtol=1e-4)
            np.testing.assert_allclose(away, [0.8, 1.4], rtol=1e-4)

    def test_implied_goals_without_over_under(self):
        p = markets.from_goals(1.5, 1.0)
        home, away = markets.implied_goals(p["H"], p["D"], p["A"])
        self.assertAlmostEqual(home[0], 1.5, places=3)
        self.assertAlmostEqual(away[0], 1.0, places=3)


class CombineTest(unittest.TestCase):
    def test_identity_keeps_the_market(self):
        market = np.array([[0.5, 0.3, 0.2]])
        np.testing.assert_allclose(combine.apply(combine.identity(3), market), market)

    def test_learns_to_use_an_informative_model(self):
        rng = np.random.default_rng(0)
        truth = rng.dirichlet([4, 3, 3], size=20000)
        outcome = np.array([rng.choice(3, p=row) for row in truth])

        def noisy(p, spread):
            q = np.exp(np.log(p) + rng.normal(0, spread, p.shape))
            return q / q.sum(axis=1, keepdims=True)

        market, own_model = noisy(truth, 0.10), noisy(truth, 0.25)
        params = combine.fit(market, outcome, own_model)
        self.assertGreater(params["w_model"], 0.03)    # das Modell weiss etwas, also bekommt es Gewicht
        pooled = combine.apply(params, market, own_model)
        self.assertLess(odds.log_loss(pooled, outcome), odds.log_loss(market, outcome))


class ModelTest(unittest.TestCase):
    def test_probabilities_add_up(self):
        p = model.outcome_probs(1.6, 1.1)
        self.assertAlmostEqual(p["H"] + p["D"] + p["A"], 1.0)
        self.assertAlmostEqual(p["O"] + p["U"], 1.0)
        self.assertGreater(p["H"], p["A"])

    def test_equal_teams_are_symmetric(self):
        p = model.outcome_probs(1.3, 1.3)
        self.assertAlmostEqual(p["H"], p["A"])

    def test_fit_finds_the_strong_team(self):
        matches = fake_league(seasons=[2020], seed=1)
        for shots_weight in (0.0, 0.7):
            fitted = model.fit(matches, matches["date"].max() + pd.Timedelta(days=1), 0.003, shots_weight)
            p = fitted.predict("Team 0", "Team 9")      # Team 0 ist das stärkste
            self.assertGreater(p["H"], 0.6)

    def test_unknown_team_gives_no_prediction(self):
        matches = fake_league(seasons=[2020], seed=2)
        fitted = model.fit(matches, matches["date"].max() + pd.Timedelta(days=1), decay=0.003)
        self.assertIsNone(fitted.predict("Team 0", "Aufsteiger"))

    def test_fit_never_looks_into_the_future(self):
        matches = fake_league(seasons=[2019, 2020], seed=3)
        cutoff = matches["date"].iloc[len(matches) // 2]
        fitted = model.fit(matches, cutoff, decay=0.003)
        seen = matches[matches["date"] < cutoff]
        self.assertAlmostEqual(fitted.experience.sum() / 2,
                               np.exp(-0.003 * (cutoff - seen["date"]).dt.days).sum(), places=6)


class DataTest(unittest.TestCase):
    def test_old_and_new_column_names(self):
        old = "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,PSH,PSD,PSA,BbAvH,BbAvD,BbAvA\nE0,13/08/16,A,B,2,1,2.0,3.5,4.0,1.9,3.4,3.9\n"
        new = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,HST,AST,PSH,PSD,PSA,AvgH,AvgD,AvgA,MaxH,MaxD,MaxA\n" \
              "E0,13/08/2022,15:00,A,B,0,0,4,2,2.0,3.5,4.0,1.9,3.4,3.9,2.1,3.7,4.2\n"
        for text, year in [(old, 2016), (new, 2022)]:
            df = data.normalize(data.read_csv(text.encode()), "E0")
            self.assertEqual(df["date"].iloc[0], pd.Timestamp(year, 8, 13))
            self.assertEqual(df["season"].iloc[0], year)
            self.assertEqual(df["avg_h"].iloc[0], 1.9)
            self.assertEqual(df["ref_a"].iloc[0], 4.0)
            self.assertEqual(df["ref_name"].iloc[0], "Pinnacle")
        new_df = data.normalize(data.read_csv(new.encode()), "E0")
        # 0 Tore sind gültig (Quoten von 0 dagegen nicht)
        self.assertEqual(new_df["hg"].iloc[0], 0)
        self.assertEqual(new_df["sot_h"].iloc[0], 4)
        self.assertEqual(new_df["max_a"].iloc[0], 4.2)

    def test_reference_falls_back_when_pinnacle_is_missing(self):
        text = "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,PSH,PSD,PSA,BFEH,BFED,BFEA,AvgH,AvgD,AvgA\n" \
               "E0,10/01/2026,A,B,1,0,2.0,3.5,4.0,2.1,3.6,4.1,1.9,3.4,3.9\n" \
               "E0,17/01/2026,C,D,1,1,,,,2.1,3.6,4.1,1.9,3.4,3.9\n" \
               "E0,24/01/2026,E,F,0,2,0,0,0,,,,1.9,3.4,3.9\n"
        df = data.normalize(data.read_csv(text.encode()), "E0")
        self.assertEqual(df["ref_name"].tolist(), ["Pinnacle", "Betfair", "Marktschnitt"])
        self.assertEqual(df["ref_h"].tolist(), [2.0, 2.1, 1.9])

    def test_implausible_odds_are_rejected(self):
        # Wettbörse ohne Umsatz: 1.02 und 1.25 ergäbe 178 % -> unbrauchbar, Marktschnitt nehmen
        text = "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,BFE>2.5,BFE<2.5,Avg>2.5,Avg<2.5\n" \
               "E0,11/10/2026,Utrecht,Willem II,0,0,1.02,1.25,1.55,2.45\n"
        df = data.normalize(data.read_csv(text.encode()), "E0")
        self.assertEqual(df["ref_over"].iloc[0], 1.55)
        self.assertEqual(df["ref_under"].iloc[0], 2.45)

    def test_extra_league_uses_closing_odds(self):
        text = "Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PSCH,PSCD,PSCA,AvgCH,AvgCD,AvgCA\nSwitzerland,Super League,2023/2024,22/07/2023,18:00,Basel,Zurich,1,1,D,2.1,3.4,3.3,2.0,3.3,3.2\n"
        df = data.normalize(data.read_csv(text.encode()), "SWZ")
        self.assertEqual(df["home"].iloc[0], "Basel")
        self.assertEqual(df["ref_h"].iloc[0], 2.1)
        self.assertEqual(df["book_h"].iloc[0], 2.0)


class OddsApiTest(unittest.TestCase):
    def test_team_names(self):
        known = {"Man United", "Man City", "Nott'm Forest", "Leicester", "Basel", "St. Gallen"}
        self.assertEqual(oddsapi.match_team("Manchester United", known), "Man United")
        self.assertEqual(oddsapi.match_team("Leicester City", known), "Leicester")
        self.assertEqual(oddsapi.match_team("FC Basel", known), "Basel")
        self.assertEqual(oddsapi.match_team("FC St. Gallen", known), "St. Gallen")
        self.assertIsNone(oddsapi.match_team("Real Madrid", known))


class SimulateTest(unittest.TestCase):
    def test_takes_only_value_bets(self):
        meta = pd.DataFrame({"date": pd.to_datetime(["2023-01-01", "2023-01-02", "2023-01-03"]),
                             "league": "E0", "season": 2022})
        fair = odds.devig([[2.0, 3.6, 3.9]] * 3, "proportional")
        quotes = np.array([[2.3, 3.4, 3.7], [1.9, 3.4, 3.7], [1.5, 3.4, 9.5]])
        outcome = np.array([0, 2, 2])
        bets = backtest.simulate(meta, np.array([True, True, True]), fair, quotes, fair, outcome,
                                 edge_min=0.05, max_odds=8.0)
        # Spiel 1: 0.484 * 2.3 = 1.11 -> Value. Spiel 2: 1.9 ist zu tief. Spiel 3: Quote über 8.
        self.assertEqual(len(bets), 1)
        self.assertAlmostEqual(bets["profit"].iloc[0], 1.3)
        self.assertTrue(bets["won"].iloc[0])
        self.assertAlmostEqual(bets["clv"].iloc[0], 2.3 * fair[0, 0] - 1)


class PipelineTest(unittest.TestCase):
    """Ganzer Durchlauf mit einer erfundenen Liga (ohne Internet)."""

    def test_backtest_and_tips(self):
        league = fake_league(seasons=range(2014, 2020), seed=7, with_odds=True)
        csv_by_season = {s: to_csv(league[league["season"] == s]) for s in range(2014, 2020)}

        def fake_fetch(path, max_age_hours=None):
            for season, content in csv_by_season.items():
                if config.season_code(season) in path:
                    return content
            return None   # keine Fixtures, keine Extra-Ligen

        with tempfile.TemporaryDirectory() as tmp, mock.patch.multiple(
            config, LEAGUES={"E0": {"name": "Test", "country": "Testland"}},
            FIRST_SEASON=2014, TUNE_SEASONS=range(2016, 2018), TEST_SEASONS=range(2018, 2020),
            MIN_BETS_FOR_TUNING={"1X2": 20, "OU": 20}, OUT_DIR=Path(tmp),
        ), mock.patch.object(data, "fetch", fake_fetch), \
                mock.patch.dict(os.environ, {"PASTONMARTIN_WORKERS": "1"}):
            result = backtest.run()
            params = result["params"]
            self.assertIn(params["model"]["decay"], config.DECAY_GRID)
            self.assertIn(params["devig"], odds.DEVIG_METHODS)
            self.assertEqual([s["key"] for s in result["strategies"]], ["value", "model", "combo", "v1"])
            self.assertEqual(len(result["experiments"]), 5)
            # Die Höchstquote aus fünf Buchmachern schlägt Pinnacle oft -> der Value-Finder findet Wetten
            value = next(s for s in result["strategies"] if s["key"] == "value")
            self.assertGreater(value["results"]["early"]["max"]["test"]["total"]["bets"], 0)
            json.loads((Path(tmp) / "backtest.json").read_text())   # gültiges JSON

            upcoming = league.tail(3).copy()
            upcoming["date"] = pd.Timestamp(date.today() + timedelta(days=2))
            upcoming["time"] = "15:00"
            with mock.patch.object(data, "load_fixtures", lambda: data.normalize(
                    data.read_csv(to_csv(upcoming)), "E0")):
                tips.run()
            out = json.loads((Path(tmp) / "tips.json").read_text())
            self.assertEqual(len(out["matches"]), 3)
            match_markets = out["matches"][0]["markets"]
            self.assertEqual(set(match_markets), set(markets.MARKETS))
            for market in match_markets.values():
                if market is not match_markets["DC"]:
                    self.assertAlmostEqual(sum(s["p"] for s in market["selections"]), 1.0, places=3)
            json.loads((Path(tmp) / "results.json").read_text())


@unittest.skipUnless(shutil.which("node"), "Node.js fehlt")
class FairJsTest(unittest.TestCase):
    """Rechnet die Website (site/js/fair.js) genau gleich wie Python?"""

    def test_same_numbers_as_python(self):
        rng = np.random.default_rng(5)
        n = 25
        true_goals = np.column_stack([rng.uniform(0.6, 2.6, n), rng.uniform(0.4, 2.0, n)])
        truth = markets.from_goals(true_goals[:, 0], true_goals[:, 1])
        margin = 1.04
        ref_odds = {
            "1X2": np.round(1 / (np.column_stack([truth["H"], truth["D"], truth["A"]]) * margin), 2),
            "OU": np.round(1 / (np.column_stack([truth["O"], truth["U"]]) * margin), 2),
        }
        model_goals = true_goals * rng.uniform(0.8, 1.2, true_goals.shape)
        model_goals[:5] = np.nan                                # einige Spiele ohne Modell
        cases = []
        for devig_method, kind in [("shin", "pool"), ("power", "pool"), ("proportional", "linear")]:
            params = json.loads(json.dumps(config.DEFAULT_PARAMS))
            params["devig"] = devig_method
            params["derived_rho"] = -0.05
            params["model"]["rho"] = -0.05
            if kind == "pool":
                params["combine"] = {"kind": "pool",
                                     "1X2": {"full": {"bias": [0, 0.05, -0.02], "w_market": 1.05, "w_model": 0.1},
                                             "ref_only": {"bias": [0, 0.03, 0], "w_market": 0.98, "w_model": 0}},
                                     "OU": {"full": {"bias": [0, 0.01], "w_market": 1.0, "w_model": 0.2},
                                            "ref_only": {"bias": [0, 0], "w_market": 1.0, "w_model": 0}}}
            else:
                params["combine"] = {"kind": "linear", "1X2": {"w": 0.2}, "OU": {"w": 0.1}}
            probs = tips.probabilities(params, ref_odds, model_goals)
            for i in range(n):
                model_input = None if np.isnan(model_goals[i, 0]) else {
                    m: [float(probs["model"][s][i]) for s in sel] for m, sel in backtest.MARKETS.items()}
                cases.append({
                    "params": params,
                    "ref": {m: ref_odds[m][i].tolist() for m in ref_odds},
                    "model": model_input,
                    "expected": {k: float(v[i]) for k, v in probs["final"].items()},
                })
        runner = (f"import {{ matchProbabilities }} from '{(SITE_JS / 'fair.js').as_uri()}';\n"
                  "let input = '';\n"
                  "process.stdin.on('data', d => input += d);\n"
                  "process.stdin.on('end', () => {\n"
                  "  const cases = JSON.parse(input);\n"
                  "  const out = cases.map(c => matchProbabilities(c.params, c.ref, c.model).final);\n"
                  "  process.stdout.write(JSON.stringify(out));\n"
                  "});\n")
        result = subprocess.run(["node", "--input-type=module", "-e", runner], input=json.dumps(cases),
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        for case, got in zip(cases, json.loads(result.stdout)):
            for key, expected in case["expected"].items():
                self.assertAlmostEqual(got[key], expected, places=5, msg=key)


FUNCTIONS = Path(__file__).resolve().parent.parent / "functions" / "api"

# Node-Skript: lädt eine Cloudflare-Function mit nachgebauter Umgebung und ruft sie auf
def run_node(script, data=None):
    """Führt ein kleines ES-Modul mit Node aus. INPUT = data, OUTPUT(x) gibt x als JSON zurück."""
    with tempfile.TemporaryDirectory() as tmp:
        file = Path(tmp) / "runner.mjs"
        file.write_text("import { readFileSync } from 'node:fs';\n"
                        "const INPUT = readFileSync(0, 'utf8');\n"
                        "const OUTPUT = x => process.stdout.write(JSON.stringify(x));\n" + script)
        result = subprocess.run(["node", str(file)], input=data or "", capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "Node.js fehlt")
class SporttipJsTest(unittest.TestCase):
    """Ordnet site/js/sporttip.js die Sporttip-Spiele den richtigen Spielen zu?"""

    def test_matching_and_markets(self):
        runner = (f"import {{ matchEvents, footballOdds }} from '{(SITE_JS / 'sporttip.js').as_uri()}';\n"
                  "const ev = (home, away, kickoff, markets = []) => ({ home, away, kickoff, markets });\n"
                  "const events = [\n"
                  "  ev('FC Bayern München', 'Borussia Dortmund', '2026-10-17T16:30:00Z'),\n"
                  "  ev('SC Freiburg', 'Schalke 04', '2026-10-17T13:30:00Z', [\n"
                  "    { type: 1, line: null, odds: { 1: 1.85, 2: 4.1, 3: 3.6 } },\n"
                  "    { type: 1, line: null, odds: { 1: 9, 2: 9, 3: 9 } },\n"
                  "    { type: 18, line: 2.5, odds: { 12: 1.9, 13: 1.8 } },\n"
                  "    { type: 18, line: 4.5, odds: { 12: 3.3, 13: 1.3 } },\n"
                  "    { type: 18, line: 3.5, odds: { 12: 2.1 } }]),\n"
                  "  ev('Mainz 05', 'Augsburg', '2026-10-18T13:30:00Z'),\n"
                  "];\n"
                  "const matches = [\n"
                  "  { id: 'a', home: 'Bayern Munich', away: 'Dortmund', kickoff: '2026-10-17T16:30:00+00:00' },\n"
                  "  { id: 'b', home: 'Freiburg', away: 'Schalke 04', kickoff: '2026-10-17T13:30:00+00:00' },\n"
                  "  { id: 'c', home: 'Mainz', away: 'Augsburg', kickoff: '2026-10-17T13:30:00+00:00' },\n"
                  "  { id: 'd', home: 'Union Berlin', away: 'Hoffenheim', kickoff: '2026-10-17T16:30:00+00:00' },\n"
                  "];\n"
                  "const pairs = matchEvents(events, matches);\n"
                  "const out = Object.fromEntries([...pairs].map(([id, e]) => [id, e.home]));\n"
                  "process.stdout.write(JSON.stringify({ pairs: out, odds: footballOdds(events[1]) }));\n")
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "runner.mjs"
            file.write_text(runner)
            result = subprocess.run(["node", str(file)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        # Mainz spielt bei Sporttip an einem anderen Tag, Union-Hoffenheim fehlt ganz
        self.assertEqual(out["pairs"], {"a": "FC Bayern München", "b": "SC Freiburg"})
        self.assertEqual(out["odds"], {"1X2": {"H": 1.85, "D": 4.1, "A": 3.6}, "OU": {"O": 1.9, "U": 1.8}})


@unittest.skipUnless(shutil.which("node"), "Node.js fehlt")
class ScanJsTest(unittest.TestCase):
    """Scan über alle Sportarten (site/js/scan.js) mit nachgebautem Sporttip und The Odds API."""

    def test_scan_finds_value_and_ignores_wrong_markets(self):
        script = (
            "globalThis.document = { getElementById: () => null, addEventListener: () => {} };\n"
            "const soon = minutes => new Date(Date.now() + 86400e3 + minutes * 60e3).toISOString();\n"
            "const item = (type, entity) => ({ kind: 0, type, entity });\n"
            "const sel = (urn, type, odds) => item('Selection', { urn, type: `asw:selectiontype:${type}`, odds, state: 1 });\n"
            "const market = (urn, type, selections, total) => item('Market', { urn, type: `asw:markettype:${type}`, state: 1,\n"
            "  properties: total ? { total, mode: 'prematch' } : { mode: 'prematch' }, selections });\n"
            "const page = (path, items) => [JSON.stringify({ path, found: true }), JSON.stringify({ payload: JSON.stringify(\n"
            "  [{ type: 'SportsbookSnapshotUpdated', body: { snapshotUpdate: { snapshotUpdateItems: items } } }]) })].join('\\n');\n"
            "const tennis = [\n"
            "  item('Event', { urn: 't', name: 'Alcaraz C. : Sinner J.', startTime: soon(5), sport: 'asw:sport:5', markets: ['tw', 'tt', 'tx'] }),\n"
            "  market('tw', 186, ['t1', 't2']), sel('t1', 4, 2.25), sel('t2', 5, 1.75),\n"            # Alcaraz zu hoch: Value
            "  market('tt', 189, ['t3', 't4'], 38.5), sel('t3', 12, 1.85), sel('t4', 13, 1.85),\n"   # normal: kein Value
            "  market('tx', 225, ['t5', 't6'], 38.5), sel('t5', 12, 1.25), sel('t6', 13, 3.8),\n"    # passt nicht: ignoriert
            "];\n"
            "const soccer = [\n"
            "  item('Event', { urn: 'f', name: 'Alpha : Beta Utd', startTime: soon(60), sport: 'asw:sport:1', markets: ['fw', 'ft', 'fb'] }),\n"
            "  market('fw', 1, ['f1', 'f2', 'f3']), sel('f1', 1, 2.15), sel('f2', 2, 3.4), sel('f3', 3, 3.7),\n"
            "  market('ft', 18, ['f4', 'f5'], 2.5), sel('f4', 12, 1.9), sel('f5', 13, 1.9),\n"
            "  market('fb', 29, ['f6', 'f7']), sel('f6', 74, 1.7), sel('f7', 76, 2.05),\n"
            "];\n"
            "const api = {\n"
            "  'list=1': { sports: [{ key: 'tennis_atp', group: 'Tennis', title: 'ATP' }, { key: 'soccer_x', group: 'Soccer', title: 'Liga X' },\n"
            "    { key: 'icehockey_x', group: 'Ice Hockey', title: 'Hockey' }] },\n"
            "  'events=tennis_atp': { events: [{ id: 't1', home: 'Jannik Sinner', away: 'Carlos Alcaraz', kickoff: soon(0) }] },\n"
            "  'events=soccer_x': { events: [{ id: 'f1', home: 'Alpha FC', away: 'Beta United', kickoff: soon(60) }] },\n"
            "  'sport=tennis_atp': { remaining: '470', events: [{ id: 't1', home: 'Jannik Sinner', away: 'Carlos Alcaraz',\n"
            "    source: 'Pinnacle', h2h: [1.8, 2.1], totals: [{ point: 38.5, over: 1.9, under: 1.9 }] }] },\n"
            "  'sport=soccer_x': { remaining: '468', events: [{ id: 'f1', home: 'Alpha FC', away: 'Beta United',\n"
            "    source: 'Pinnacle', h2h: [2.0, 3.6, 4.0], totals: [{ point: 2.5, over: 1.95, under: 1.95 }] }] },\n"
            "};\n"
            "const asked = [];\n"
            "globalThis.fetch = async url => {\n"
            "  const query = url.split('?')[1];\n"
            "  asked.push(decodeURIComponent(query));\n"
            "  if (url.startsWith('/api/sporttip')) {\n"
            "    const paths = new URLSearchParams(query).get('paths').split(',');\n"
            "    const text = paths.map(p => page(p, p === '/tennis' ? tennis : p === '/fussball' ? soccer : [])).join('\\n');\n"
            "    return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });\n"
            "  }\n"
            "  return new Response(JSON.stringify(api[query] ?? { error: 'unbekannt' }),\n"
            "    { status: api[query] ? 200 : 404, headers: { 'content-type': 'application/json' } });\n"
            "};\n"
            f"const {{ scan }} = await import('{(SITE_JS / 'scan.js').as_uri()}');\n"
            "const params = { devig: 'power', edge: { '1X2': 0.01, OU: 0.02 }, max_odds: { '1X2': 8, OU: 8 },\n"
            "  derived_extra_edge: 0.01, derived_rho: 0 };\n"
            "const r = await scan(() => {}, params);\n"
            "OUTPUT({ values: r.values.map(v => ({ label: v.label, odds: v.odds, edge: v.edge, group: v.event.group })),\n"
            "  rejected: r.rejected, compared: r.compared, pairs: r.pairs, margins: r.margins, emptyPages: r.emptyPages,\n"
            "  remaining: r.remaining, asked });\n")
        out = run_node(script)
        values = {v["label"]: v for v in out["values"]}
        self.assertEqual(set(values), {"Sieg Alcaraz C.", "Sieg Alpha"})
        # Tennis: Sporttip nennt Alcaraz zuerst, Pinnacle Sinner -> vertauscht zugeordnet
        self.assertEqual(values["Sieg Alcaraz C."]["group"], "Tennis")
        self.assertAlmostEqual(values["Sieg Alcaraz C."]["edge"], 0.04, delta=0.01)
        self.assertGreater(values["Sieg Alpha"]["edge"], 0.03)
        self.assertEqual(out["rejected"], 1)                     # Total 225 passt nicht zur fairen Chance
        self.assertEqual(out["pairs"], 2)
        self.assertEqual(out["compared"], 6)                     # 3 Tennis- und 3 Fussball-Wettarten
        margins = {m["label"]: m["margin"] for m in out["margins"]}
        self.assertAlmostEqual(margins["Tennis · Sieger"], 1 / 2.25 + 1 / 1.75 - 1)
        self.assertAlmostEqual(margins["Fussball · Sieger"], 1 / 2.15 + 1 / 3.4 + 1 / 3.7 - 1)
        self.assertIn("/eishockey", out["emptyPages"])
        self.assertIn(out["remaining"], ("470", "468"))
        # Eishockey hatte keine Sporttip-Spiele: keine Abfrage dafür. Quoten nur für die zwei Ligen.
        self.assertNotIn("events=icehockey_x", out["asked"])
        self.assertEqual(sorted(q for q in out["asked"] if q.startswith("sport=")), ["sport=soccer_x", "sport=tennis_atp"])


FUNCTION_RUNNER = """
const [file, scenario] = process.argv.slice(2);
const stored = new Map();
globalThis.caches = { default: {
  match: async key => stored.get(key.url),
  put: async (key, response) => stored.set(key.url, response),
} };
const calls = [];
globalThis.fetch = async url => {
  calls.push(url);
  const events = [
    { id: 'a1', home_team: 'Arsenal', away_team: 'Chelsea', commence_time: '2026-10-17T14:00:00Z', bookmakers: [
      { key: 'betfair_ex_eu', markets: [{ key: 'h2h', outcomes: [
        { name: 'Arsenal', price: 2.1 }, { name: 'Draw', price: 3.5 }, { name: 'Chelsea', price: 3.9 }] }] },
      { key: 'pinnacle', markets: [
        { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.05 }, { name: 'Draw', price: 3.6 }, { name: 'Chelsea', price: 3.8 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: 1.6, point: 2.25 }, { name: 'Under', price: 2.4, point: 2.25 },
                                    { name: 'Over', price: 1.95, point: 2.5 }, { name: 'Under', price: 1.93, point: 2.5 }] }] }] },
    { home_team: 'Sinner', away_team: 'Alcaraz', commence_time: '2026-10-17T16:00:00Z', bookmakers: [
      { key: 'pinnacle', markets: [{ key: 'totals', outcomes: [] }] },
      { key: 'betfair_ex_eu', markets: [{ key: 'h2h', outcomes: [{ name: 'Sinner', price: 1.8 }, { name: 'Alcaraz', price: 2.1 }] }] }] },
    { home_team: 'X', away_team: 'Y', commence_time: '2026-10-17T16:00:00Z', bookmakers: [] },
  ];
  const body = url.includes('/odds?') || url.includes('/events?') ? events
    : [{ key: 'soccer_epl', group: 'Soccer', title: 'EPL', active: true, has_outrights: false }];
  return new Response(JSON.stringify(body), { headers: { 'x-requests-remaining': '480' } });
};
const rows = new Map();
const db = {
  exec: async () => {},
  prepare: sql => ({ bind: (...args) => ({
    run: async () => {
      if (sql.startsWith('INSERT')) rows.set(args[0], { created: args[1], data: args[2] });
      if (sql.startsWith('DELETE')) rows.delete(args[0]);
    },
  }), all: async () => ({ results: [...rows.values()].sort((a, b) => b.created.localeCompare(a.created)) }) }),
};
const { onRequest, onRequestGet } = await import(file);
if (scenario === 'middleware') {
  const next = async () => new Response('APP', { headers: { 'cache-control': 'public, max-age=60' } });
  const env = { SITE_PASSWORD: 'geheim', SESSION_SECRET: 'abc' };
  const go = async (url, environment, init = {}) => {
    const r = await onRequest({ request: new Request(url, init), env: environment, next });
    return { status: r.status, location: r.headers.get('location'), cookie: r.headers.get('set-cookie'),
      cache: r.headers.get('cache-control'), text: await r.text() };
  };
  const login = password => go('https://x/login', env, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
  const out = {};
  out.noPassword = await go('https://x/', {});
  out.home = await go('https://x/', env);
  out.api = await go('https://x/api/bets', env);
  out.data = await go('https://x/data/tips.json', env);
  out.loginPage = await go('https://x/login', env);
  out.wrong = await login('falsch');
  out.right = await login('geheim');
  const cookie = out.right.cookie.split(';')[0];
  out.authed = await go('https://x/data/tips.json', env, { headers: { cookie } });
  out.forged = await go('https://x/', env, { headers: { cookie: cookie.slice(0, -3) + 'xyz' } });
  out.otherSecret = await go('https://x/', { ...env, SESSION_SECRET: 'neu' }, { headers: { cookie } });
  out.logout = await go('https://x/logout', env, { headers: { cookie } });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
const handler = onRequestGet || onRequest;
const call = async (url, env, init = {}) => {
  const response = await handler({ request: new Request(url, init), env, waitUntil: p => p });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, body: type.includes('json') ? await response.json() : await response.text() };
};
const out = {};
if (scenario === 'sporttip') {
  // Nachgebauter Sporttip-Server: antwortet wie der echte auf Seite, Markt-Umschalter und Kategorien (erfundene Spiele)
  const zlib = await import('node:zlib');
  const pack = message => { const b = zlib.deflateRawSync(JSON.stringify(message)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
  const item = (type, entity) => ({ kind: 0, type, entity });
  const snapshot = items => pack({ payload: JSON.stringify([{ type: 'SportsbookSnapshotUpdated', body: { snapshotUpdate: { snapshotUpdateItems: items } } }]) });
  const selections = list => list.map(([urn, type, odds, state = 1]) => item('Selection', { urn, type: `asw:selectiontype:${type}`, odds, state }));
  const events = [
    item('Event', { urn: 'e1', name: 'Alpha FC : Beta United', startTime: '2026-10-17T14:00:00Z', sport: 'asw:sport:1', markets: ['m1', 'm2', 'm3', 'm4', 'm6'] }),
    item('Event', { urn: 'e2', name: 'Gamma : Delta', startTime: '2026-10-17T16:00:00Z', markets: ['m5'] }),
  ];
  const mainMarkets = [
    item('Market', { urn: 'm1', type: 'asw:markettype:1', state: 1, properties: { IsMainMarket: true, mode: 'prematch' }, selections: ['s1', 's2', 's3'] }),
    item('Market', { urn: 'm2', type: 'asw:markettype:18', state: 1, properties: { total: 2.5 }, selections: ['s4', 's5'] }),
    item('Market', { urn: 'm3', type: 'asw:markettype:18', state: 2, properties: { total: 3.5 }, selections: ['s6', 's7'] }),
    item('Market', { urn: 'm4', type: 'asw:markettype:18', state: 1, properties: { total: 1.5 }, selections: ['s8', 's9'] }),
    item('Market', { urn: 'm5', type: 'asw:markettype:1', state: 1, selections: ['s10'] }),
    ...selections([['s1', 1, 1.85], ['s2', 2, 4.1], ['s3', 3, 3.6], ['s4', 12, 1.9], ['s5', 13, 1.8], ['s6', 12, 3], ['s7', 13, 1.3],
      ['s8', 12, 1.2], ['s9', 13, 4, 2], ['s10', 1, 2]]),        // s9 gesperrt
  ];
  const doubleChance = [   // kommt erst, wenn der Markt-Umschalter Gruppe 3 zeigt
    item('Market', { urn: 'm6', type: 'asw:markettype:10', state: 1, selections: ['s11', 's12', 's13'] }),
    ...selections([['s11', 9, 1.25], ['s12', 10, 1.3], ['s13', 11, 1.95]]),
  ];
  const grid = { type: 'SportsGridViewNode', id: 'Grid1',
    availableMarketSwitcher: [1, 2, 3, 4, 5].map(n => `asw:marketconfig:${n}`),
    selectedMarketSwitcher: [{ marketConfigUrn: 'asw:marketconfig:1' }, { marketConfigUrn: 'asw:marketconfig:2' }],
    viewNode: { viewNodes: [{ type: 'EventViewNode', eventUrn: 'e1' }, { type: 'EventViewNode', eventUrn: 'e2' }] } };
  out.connections = 0;
  out.sent = [];
  out.switched = [];
  out.categories = [];
  globalThis.fetch = async (url, init) => {
    out.connections++;
    out.origin = init.headers.Origin;
    const listeners = [];
    const emit = (...frames) => setTimeout(() => frames.forEach(data => listeners.forEach(f => f({ data }))), 20);
    return { status: 101, webSocket: {
      accept() {},
      close() {},
      addEventListener: (name, f) => { if (name === 'message') listeners.push(f); },
      send(buffer) {
        const message = JSON.parse(zlib.inflateRawSync(Buffer.from(buffer)).toString());
        const request = message.payload?.[0];
        out.sent.push(request ? request.type : Object.keys(message)[0]);
        if (request?.type === 'RetrieveSportsbookPage') {
          const answer = request.body.urlPart === '/fussball/test/liga'
            ? { viewNode: { type: 'CollectionViewNode', viewNodes: [grid] }, categoryPath: { categories: ['asw:category:1', 'asw:category:2'] } }
            : { viewNode: { type: 'CollectionViewNode', viewNodes: [] } };
          emit(pack({ ping: {} }), snapshot(events),
            pack({ payload: JSON.stringify([{ type: 'SportsbookPageRetrieved', requestId: request.requestId, body: answer }]) }),
            snapshot(mainMarkets));
        } else if (request?.type === 'UpdateSportsbookPage') {
          const configs = JSON.parse(request.body.commandProperties[1].value);
          out.switched.push([request.body.sportsGridViewNodeId, configs]);
          emit(snapshot(configs.includes('asw:marketconfig:3') ? doubleChance : []));
        } else if (request?.type === 'RetrieveCategoryChildren') {
          out.categories.push(request.body.category);
          emit(pack({ payload: [{ type: 'CategoryChildrenRetrieved', body: { children: [{ name: 'Liga 2', urlPart: '/fussball/test/liga2' }] } }] }));
        }
      },
    } };
  };
  out.bad = await call('https://x/api/sporttip?paths=../geheim', {});
  out.tooMany = await call('https://x/api/sporttip?paths=/a,/b,/c,/d,/e', {});
  out.ok = await call('https://x/api/sporttip?paths=/fussball/test/liga,/fussball/leer&all=1&tree=1', {});
  out.again = await call('https://x/api/sporttip?paths=/fussball/test/liga,/fussball/leer&all=1&tree=1', {});
  // Sporttip lehnt ab, oder schliesst die Verbindung gleich wieder
  globalThis.fetch = async () => ({ status: 403 });
  out.refused = await call('https://x/api/sporttip?paths=/fussball/a', {});
  globalThis.fetch = async () => {
    const closers = [];
    return { status: 101, webSocket: { accept() { setTimeout(() => closers.forEach(f => f()), 10); }, close() {}, send() {},
      addEventListener: (name, f) => { if (name === 'close') closers.push(f); } } };
  };
  out.closed = await call('https://x/api/sporttip?paths=/fussball/b', {});
} else if (scenario === 'odds') {
  out.noKey = await call('https://x/api/odds?sport=soccer_epl', {});
  out.locked = await call('https://x/api/odds?sport=soccer_epl', { ODDS_API_KEY: 'k', JOURNAL_KEY: 's' });
  out.bad = await call('https://x/api/odds?sport=../etc', { ODDS_API_KEY: 'k' });
  out.ok = await call('https://x/api/odds?sport=soccer_epl', { ODDS_API_KEY: 'k' });
  out.again = await call('https://x/api/odds?sport=soccer_epl', { ODDS_API_KEY: 'k' });
  out.list = await call('https://x/api/odds?list=1', { ODDS_API_KEY: 'k' });
  out.events = await call('https://x/api/odds?events=soccer_epl', { ODDS_API_KEY: 'k' });
  out.eventsUrl = calls[calls.length - 1];
  out.calls = calls.length;
} else {
  const env = { DB: db, JOURNAL_KEY: 's' };
  const headers = { 'x-journal-key': 's', 'content-type': 'application/json' };
  out.locked = await call('https://x/api/bets', env);
  out.saved = await call('https://x/api/bets', env, { method: 'PUT', headers,
    body: JSON.stringify({ id: 'a', created: '2026-10-11T10:00:00Z', odds: 2.1, stake: 5 }) });
  out.invalid = await call('https://x/api/bets', env, { method: 'PUT', headers, body: JSON.stringify({ id: 'b', odds: 0.5, stake: 5 }) });
  out.listed = await call('https://x/api/bets', env, { headers });
  out.deleted = await call('https://x/api/bets?id=a', env, { method: 'DELETE', headers });
  out.after = await call('https://x/api/bets', env, { headers });
  out.noDb = await call('https://x/api/bets', {});
}
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "Node.js fehlt")
class FunctionsTest(unittest.TestCase):
    """Die Cloudflare-Functions (Live-Quoten, Tagebuch) mit nachgebauter Umgebung."""

    def run_function(self, name, scenario):
        with tempfile.TemporaryDirectory() as tmp:
            # alle Functions in einen Ordner kopieren, den Node sicher als ES-Module liest
            (Path(tmp) / "package.json").write_text('{"type": "module"}')
            for source in list(FUNCTIONS.glob("*.js")) + list(FUNCTIONS.parent.glob("*.js")):
                (Path(tmp) / source.name).write_text(source.read_text())
            module = Path(tmp) / f"{name}.js"
            runner = Path(tmp) / "runner.mjs"
            runner.write_text(FUNCTION_RUNNER)
            result = subprocess.run(["node", str(runner), module.as_uri(), scenario],
                                    capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_live_odds(self):
        out = self.run_function("odds", "odds")
        self.assertEqual(out["noKey"]["status"], 503)
        self.assertEqual(out["locked"]["status"], 401)
        self.assertEqual(out["bad"]["status"], 400)
        events = out["ok"]["body"]["events"]
        self.assertEqual(len(events), 2)                       # Spiel ohne Buchmacher fällt weg
        football, tennis = events
        self.assertEqual(football["source"], "Pinnacle")      # Pinnacle hat Vorrang
        self.assertEqual(football["h2h"], [2.05, 3.6, 3.8])
        self.assertEqual(football["totals"][0]["point"], 2.5)  # ausgeglichenste Linie zuerst
        self.assertEqual(tennis["source"], "Betfair")          # Pinnacle ohne Siegerquote -> Betfair
        self.assertEqual(tennis["h2h"], [1.8, 2.1])
        self.assertEqual(out["ok"]["body"]["remaining"], "480")
        self.assertEqual(football["id"], "a1")                 # die ID verbindet Spielliste und Quoten
        self.assertEqual(out["again"]["body"], out["ok"]["body"])
        self.assertEqual(out["calls"], 3)                      # zweite Abfrage kam aus dem Zwischenspeicher
        self.assertEqual(out["list"]["body"]["sports"][0]["key"], "soccer_epl")
        # Spielliste ohne Quoten (kostet bei The Odds API nichts)
        self.assertIn("/soccer_epl/events?", out["eventsUrl"])
        self.assertEqual(out["events"]["body"]["events"][0],
                         {"id": "a1", "home": "Arsenal", "away": "Chelsea", "kickoff": "2026-10-17T14:00:00Z"})

    def test_sporttip(self):
        out = self.run_function("sporttip", "sporttip")
        self.assertEqual(out["bad"]["status"], 400)
        self.assertEqual(out["tooMany"]["status"], 400)
        self.assertEqual(out["origin"], "https://www.swisslos.ch")
        # Seite, dann Markt-Umschalter (Gruppen 3+4, dann 5), dann Kategorien; zweite Seite ohne Raster
        self.assertEqual(out["sent"], ["connect", "RetrieveSportsbookPage", "UpdateSportsbookPage", "UpdateSportsbookPage",
                                       "RetrieveCategoryChildren", "RetrieveCategoryChildren", "RetrieveSportsbookPage"])
        self.assertEqual(out["switched"], [["Grid1", ["asw:marketconfig:3", "asw:marketconfig:4"]],
                                           ["Grid1", ["asw:marketconfig:5"]]])
        self.assertEqual(out["categories"], ["asw:category:1", "asw:category:2"])
        self.assertIn("text/plain", out["ok"]["type"])
        lines = out["ok"]["body"].split("\n")
        self.assertEqual(json.loads(lines[0])["path"], "/fussball/test/liga")
        self.assertTrue(json.loads(lines[0])["found"])
        self.assertEqual(out["again"]["body"], out["ok"]["body"])
        self.assertEqual(out["connections"], 1)                # zweite Abfrage aus dem Zwischenspeicher
        self.assertEqual(out["refused"]["status"], 502)
        self.assertIn("403", out["refused"]["body"]["error"])
        self.assertEqual(out["closed"]["status"], 502)
        self.assertIn("geschlossen", out["closed"]["body"]["error"])

        # Der Browser setzt daraus die Spiele zusammen (site/js/feed.js)
        parsed = run_node(
            f"import {{ parseFeed, summarize }} from '{(SITE_JS / 'feed.js').as_uri()}';\n"
            f"import {{ footballOdds }} from '{(SITE_JS / 'sporttip.js').as_uri()}';\n"
            "const pages = parseFeed(INPUT);\n"
            "OUTPUT({ pages: pages.map(p => ({ path: p.path, found: p.found, events: p.events })),\n"
            "  links: summarize(pages[0]).links, odds: footballOdds(pages[0].events[0]) });\n",
            out["ok"]["body"])
        first, empty = parsed["pages"]
        self.assertEqual((empty["path"], empty["found"], empty["events"]), ("/fussball/leer", True, []))
        [event] = first["events"]                               # Gamma–Delta: kein vollständiger Markt
        self.assertEqual((event["home"], event["away"], event["sport"]), ("Alpha FC", "Beta United", 1))
        markets = {(m["type"], m["line"]): m["odds"] for m in event["markets"]}
        self.assertEqual(markets[(1, None)], {"1": 1.85, "2": 4.1, "3": 3.6})
        self.assertEqual(markets[(18, 2.5)], {"12": 1.9, "13": 1.8})
        self.assertEqual(markets[(10, None)], {"9": 1.25, "10": 1.3, "11": 1.95})   # über den Markt-Umschalter
        self.assertNotIn((18, 3.5), markets)                   # geschlossener Markt
        self.assertNotIn((18, 1.5), markets)                   # ein Tipp gesperrt -> unvollständig
        self.assertEqual(parsed["links"], [{"path": "/fussball/test/liga2", "name": "Liga 2"}])
        self.assertEqual(parsed["odds"], {"1X2": {"H": 1.85, "D": 4.1, "A": 3.6}, "OU": {"O": 1.9, "U": 1.8},
                                          "DC": {"1X": 1.25, "12": 1.3, "X2": 1.95}})

    def test_login_protects_everything(self):
        out = self.run_function("_middleware", "middleware")
        self.assertEqual(out["noPassword"]["status"], 503)        # ohne Passwort bleibt alles zu
        self.assertEqual((out["home"]["status"], out["home"]["location"]), (303, "/login"))
        self.assertEqual(out["api"]["status"], 401)
        self.assertEqual(out["data"]["status"], 401)               # auch die Daten-Dateien
        self.assertEqual(out["loginPage"]["status"], 200)
        self.assertEqual(out["wrong"]["status"], 401)
        self.assertIsNone(out["wrong"]["cookie"])
        self.assertEqual(out["right"]["status"], 303)
        self.assertIn("HttpOnly", out["right"]["cookie"])
        self.assertEqual((out["authed"]["status"], out["authed"]["text"]), (200, "APP"))
        self.assertEqual(out["authed"]["cache"], "private, no-store")
        self.assertEqual(out["forged"]["status"], 303)             # gefälschtes Cookie
        self.assertEqual(out["otherSecret"]["status"], 303)        # neues SESSION_SECRET meldet alle ab
        self.assertIn("Max-Age=0", out["logout"]["cookie"])

    def test_journal(self):
        out = self.run_function("bets", "bets")
        self.assertEqual(out["locked"]["status"], 401)
        self.assertEqual(out["saved"]["status"], 200)
        self.assertEqual(out["invalid"]["status"], 400)
        self.assertEqual([b["id"] for b in out["listed"]["body"]["bets"]], ["a"])
        self.assertEqual(out["after"]["body"]["bets"], [])
        self.assertEqual(out["noDb"]["status"], 503)


# --- Erfundene Daten -----------------------------------------------------------------
SOURCES = {  # unsere Spalte -> football-data-Spalte
    "ref": "PS", "book": "B365", "max": "Max", "refc": "PSC", "bookc": "B365C", "maxc": "MaxC",
}


def fake_league(seasons, seed, teams=10, with_odds=False):
    """Eine Liga, in der Team 0 am stärksten und Team 9 am schwächsten ist.

    Wie im echten Fussball entstehen Tore aus Schüssen aufs Tor (etwa jeder dritte
    ist drin). Die Schüsse verraten darum mehr über die Stärke als die Tore.
    Quoten: "Pinnacle" kennt die wahren Chancen fast genau (kurz vor Anpfiff noch
    genauer), "Bet365" ist ungenauer und hat mehr Marge, "Max" ist die beste von
    fünf ungenauen Quoten.
    """
    rng = np.random.default_rng(seed)
    strength = np.linspace(0.4, -0.4, teams)
    rows = []
    for season in seasons:
        day = pd.Timestamp(season, 8, 1)
        for round_ in range(2 * (teams - 1)):
            order = rng.permutation(teams)
            for i in range(0, teams, 2):
                h, a = order[i], order[i + 1]
                lam_h = np.exp(0.25 + 0.15 + strength[h] - strength[a])
                lam_a = np.exp(0.25 + strength[a] - strength[h])
                sot_h, sot_a = rng.poisson(lam_h / 0.3), rng.poisson(lam_a / 0.3)
                row = {"league": "E0", "season": season, "date": day + pd.Timedelta(days=7 * round_),
                       "time": "15:00", "home": f"Team {h}", "away": f"Team {a}",
                       "hg": rng.binomial(sot_h, 0.3), "ag": rng.binomial(sot_a, 0.3),
                       "sot_h": sot_h, "sot_a": sot_a,
                       "shots_h": sot_h + rng.poisson(5), "shots_a": sot_a + rng.poisson(4)}
                if with_odds:
                    row["ref_name"] = "Pinnacle"
                    p = model.outcome_probs(lam_h, lam_a)
                    for market, keys, suffixes in [("1X2", "HDA", ["H", "D", "A"]), ("OU", "OU", [">2.5", "<2.5"])]:
                        true = np.array([p[k] for k in keys])

                        def priced(noise, margin):
                            q = true * np.exp(rng.normal(0, noise, len(true)))
                            q = q / q.sum() * (1 + margin)
                            return np.round(1 / q, 2)

                        quotes = {"ref": priced(0.03, 0.03), "refc": priced(0.01, 0.03),
                                  "book": priced(0.06, 0.06), "bookc": priced(0.04, 0.06),
                                  "max": np.max([priced(0.06, 0.05) for _ in range(5)], axis=0),
                                  "maxc": np.max([priced(0.04, 0.05) for _ in range(5)], axis=0)}
                        for source, values in quotes.items():
                            for suffix, value in zip(suffixes, values):
                                row[f"{source}|{suffix}"] = value
                rows.append(row)
    return pd.DataFrame(rows)


def to_csv(df):
    """Unser Format zurück ins football-data-Format (wie die echten Dateien)."""
    names = {"home": "HomeTeam", "away": "AwayTeam", "hg": "FTHG", "ag": "FTAG", "time": "Time",
             "shots_h": "HS", "shots_a": "AS", "sot_h": "HST", "sot_a": "AST"}
    for column in df.columns:
        if "|" in column:
            source, suffix = column.split("|")
            prefix = SOURCES[source]
            if suffix in (">2.5", "<2.5"):
                # Über/Unter heisst bei football-data "P>2.5", "B365>2.5", "PC>2.5", …
                prefix = {"PS": "P", "PSC": "PC"}.get(prefix, prefix)
            names[column] = prefix + suffix
    out = df.rename(columns=names)
    out["Div"] = "E0"
    out["Date"] = df["date"].dt.strftime("%d/%m/%Y")
    out = out[["Div", "Date"] + [c for c in names.values() if c in out.columns]]
    buffer = io.StringIO()
    out.to_csv(buffer, index=False)
    return buffer.getvalue().encode()


if __name__ == "__main__":
    unittest.main()
