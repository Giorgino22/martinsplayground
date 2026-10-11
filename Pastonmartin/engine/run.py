"""Startpunkt.

    python run.py tips        Tipps + Resultate aktualisieren (schnell, läuft täglich)
    python run.py backtest    Backtest + Einstellungen neu wählen (dauert einige Minuten)
    python run.py all         beides
"""
import sys

import backtest
import tips

if __name__ == "__main__":
    task = sys.argv[1] if len(sys.argv) > 1 else "all"
    if task not in ("tips", "backtest", "all"):
        sys.exit(__doc__)
    if task in ("backtest", "all"):
        backtest.run()
    if task in ("tips", "all"):
        tips.run()
