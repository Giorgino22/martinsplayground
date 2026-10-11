"""Startpunkt.

    python run.py tips        Tipps + Resultate aktualisieren (schnell, läuft täglich)
    python run.py backtest    Backtest + Einstellungen neu wählen (dauert einige Minuten)
    python run.py all         beides
"""
import os
import sys

# numpy soll pro Prozess nur einen Kern nutzen. Parallel rechnen wir selbst mit mehreren
# Prozessen (siehe backtest.py); sonst bremsen sich die Prozesse gegenseitig aus.
# Muss VOR "import numpy" stehen, darum ganz oben.
for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(variable, "1")

import backtest  # noqa: E402
import tips  # noqa: E402

if __name__ == "__main__":
    task = sys.argv[1] if len(sys.argv) > 1 else "all"
    if task not in ("tips", "backtest", "all"):
        sys.exit(__doc__)
    if task in ("backtest", "all"):
        backtest.run()
    if task in ("tips", "all"):
        tips.run()
