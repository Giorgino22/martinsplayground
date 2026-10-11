"""Das Analysemodell: Poisson-Modell mit Angriffs- und Abwehrstärke pro Team.

Idee: Tore sind seltene, zufällige Ereignisse und folgen ziemlich gut einer
Poisson-Verteilung. Wir brauchen also nur die *erwarteten* Tore jedes Teams:

    erwartete Heimtore = exp(basis + heimvorteil + angriff[heim] - abwehr[gast])
    erwartete Gasttore = exp(basis +               angriff[gast] - abwehr[heim])

Die Stärken lernen wir aus alten Resultaten. Neuere Spiele zählen mehr als alte
("decay"): Gewicht = exp(-decay * Tage_her).

Aus den erwarteten Toren rechnen wir dann jede Tor-Kombination (0:0, 1:0, …)
durch und zählen zusammen, wie wahrscheinlich Heimsieg, Remis, Auswärtssieg,
über 2.5 und unter 2.5 Tore sind.
"""
import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import poisson

import config


class TeamModel:
    """Ein fertig gelerntes Modell zu einem bestimmten Zeitpunkt."""

    def __init__(self, teams, attack, defence, home_adv, base, experience):
        self.index = {team: i for i, team in enumerate(teams)}
        self.attack = attack
        self.defence = defence
        self.home_adv = home_adv
        self.base = base
        self.experience = experience  # gewichtete Anzahl Spiele pro Team

    def knows(self, team):
        """Hat das Modell genug Spiele von diesem Team gesehen?"""
        i = self.index.get(team)
        return i is not None and self.experience[i] >= config.MIN_TEAM_MATCHES

    def expected_goals(self, home, away):
        h, a = self.index[home], self.index[away]
        goals_home = np.exp(self.base + self.home_adv + self.attack[h] - self.defence[a])
        goals_away = np.exp(self.base + self.attack[a] - self.defence[h])
        return goals_home, goals_away

    def predict(self, home, away):
        """Wahrscheinlichkeiten für ein Spiel, oder None wenn ein Team zu unbekannt ist."""
        if not (self.knows(home) and self.knows(away)):
            return None
        return outcome_probs(*self.expected_goals(home, away))


def outcome_probs(goals_home, goals_away, max_goals=config.MAX_GOALS):
    """Erwartete Tore -> Wahrscheinlichkeiten für 1/X/2 und über/unter 2.5."""
    goals = np.arange(max_goals + 1)
    # grid[i, j] = Wahrscheinlichkeit, dass es i:j ausgeht
    grid = np.outer(poisson.pmf(goals, goals_home), poisson.pmf(goals, goals_away))
    grid /= grid.sum()  # die paar Prozent für >10 Tore wieder verteilen

    total_goals = goals[:, None] + goals[None, :]
    return {
        "H": float(np.tril(grid, -1).sum()),   # unter der Diagonale: Heim schiesst mehr
        "D": float(np.trace(grid)),            # Diagonale: gleich viele Tore
        "A": float(np.triu(grid, 1).sum()),    # über der Diagonale: Gast schiesst mehr
        "O": float(grid[total_goals >= 3].sum()),
        "U": float(grid[total_goals <= 2].sum()),
    }


def fit(matches, as_of, decay, ridge=config.RIDGE):
    """Lernt die Teamstärken aus allen Spielen VOR `as_of`.

    Wichtig für den Backtest: das Modell darf nie Spiele sehen, die am Tag der
    Prognose noch gar nicht gespielt waren. Sonst wäre der Test geschummelt.
    """
    as_of = pd.Timestamp(as_of)
    start = as_of - pd.Timedelta(days=config.HISTORY_DAYS)
    past = matches[(matches["date"] < as_of) & (matches["date"] >= start)]
    if len(past) < 50:
        return None

    teams = sorted(set(past["home"]) | set(past["away"]))
    index = {team: i for i, team in enumerate(teams)}
    n = len(teams)
    h = past["home"].map(index).to_numpy()
    a = past["away"].map(index).to_numpy()
    goals_h = past["hg"].to_numpy(dtype=float)
    goals_a = past["ag"].to_numpy(dtype=float)
    days_ago = (as_of - past["date"]).dt.days.to_numpy()
    weight = np.exp(-decay * days_ago)

    def loss_and_gradient(params):
        """Wie schlecht passen die Parameter zu den Resultaten? (+ Richtung zum Verbessern)

        Das ist die negative Poisson-Log-Likelihood. scipy sucht die Parameter,
        bei denen sie am kleinsten ist. Den Gradienten (die Ableitung) geben wir
        selbst mit, das macht die Suche viel schneller.
        """
        attack, defence = params[:n], params[n:2 * n]
        home_adv, base = params[2 * n], params[2 * n + 1]
        log_h = base + home_adv + attack[h] - defence[a]
        log_a = base + attack[a] - defence[h]
        exp_h, exp_a = np.exp(log_h), np.exp(log_a)

        loss = (np.sum(weight * (exp_h - goals_h * log_h))
                + np.sum(weight * (exp_a - goals_a * log_a))
                + ridge * (attack @ attack + defence @ defence))

        # Ableitungen: (erwartet - tatsächlich), auf die beteiligten Teams verteilt
        res_h = weight * (exp_h - goals_h)
        res_a = weight * (exp_a - goals_a)
        grad = np.empty_like(params)
        grad[:n] = np.bincount(h, res_h, n) + np.bincount(a, res_a, n) + 2 * ridge * attack
        grad[n:2 * n] = -np.bincount(a, res_h, n) - np.bincount(h, res_a, n) + 2 * ridge * defence
        grad[2 * n] = res_h.sum()
        grad[2 * n + 1] = res_h.sum() + res_a.sum()
        return loss, grad

    start_params = np.zeros(2 * n + 2)
    start_params[2 * n + 1] = np.log(max(0.5, (goals_h.mean() + goals_a.mean()) / 2))
    result = minimize(loss_and_gradient, start_params, jac=True, method="L-BFGS-B")
    p = result.x

    experience = np.bincount(h, weight, n) + np.bincount(a, weight, n)
    return TeamModel(teams, p[:n], p[n:2 * n], p[2 * n], p[2 * n + 1], experience)
