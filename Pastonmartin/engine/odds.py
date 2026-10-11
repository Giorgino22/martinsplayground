"""Rechnen mit Quoten.

Alle Funktionen funktionieren mit einzelnen Zahlen UND mit ganzen numpy-Spalten,
weil numpy Rechnungen wie `1 / quoten` automatisch auf jedes Element anwendet.
"""
import numpy as np


def fair_probs(*odds):
    """Quoten eines Marktes -> faire Wahrscheinlichkeiten (Marge herausgerechnet).

    Beispiel: fair_probs(2.00, 3.60, 3.90)
      1/Quote:  0.500 + 0.278 + 0.256 = 1.034  (3.4 % Marge)
      geteilt:  0.484,  0.269,  0.248           (zusammen genau 1)
    """
    implied = [1.0 / np.asarray(o, dtype=float) for o in odds]
    total = sum(implied)
    return tuple(p / total for p in implied)


def margin(*odds):
    """Marge des Buchmachers: 0.05 = 5 %."""
    return sum(1.0 / np.asarray(o, dtype=float) for o in odds) - 1.0


def edge(prob, odds):
    """Erwarteter Gewinn pro Franken: 0.06 = +6 %."""
    return prob * odds - 1.0


def min_odds(prob, edge_needed):
    """Kleinste Quote, ab der eine Wette mindestens `edge_needed` Value hat."""
    return (1.0 + edge_needed) / prob


def kelly_stake(prob, odds, fraction, cap):
    """Anteil vom Budget, der gesetzt werden soll (Bruchteil-Kelly mit Obergrenze).

    Volles Kelly = Value / (Quote - 1). Das ist mathematisch optimal, schwankt aber
    brutal. Darum nehmen wir nur einen Bruchteil davon und nie mehr als `cap`.
    """
    full = (prob * odds - 1.0) / (odds - 1.0)
    return float(np.clip(full * fraction, 0.0, cap))


def log_loss(probs, outcome_index):
    """Wie gut waren Wahrscheinlichkeiten? Tiefer = besser.

    probs: Array (Spiele x Ausgänge), outcome_index: welcher Ausgang eingetreten ist.
    Bestraft wird, wenn das tatsächliche Resultat als unwahrscheinlich galt.
    """
    rows = np.arange(len(outcome_index))
    picked = np.clip(probs[rows, outcome_index], 1e-12, 1.0)
    return float(-np.log(picked).mean())
