"""Das eigene Analysemodell: Poisson-Modell mit Angriffs- und Abwehrstärke pro Team.

Idee: Tore sind seltene, zufällige Ereignisse und folgen ziemlich gut einer
Poisson-Verteilung. Wir brauchen also nur die *erwarteten* Tore jedes Teams:

    erwartete Heimtore = exp(basis + heimvorteil + angriff[heim] - abwehr[gast])
    erwartete Gasttore = exp(basis +               angriff[gast] - abwehr[heim])

Die Stärken lernen wir aus alten Spielen. Neuere Spiele zählen mehr als alte
("decay"): Gewicht = exp(-decay * Tage_her).

Tore sind aber sehr zufällig. Schüsse aufs Tor zeigen besser, wie gefährlich ein
Team wirklich war. Mit shots_weight > 0 lernt das Modell darum aus einer Mischung:

    Ziel = (1 - shots_weight) * Tore + shots_weight * Schüsse_aufs_Tor * Trefferquote

(Trefferquote = wie viele Schüsse aufs Tor in dieser Liga im Schnitt ein Tor werden.)
"""
import numpy as np
import pandas as pd
from scipy.optimize import minimize

import config
import markets


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
        """(Heimtore, Gasttore) oder None, wenn ein Team zu unbekannt ist."""
        if not (self.knows(home) and self.knows(away)):
            return None
        h, a = self.index[home], self.index[away]
        goals_home = np.exp(self.base + self.home_adv + self.attack[h] - self.defence[a])
        goals_away = np.exp(self.base + self.attack[a] - self.defence[h])
        return float(goals_home), float(goals_away)

    def predict(self, home, away, rho=0.0):
        """Wahrscheinlichkeiten aller Wetten für ein Spiel, oder None."""
        goals = self.expected_goals(home, away)
        if goals is None:
            return None
        return {key: float(p[0]) for key, p in markets.from_goals(*goals, rho).items()}


def outcome_probs(goals_home, goals_away, rho=0.0):
    """Erwartete Tore -> Wahrscheinlichkeiten (für ein einzelnes Spiel)."""
    return {key: float(p[0]) for key, p in markets.from_goals(goals_home, goals_away, rho).items()}


def fit(matches, as_of, decay, shots_weight=0.0, ridge=config.RIDGE):
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
    target_h = past["hg"].to_numpy(dtype=float)
    target_a = past["ag"].to_numpy(dtype=float)
    days_ago = (as_of - past["date"]).dt.days.to_numpy()
    weight = np.exp(-decay * days_ago)

    if shots_weight > 0 and "sot_h" in past:
        target_h, target_a = _mix_in_shots(past, target_h, target_a, shots_weight)

    def loss_and_gradient(params):
        """Wie schlecht passen die Parameter zu den Spielen? (+ Richtung zum Verbessern)

        Das ist die negative Poisson-Log-Likelihood. scipy sucht die Parameter,
        bei denen sie am kleinsten ist. Den Gradienten (die Ableitung) geben wir
        selbst mit, das macht die Suche viel schneller.
        """
        attack, defence = params[:n], params[n:2 * n]
        home_adv, base = params[2 * n], params[2 * n + 1]
        log_h = base + home_adv + attack[h] - defence[a]
        log_a = base + attack[a] - defence[h]
        exp_h, exp_a = np.exp(log_h), np.exp(log_a)

        loss = (np.sum(weight * (exp_h - target_h * log_h))
                + np.sum(weight * (exp_a - target_a * log_a))
                + ridge * (attack @ attack + defence @ defence))

        # Ableitungen: (erwartet - tatsächlich), auf die beteiligten Teams verteilt
        res_h = weight * (exp_h - target_h)
        res_a = weight * (exp_a - target_a)
        grad = np.empty_like(params)
        grad[:n] = np.bincount(h, res_h, n) + np.bincount(a, res_a, n) + 2 * ridge * attack
        grad[n:2 * n] = -np.bincount(a, res_h, n) - np.bincount(h, res_a, n) + 2 * ridge * defence
        grad[2 * n] = res_h.sum()
        grad[2 * n + 1] = res_h.sum() + res_a.sum()
        return loss, grad

    start_params = np.zeros(2 * n + 2)
    start_params[2 * n + 1] = np.log(max(0.5, (target_h.mean() + target_a.mean()) / 2))
    result = minimize(loss_and_gradient, start_params, jac=True, method="L-BFGS-B")
    p = result.x

    experience = np.bincount(h, weight, n) + np.bincount(a, weight, n)
    return TeamModel(teams, p[:n], p[n:2 * n], p[2 * n], p[2 * n + 1], experience)


def _mix_in_shots(past, goals_h, goals_a, shots_weight):
    """Ziel = Mischung aus Toren und (Schüsse aufs Tor × Trefferquote der Liga)."""
    sot_h = past["sot_h"].to_numpy(dtype=float)
    sot_a = past["sot_a"].to_numpy(dtype=float)
    have = ~np.isnan(sot_h) & ~np.isnan(sot_a)
    if have.sum() < 50:
        return goals_h, goals_a
    conversion = (goals_h[have].sum() + goals_a[have].sum()) / max(1.0, sot_h[have].sum() + sot_a[have].sum())
    mixed_h = np.where(have, (1 - shots_weight) * goals_h + shots_weight * conversion * np.nan_to_num(sot_h), goals_h)
    mixed_a = np.where(have, (1 - shots_weight) * goals_a + shots_weight * conversion * np.nan_to_num(sot_a), goals_a)
    return mixed_h, mixed_a
