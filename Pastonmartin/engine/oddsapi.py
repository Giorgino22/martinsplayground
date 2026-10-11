"""Frische Pinnacle-Quoten von The Odds API (optional).

Die Fixture-Datei von football-data.co.uk hat schon Pinnacle-Quoten, aber nur
von dem Moment, als sie erstellt wurde. Mit einem API-Schlüssel (gratis bis 500
Abfragen pro Monat) holen wir aktuelle Quoten und auch Spiele, die dort noch fehlen.

Schlüssel holen: https://the-odds-api.com -> als GitHub-Secret ODDS_API_KEY speichern.
"""
import difflib
import json
import unicodedata
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

import pandas as pd

URL = "https://api.the-odds-api.com/v4/sports/{sport}/odds?{query}"
STOP_BELOW = 20  # so viele Abfragen lassen wir immer übrig

# Die Odds API und football-data schreiben manche Teams anders.
# Was hier fehlt, versucht match_team() mit ähnlichen Namen zu finden.
ALIASES = {
    "Manchester United": "Man United", "Manchester City": "Man City",
    "Nottingham Forest": "Nott'm Forest", "Wolverhampton Wanderers": "Wolves",
    "Sheffield Wednesday": "Sheffield Weds", "Queens Park Rangers": "QPR",
    "West Bromwich Albion": "West Brom", "Borussia Monchengladbach": "M'gladbach",
    "Eintracht Frankfurt": "Ein Frankfurt", "Bayer Leverkusen": "Leverkusen",
    "Borussia Dortmund": "Dortmund", "Atlético Madrid": "Ath Madrid",
    "Atletico Madrid": "Ath Madrid", "Athletic Bilbao": "Ath Bilbao",
    "Real Betis": "Betis", "Real Sociedad": "Sociedad", "Rayo Vallecano": "Vallecano",
    "Espanyol": "Espanol", "Celta Vigo": "Celta", "Paris Saint Germain": "Paris SG",
    "Inter Milan": "Inter", "AC Milan": "Milan",
}

# Wörter, die beim Vergleichen nur stören ("FC Basel" = "Basel")
FILLER = {"fc", "afc", "cf", "sc", "sv", "ac", "as", "ss", "us", "fk", "bsc", "vfb", "vfl",
          "tsg", "1", "club", "de", "the", "calcio"}


def simplify(name):
    """'1. FC Köln' -> 'koln'."""
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    words = "".join(c if c.isalnum() else " " for c in plain).split()
    kept = [w for w in words if w not in FILLER]
    return " ".join(kept or words)


def match_team(name, known_teams):
    """Findet den football-data-Namen zu einem Odds-API-Namen, oder None."""
    if name in known_teams:
        return name
    if ALIASES.get(name) in known_teams:
        return ALIASES[name]
    target = simplify(name)
    best, best_score = None, 0.0
    for team in known_teams:
        candidate = simplify(team)
        score = difflib.SequenceMatcher(None, target, candidate).ratio()
        if candidate and (candidate in target or target in candidate):
            score = max(score, 0.9)
        if score > best_score:
            best, best_score = team, score
    return best if best_score >= 0.75 else None


def fetch_pinnacle(sport, api_key):
    """Liste von Spielen mit Pinnacle-Quoten. Gibt (spiele, verbleibende_abfragen) zurück."""
    query = urllib.parse.urlencode({
        "apiKey": api_key, "bookmakers": "pinnacle",
        "markets": "h2h,totals", "oddsFormat": "decimal",
    })
    with urllib.request.urlopen(URL.format(sport=sport, query=query), timeout=30) as response:
        remaining = response.headers.get("x-requests-remaining")
        events = json.load(response)

    games = []
    for event in events:
        pinnacle = next((b for b in event.get("bookmakers", []) if b["key"] == "pinnacle"), None)
        if pinnacle is None:
            continue
        game = {"home": event["home_team"], "away": event["away_team"],
                "kickoff": pd.Timestamp(event["commence_time"])}
        for market in pinnacle["markets"]:
            for outcome in market["outcomes"]:
                if market["key"] == "h2h":
                    key = {event["home_team"]: "ref_h", event["away_team"]: "ref_a"}.get(outcome["name"], "ref_d")
                    game[key] = outcome["price"]
                elif market["key"] == "totals" and outcome.get("point") == 2.5:
                    game["ref_over" if outcome["name"] == "Over" else "ref_under"] = outcome["price"]
        games.append(game)
    return games, int(remaining) if remaining is not None else None


def merge(fixtures, leagues, known_teams, api_key):
    """Ersetzt die Pinnacle-Quoten in `fixtures` durch frische und ergänzt fehlende Spiele."""
    fixtures = fixtures.copy()
    fixtures["ref_source"] = "football-data"
    new_rows = []
    for code, cfg in leagues.items():
        try:
            games, remaining = fetch_pinnacle(cfg["odds_api"], api_key)
        except OSError as error:
            print(f"  ! Odds API {code}: {error}")
            continue
        unmatched = []
        for game in games:
            home = match_team(game["home"], known_teams.get(code, set()))
            away = match_team(game["away"], known_teams.get(code, set()))
            if not home or not away:
                unmatched.append(f"{game['home']} - {game['away']}")
                continue
            # football-data rechnet mit dem englischen Datum
            day = game["kickoff"].tz_convert(ZoneInfo("Europe/London")).normalize().tz_localize(None)
            same = ((fixtures["league"] == code) & (fixtures["home"] == home)
                    & (fixtures["away"] == away) & ((fixtures["date"] - day).abs() <= pd.Timedelta(days=1)))
            odds = {k: v for k, v in game.items() if k.startswith("ref_")}
            if same.any():
                for key, value in odds.items():
                    fixtures.loc[same, key] = value
                fixtures.loc[same, "ref_source"] = "odds-api"
                fixtures.loc[same, "ref_name"] = "Pinnacle"
                fixtures.loc[same, "kickoff"] = game["kickoff"].isoformat()
            else:
                new_rows.append({"league": code, "date": day, "home": home, "away": away,
                                 "kickoff": game["kickoff"].isoformat(), "ref_source": "odds-api",
                                 "ref_name": "Pinnacle", **odds})
        print(f"  Odds API {code}: {len(games)} Spiele, {len(unmatched)} nicht zugeordnet"
              f"{' (' + '; '.join(unmatched[:5]) + ')' if unmatched else ''}, noch {remaining} Abfragen")
        if remaining is not None and remaining < STOP_BELOW:
            print("  ! Fast keine Abfragen mehr übrig, höre auf.")
            break
    if new_rows:
        fixtures = pd.concat([fixtures, pd.DataFrame(new_rows)], ignore_index=True)
    return fixtures
