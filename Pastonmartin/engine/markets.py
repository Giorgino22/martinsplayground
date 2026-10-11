"""Wettarten aus erwarteten Toren, und erwartete Tore aus Marktquoten.

Vorwärts:  erwartete Tore (z.B. 1.6 : 1.1) -> Wahrscheinlichkeit jedes Resultats (0:0, 1:0, …)
           -> 1X2, Doppelte Chance, Über/Unter 1.5/2.5/3.5, Beide treffen.
Rückwärts: Marktwahrscheinlichkeiten für 1X2 und Über/Unter 2.5 -> die erwarteten Tore,
           die genau dazu passen ("implied goals"). Damit lassen sich faire Quoten für
           Märkte berechnen, für die wir keine scharfe Referenzquote haben (z.B. Beide treffen).

Alles ist "vektorisiert": goals_home kann eine Zahl oder ein ganzes Array sein.
"""
import numpy as np
from scipy.special import gammaln

import config

GOALS = np.arange(config.MAX_GOALS + 1)
LOG_FACTORIAL = gammaln(GOALS + 1)
TOTAL = GOALS[:, None] + GOALS[None, :]          # Gesamttore für jedes Resultat
HOME_WINS = GOALS[:, None] > GOALS[None, :]
DRAWS = GOALS[:, None] == GOALS[None, :]
AWAY_WINS = GOALS[:, None] < GOALS[None, :]
BOTH_SCORE = (GOALS[:, None] > 0) & (GOALS[None, :] > 0)

# Alle Wettarten, die wir berechnen. Schlüssel -> (Kurzname, Name)
MARKETS = {
    "1X2":  {"name": "Sieger", "selections": {"H": ("1", "Heimsieg"), "D": ("X", "Unentschieden"),
                                               "A": ("2", "Auswärtssieg")}},
    "DC":   {"name": "Doppelte Chance", "selections": {"1X": ("1X", "Heim oder Remis"),
                                                        "12": ("12", "Kein Remis"),
                                                        "X2": ("X2", "Remis oder Gast")}},
    "OU15": {"name": "Tore 1.5", "selections": {"O15": ("Ü1.5", "Über 1.5 Tore"),
                                                 "U15": ("U1.5", "Unter 1.5 Tore")}},
    "OU":   {"name": "Tore 2.5", "selections": {"O": ("Ü2.5", "Über 2.5 Tore"),
                                                 "U": ("U2.5", "Unter 2.5 Tore")}},
    "OU35": {"name": "Tore 3.5", "selections": {"O35": ("Ü3.5", "Über 3.5 Tore"),
                                                 "U35": ("U3.5", "Unter 3.5 Tore")}},
    "BTTS": {"name": "Beide treffen", "selections": {"BY": ("Ja", "Beide Teams treffen"),
                                                      "BN": ("Nein", "Nicht beide treffen")}},
}


def poisson_pmf(rate):
    """P(0 Tore), P(1 Tor), … für jede Rate. Form: (Spiele, MAX_GOALS + 1)."""
    rate = np.asarray(rate, dtype=float)[..., None]
    return np.exp(-rate + GOALS * np.log(rate) - LOG_FACTORIAL)


def score_grid(goals_home, goals_away, rho=0.0):
    """Wahrscheinlichkeit jedes Resultats. Form: (Spiele, 11, 11), [:, i, j] = P(i:j).

    rho ist die Dixon-Coles-Korrektur: Tore der beiden Teams sind nicht ganz
    unabhängig, 0:0 und 1:1 kommen etwas häufiger vor als die reine Poisson-Rechnung
    sagt. Ein negatives rho macht genau diese Resultate wahrscheinlicher.
    """
    home = np.atleast_1d(np.asarray(goals_home, dtype=float))
    away = np.atleast_1d(np.asarray(goals_away, dtype=float))
    grid = poisson_pmf(home)[:, :, None] * poisson_pmf(away)[:, None, :]
    if rho:
        grid[:, 0, 0] *= 1 - home * away * rho
        grid[:, 0, 1] *= 1 + home * rho
        grid[:, 1, 0] *= 1 + away * rho
        grid[:, 1, 1] *= 1 - rho
        grid = np.clip(grid, 0, None)
    return grid / grid.sum(axis=(1, 2), keepdims=True)


def selection_probs(grid):
    """Wahrscheinlichkeit jeder Wette aus der Resultat-Tabelle. Gibt {Schlüssel: Array} zurück."""
    def total(mask):
        return (grid * mask).sum(axis=(1, 2))

    home, draw, away = total(HOME_WINS), total(DRAWS), total(AWAY_WINS)
    over15, over25, over35 = total(TOTAL >= 2), total(TOTAL >= 3), total(TOTAL >= 4)
    both = total(BOTH_SCORE)
    return {
        "H": home, "D": draw, "A": away,
        "1X": home + draw, "12": home + away, "X2": draw + away,
        "O15": over15, "U15": 1 - over15,
        "O": over25, "U": 1 - over25,
        "O35": over35, "U35": 1 - over35,
        "BY": both, "BN": 1 - both,
    }


def from_goals(goals_home, goals_away, rho=0.0):
    """Erwartete Tore -> Wahrscheinlichkeiten aller Wetten."""
    return selection_probs(score_grid(goals_home, goals_away, rho))


def implied_goals(p_home, p_draw, p_away, p_over=None, rho=0.0, iterations=40):
    """Welche erwarteten Tore passen zu diesen Marktwahrscheinlichkeiten?

    Gesucht sind zwei Zahlen (Heimtore, Gasttore), die 1X2 und (falls bekannt)
    Über 2.5 möglichst genau treffen. Das ist ein kleines Ausgleichsproblem; wir
    lösen es mit dem Gauss-Newton-Verfahren: Fehler messen, ausrechnen in welche
    Richtung er kleiner wird, einen Schritt machen, wiederholen.
    Gibt (Heimtore, Gasttore) als Arrays zurück.
    """
    targets = [np.atleast_1d(np.asarray(p, dtype=float)) for p in (p_home, p_draw, p_away)]
    if p_over is not None:
        targets.append(np.atleast_1d(np.asarray(p_over, dtype=float)))
    target = np.column_stack(targets)                   # (Spiele, 3 oder 4)
    known = ~np.isnan(target)                           # fehlendes Über/Unter einfach ignorieren
    target = np.nan_to_num(target)
    keys = ["H", "D", "A", "O"][:target.shape[1]]

    def model(x):
        probs = from_goals(np.exp(x[:, 0]), np.exp(x[:, 1]), rho)
        return np.column_stack([probs[k] for k in keys])

    x = np.tile(np.log([1.45, 1.15]), (len(target), 1))  # Start: typisches Fussballspiel
    step_size = 1e-4
    for _ in range(iterations):
        current = model(x)
        error = np.where(known, current - target, 0.0)
        jacobian = np.empty(error.shape + (2,))
        for j in range(2):
            shifted = x.copy()
            shifted[:, j] += step_size
            jacobian[:, :, j] = np.where(known, (model(shifted) - current) / step_size, 0.0)
        # Normalgleichungen (2x2) für jeden Match lösen, mit etwas Dämpfung
        jtj = np.einsum("nmi,nmj->nij", jacobian, jacobian) + 1e-6 * np.eye(2)
        jte = np.einsum("nmi,nm->ni", jacobian, error)
        step = -np.linalg.solve(jtj, jte[..., None])[..., 0]
        x = np.clip(x + np.clip(step, -0.5, 0.5), np.log(0.05), np.log(6.0))
    goals = np.exp(x)
    invalid = np.isnan(np.column_stack(targets)[:, :3]).any(axis=1)
    goals[invalid] = np.nan
    return goals[:, 0], goals[:, 1]
