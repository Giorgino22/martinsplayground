"""Tests. Starten mit:  python -m unittest   (im Ordner engine/)

Die meisten Tests brauchen kein Internet. Der letzte erfindet eine ganze Liga
mit bekannten Teamstärken und lässt Backtest + Tipps darauf laufen.
"""
import io
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

import backtest
import config
import data
import model
import oddsapi
import odds
import tips


class OddsTest(unittest.TestCase):
    def test_fair_probs_remove_margin(self):
        h, d, a = odds.fair_probs(2.00, 3.60, 3.90)
        self.assertAlmostEqual(h + d + a, 1.0)
        self.assertAlmostEqual(h, 0.4836, places=3)

    def test_edge_and_min_odds(self):
        self.assertAlmostEqual(odds.edge(0.5, 2.2), 0.1)
        self.assertAlmostEqual(odds.min_odds(0.5, 0.05), 2.1)

    def test_kelly_is_capped(self):
        self.assertEqual(odds.kelly_stake(0.4, 2.0, 0.25, 0.02), 0.0)   # kein Value -> 0
        self.assertEqual(odds.kelly_stake(0.9, 2.0, 1.0, 0.02), 0.02)   # riesiger Value -> Deckel


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
        fitted = model.fit(matches, matches["date"].max() + pd.Timedelta(days=1), decay=0.003)
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
        new = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,PSH,PSD,PSA,AvgH,AvgD,AvgA\nE0,13/08/2022,15:00,A,B,0,0,2.0,3.5,4.0,1.9,3.4,3.9\n"
        for text, year in [(old, 2016), (new, 2022)]:
            df = data.normalize(data.read_csv(text.encode()), "E0")
            self.assertEqual(df["date"].iloc[0], pd.Timestamp(year, 8, 13))
            self.assertEqual(df["season"].iloc[0], year)
            self.assertEqual(df["avg_h"].iloc[0], 1.9)
            self.assertEqual(df["pin_a"].iloc[0], 4.0)

    def test_extra_league_uses_closing_odds(self):
        text = "Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PSCH,PSCD,PSCA,AvgCH,AvgCD,AvgCA\nSwitzerland,Super League,2023/2024,22/07/2023,18:00,Basel,Zurich,1,1,D,2.1,3.4,3.3,2.0,3.3,3.2\n"
        df = data.normalize(data.read_csv(text.encode()), "SWZ")
        self.assertEqual(df["home"].iloc[0], "Basel")
        self.assertEqual(df["pin_h"].iloc[0], 2.1)
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
        df = pd.DataFrame({
            "date": pd.to_datetime(["2023-01-01", "2023-01-02"]), "league": "E0", "season": 2022,
            "hg": [2, 0], "ag": [0, 0],
            "pin_h": [2.0, 2.0], "pin_d": [3.6, 3.6], "pin_a": [3.9, 3.9],
            "book_h": [2.3, 1.9], "book_d": [3.4, 3.4], "book_a": [3.7, 3.7],
            "pinc_h": 2.0, "pinc_d": 3.6, "pinc_a": 3.9,
            "pin_over": np.nan, "pin_under": np.nan, "book_over": np.nan, "book_under": np.nan,
            "pinc_over": np.nan, "pinc_under": np.nan,
            "m_H": np.nan, "m_D": np.nan, "m_A": np.nan, "m_O": np.nan, "m_U": np.nan,
        })
        df = backtest.add_market_probs(df)
        bets = backtest.simulate(df, "1X2", w=0.0, edge_min=0.05, haircut=0.0)
        # Spiel 1: 0.484 * 2.3 = 1.11 -> Value. Spiel 2: 1.9 ist zu tief -> keine Wette.
        self.assertEqual(len(bets), 1)
        self.assertEqual(bets["selection"].iloc[0], "H")
        self.assertAlmostEqual(bets["profit"].iloc[0], 1.3)
        self.assertTrue(bets["won"].iloc[0])


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
            MIN_BETS_FOR_TUNING=20, OUT_DIR=Path(tmp),
        ), mock.patch.object(data, "fetch", fake_fetch):
            result = backtest.run()
            self.assertIn(result["params"]["decay"], config.DECAY_GRID)
            self.assertEqual(len(result["strategies"]), 3)
            # Unser erfundener "Buchmacher" ist schlechter als Pinnacle -> der Value-Finder findet Wetten
            value = next(s for s in result["strategies"] if s["key"] == "value")
            self.assertGreater(value["results"]["book"]["test"]["1X2"]["bets"], 0)
            json.loads((Path(tmp) / "backtest.json").read_text())   # gültiges JSON

            upcoming = league.tail(3).copy()
            upcoming["date"] = pd.Timestamp(date.today() + timedelta(days=2))
            upcoming["time"] = "15:00"
            with mock.patch.object(data, "load_fixtures", lambda: upcoming), \
                 mock.patch.object(tips.config, "OUT_DIR", Path(tmp)):
                tips.run()
            out = json.loads((Path(tmp) / "tips.json").read_text())
            self.assertEqual(len(out["matches"]), 3)
            first = out["matches"][0]["markets"]["1X2"]["selections"]
            self.assertAlmostEqual(sum(s["p"] for s in first), 1.0, places=4)


# --- Erfundene Daten -----------------------------------------------------------------
def fake_league(seasons, seed, teams=10, with_odds=False):
    """Eine Liga, in der Team 0 am stärksten und Team 9 am schwächsten ist."""
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
                row = {"league": "E0", "season": season, "date": day + pd.Timedelta(days=7 * round_),
                       "time": "15:00", "home": f"Team {h}", "away": f"Team {a}",
                       "hg": rng.poisson(lam_h), "ag": rng.poisson(lam_a)}
                if with_odds:
                    p = model.outcome_probs(lam_h, lam_a)
                    noise = rng.normal(0, 0.06, 5)
                    for k, (pin_col, book_col, close_col) in {
                        "H": ("pin_h", "book_h", "pinc_h"), "D": ("pin_d", "book_d", "pinc_d"),
                        "A": ("pin_a", "book_a", "pinc_a"), "O": ("pin_over", "book_over", "pinc_over"),
                        "U": ("pin_under", "book_under", "pinc_under"),
                    }.items():
                        row[pin_col] = row[close_col] = round(1 / (p[k] * 1.03), 2)
                        row[book_col] = round(1 / (p[k] * 1.06) * np.exp(noise["HDAOU".index(k)]), 2)
                rows.append(row)
    return pd.DataFrame(rows)


def to_csv(df):
    """Unser Format zurück ins football-data-Format (wie die echten Dateien)."""
    names = {"home": "HomeTeam", "away": "AwayTeam", "hg": "FTHG", "ag": "FTAG", "time": "Time",
             "pin_h": "PSH", "pin_d": "PSD", "pin_a": "PSA", "pin_over": "P>2.5", "pin_under": "P<2.5",
             "book_h": "B365H", "book_d": "B365D", "book_a": "B365A",
             "book_over": "B365>2.5", "book_under": "B365<2.5",
             "pinc_h": "PSCH", "pinc_d": "PSCD", "pinc_a": "PSCA",
             "pinc_over": "PC>2.5", "pinc_under": "PC<2.5"}
    out = df.rename(columns=names)
    out["Div"] = "E0"
    out["Date"] = df["date"].dt.strftime("%d/%m/%Y")
    out = out[["Div", "Date"] + list(names.values())]
    buffer = io.StringIO()
    out.to_csv(buffer, index=False)
    return buffer.getvalue().encode()


if __name__ == "__main__":
    unittest.main()
