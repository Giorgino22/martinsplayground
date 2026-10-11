"""Rechnen mit Quoten.

Die Funktionen arbeiten mit ganzen Tabellen auf einmal (numpy): eine Zeile pro
Spiel, eine Spalte pro Ausgang. So geht der Backtest über 40'000 Spiele schnell.
"""
import numpy as np

DEVIG_METHODS = ["proportional", "power", "shin"]


def devig(odds, method="proportional"):
    """Quoten -> faire Wahrscheinlichkeiten (die Marge des Buchmachers herausgerechnet).

    odds: Tabelle (Spiele x Ausgänge), z.B. [[2.00, 3.60, 3.90], ...]. Fehlt eine
    Quote (NaN) oder ist sie ungültig (<= 1), wird die ganze Zeile NaN.

    Drei Methoden, wie die Marge verteilt sein könnte:
      proportional  jeder Ausgang trägt gleich viel Marge (einfach, aber Aussenseiter
                    wirken dadurch zu wahrscheinlich)
      power         p = (1/Quote)^k, k so gewählt, dass alles zusammen 1 ergibt.
                    Aussenseiter tragen mehr Marge.
      shin          Modell von Shin (1993): Der Buchmacher schützt sich gegen Insider,
                    die vor allem auf Aussenseiter setzen. Ähnliche Wirkung wie power.
    """
    odds = np.atleast_2d(np.asarray(odds, dtype=float))
    implied = 1.0 / np.where(odds > 1, odds, np.nan)
    implied[np.isnan(implied).any(axis=1)] = np.nan
    total = implied.sum(axis=1, keepdims=True)
    proportional = implied / total
    if method == "proportional":
        return proportional

    if method == "power":
        # Gesucht: k mit Summe(implied^k) = 1. Die Summe wird mit grösserem k kleiner,
        # also halbieren wir das Suchintervall 60-mal (Bisektion).
        low, high = np.full_like(total, 0.2), np.full_like(total, 5.0)
        for _ in range(60):
            k = (low + high) / 2
            too_big = (implied ** k).sum(axis=1, keepdims=True) > 1
            low, high = np.where(too_big, k, low), np.where(too_big, high, k)
        result = implied ** ((low + high) / 2)

    elif method == "shin":
        # Gesucht: z (Anteil Insider) mit Summe(p) = 1, wobei
        # p_i = (Wurzel(z² + 4(1-z) · implied_i² / Summe) - z) / (2(1-z))
        def shin_probs(z):
            return (np.sqrt(z ** 2 + 4 * (1 - z) * implied ** 2 / total) - z) / (2 * (1 - z))

        low, high = np.zeros_like(total), np.full_like(total, 0.5)
        for _ in range(60):
            z = (low + high) / 2
            too_big = shin_probs(z).sum(axis=1, keepdims=True) > 1
            low, high = np.where(too_big, z, low), np.where(too_big, high, z)
        # Shin gilt nur mit Marge (Summe > 1). Ohne Marge: proportional.
        result = np.where(total > 1, shin_probs((low + high) / 2), proportional)
    else:
        raise ValueError(f"Unbekannte Methode: {method}")

    return result / result.sum(axis=1, keepdims=True)


def fair_probs(*odds, method="proportional"):
    """Für ein einzelnes Spiel: fair_probs(2.0, 3.6, 3.9) -> (0.484, 0.269, 0.248)."""
    row = devig([[float(o) for o in odds]], method)[0]
    return tuple(float(p) for p in row)


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


def cross_entropy(probs, target_probs):
    """Wie log_loss, aber gegen Wahrscheinlichkeiten statt Resultate (z.B. die Schlussquote)."""
    return float(-(target_probs * np.log(np.clip(probs, 1e-12, 1.0))).sum(axis=1).mean())
