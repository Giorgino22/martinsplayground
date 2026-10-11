"""Kombination: Markt und eigenes Modell zu EINER Wahrscheinlichkeit verbinden.

Version 1 mischte linear: p = w · Modell + (1 - w) · Markt.
Version 2 mischt logarithmisch ("logarithmischer Pool"), so machen es auch Profis:

    Punkte_k = Bonus_k + g_markt · log(p_markt_k) + g_modell · log(p_modell_k)
    p_k      = exp(Punkte_k) / Summe aller exp(Punkte)        ("Softmax")

Vorteile:
  * Sind sich Markt und Modell einig, wird die Wahrscheinlichkeit sicherer.
  * g_markt > 1 heisst: der Markt ist sogar noch etwas zu vorsichtig.
  * Bonus_k korrigiert systematische Fehler, z.B. wenn Remis immer etwas zu
    selten erwartet werden.

Die Gewichte (Bonus, g_markt, g_modell) werden im Anpassungs-Zeitraum gelernt,
entweder an den Resultaten oder an der Schlussquote (die ist viel weniger zufällig
als ein einzelnes Resultat, aber trotzdem fast perfekt kalibriert).
"""
import numpy as np
from scipy.optimize import minimize


def apply(params, p_market, p_model=None):
    """Kombinierte Wahrscheinlichkeiten. p_market, p_model: Arrays (Spiele x Ausgänge)."""
    p_market = np.atleast_2d(p_market)
    points = np.asarray(params["bias"]) + params["w_market"] * np.log(np.clip(p_market, 1e-9, 1))
    if p_model is not None and params.get("w_model", 0):
        points = points + params["w_model"] * np.log(np.clip(np.atleast_2d(p_model), 1e-9, 1))
    points -= points.max(axis=1, keepdims=True)          # gegen Überlauf bei exp()
    weights = np.exp(points)
    return weights / weights.sum(axis=1, keepdims=True)


def identity(n_outcomes):
    """Parameter, die den Markt unverändert lassen."""
    return {"bias": [0.0] * n_outcomes, "w_market": 1.0, "w_model": 0.0}


def fit(p_market, target, p_model=None):
    """Lernt die Gewichte. target: Resultat-Index pro Spiel ODER Wahrscheinlichkeiten (Schlussquote).

    Gibt die Parameter zurück, mit denen die kombinierten Wahrscheinlichkeiten
    am besten zu target passen (kleinster Log-Loss).
    """
    p_market = np.atleast_2d(p_market)
    n, k = p_market.shape
    if np.ndim(target) == 1:                               # Resultate -> "eins aus k"
        target = np.eye(k)[np.asarray(target, dtype=int)]
    use_model = p_model is not None

    def unpack(x):
        params = {"bias": [0.0] + list(x[:k - 1]), "w_market": float(x[k - 1]),
                  "w_model": float(x[k]) if use_model else 0.0}
        return params

    def loss(x):
        probs = apply(unpack(x), p_market, p_model)
        return -(target * np.log(np.clip(probs, 1e-12, 1))).sum(axis=1).mean()

    start = np.zeros(k + (1 if use_model else 0))
    start[k - 1] = 1.0
    result = minimize(loss, start, method="L-BFGS-B")
    return {key: (np.round(value, 5).tolist() if key == "bias" else round(value, 5))
            for key, value in unpack(result.x).items()}


def model_share(params):
    """Wie viel Gewicht hat das Modell im Vergleich zum Markt (0 = nichts, 0.5 = gleich viel)?"""
    total = abs(params["w_market"]) + abs(params.get("w_model", 0))
    return abs(params.get("w_model", 0)) / total if total else 0.0
