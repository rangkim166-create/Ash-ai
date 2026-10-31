#!/usr/bin/env python3
"""Chronological Elo baseline for football, tennis and basketball results."""
import argparse
import csv
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "history" / "raw"
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"
START, K = 1500.0, 24.0


def expected(a, b):
    return 1.0 / (1.0 + 10.0 ** ((b - a) / 400.0))


def update(ratings, a, b, score_a):
    ra, rb = ratings.get(a, START), ratings.get(b, START)
    ea = expected(ra, rb)
    ratings[a] = ra + K * (score_a - ea)
    ratings[b] = rb + K * ((1.0 - score_a) - (1.0 - ea))


def football_ratings():
    """Use the normalized database so African, Arab and global imports count too."""
    ratings = {}
    if not DB.exists():
        raise SystemExit("Sports history database missing. Run the history collection workflow first.")
    with sqlite3.connect(DB) as db:
        matches = db.execute(
            "SELECT match_date, participant_a, participant_b, score_a, score_b "
            "FROM matches WHERE sport='football' AND score_a IS NOT NULL AND score_b IS NOT NULL "
            "ORDER BY match_date, id"
        ).fetchall()
    for _, a, b, sa, sb in matches:
        if not a or not b:
            continue
        update(ratings, a, b, 1.0 if sa > sb else 0.0 if sa < sb else 0.5)
    return ratings

def tennis_ratings():
    """Use normalized tennis history from every imported source."""
    ratings = {}
    if not DB.exists():
        raise SystemExit("Sports history database missing. Run the history collection workflow first.")
    with sqlite3.connect(DB) as db:
        matches = db.execute(
            "SELECT match_date, participant_a, participant_b, score_a, score_b "
            "FROM matches WHERE sport='tennis' AND score_a IS NOT NULL AND score_b IS NOT NULL "
            "ORDER BY match_date, id"
        ).fetchall()
    for _, winner_or_a, loser_or_b, sa, sb in matches:
        if not winner_or_a or not loser_or_b:
            continue
        update(ratings, winner_or_a, loser_or_b, 1.0 if sa > sb else 0.0 if sa < sb else 0.5)
    return ratings

def basketball_ratings():
    ratings = {}
    if not DB.exists():
        raise SystemExit("Sports history database missing. Run collect_full_history.py and build_database.py first.")
    with sqlite3.connect(DB) as db:
        rows = db.execute(
            "SELECT match_date, participant_a, participant_b, score_a, score_b FROM matches "
            "WHERE sport='basketball' AND score_a IS NOT NULL AND score_b IS NOT NULL ORDER BY match_date, id"
        ).fetchall()
    for _, a, b, sa, sb in rows:
        update(ratings, a, b, 1.0 if sa > sb else 0.0 if sa < sb else 0.5)
    return ratings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sport", required=True, choices=("football", "tennis", "basketball"))
    parser.add_argument("--home", required=True, help="First team/player")
    parser.add_argument("--away", required=True, help="Second team/player")
    args = parser.parse_args()
    ratings = {"football": football_ratings, "tennis": tennis_ratings, "basketball": basketball_ratings}[args.sport]()
    a, b = ratings.get(args.home, START), ratings.get(args.away, START)
    prob = expected(a, b)
    print(json.dumps({
        "sport": args.sport,
        "first": {"name": args.home, "elo": round(a, 1)},
        "second": {"name": args.away, "elo": round(b, 1)},
        "first_win_probability_percent": round(prob * 100, 1),
        "second_win_probability_percent": round((1 - prob) * 100, 1),
        "historical_participants_loaded": len(ratings),
        "warning": "Baseline only; no injuries, lineups, fatigue, venue effects or live odds. Probabilities are not guarantees.",
    }, indent=2))


if __name__ == "__main__":
    main()
