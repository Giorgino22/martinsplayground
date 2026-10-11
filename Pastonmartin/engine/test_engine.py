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
    { home_team: 'Arsenal', away_team: 'Chelsea', commence_time: '2026-10-17T14:00:00Z', bookmakers: [
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
  const body = url.includes('/odds?') ? events : [{ key: 'soccer_epl', group: 'Soccer', title: 'EPL', active: true, has_outrights: false }];
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
const handler = onRequestGet || onRequest;
const call = async (url, env, init = {}) => {
  const response = await handler({ request: new Request(url, init), env, waitUntil: p => p });
  return { status: response.status, body: await response.json() };
};
const out = {};
if (scenario === 'odds') {
  out.noKey = await call('https://x/api/odds?sport=soccer_epl', {});
  out.locked = await call('https://x/api/odds?sport=soccer_epl', { ODDS_API_KEY: 'k', JOURNAL_KEY: 's' });
  out.bad = await call('https://x/api/odds?sport=../etc', { ODDS_API_KEY: 'k' });
  out.ok = await call('https://x/api/odds?sport=soccer_epl', { ODDS_API_KEY: 'k' });
  out.again = await call('https://x/api/odds?sport=soccer_epl', { ODDS_API_KEY: 'k' });
  out.list = await call('https://x/api/odds?list=1', { ODDS_API_KEY: 'k' });
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
            # als .mjs kopieren, damit Node sie sicher als ES-Modul liest
            module = Path(tmp) / f"{name}.mjs"
            module.write_text((FUNCTIONS / f"{name}.js").read_text())
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
        self.assertEqual(out["again"]["body"], out["ok"]["body"])
        self.assertEqual(out["calls"], 2)                      # zweite Abfrage kam aus dem Zwischenspeicher
        self.assertEqual(out["list"]["body"]["sports"][0]["key"], "soccer_epl")

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
