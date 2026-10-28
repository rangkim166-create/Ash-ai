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
    ratings = {}
    files = sorted((RAW / "football").glob("*/*.json"))
    matches = []
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for m in data.get("matches", []):
                score_data = m.get("score")
                score = score_data.get("ft") if isinstance(score_data, dict) else score_data if isinstance(score_data, list) else None
                a, b = m.get("team1"), m.get("team2")
                if a and b and score and len(score) >= 2 and score[0] is not None and score[1] is not None:
                    matches.append((str(m.get("date") or ""), a, b, float(score[0]), float(score[1])))
        except (OSError, ValueError, TypeError):
            continue
    for _, a, b, sa, sb in sorted(matches):
        update(ratings, a, b, 1.0 if sa > sb else 0.0 if sa < sb else 0.5)
    return ratings


def tennis_ratings():
    ratings = {}
    matches = []
    for path in sorted((RAW / "tennis").glob("*/*.csv")):
        try:
            with path.open(encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    winner = row.get("winner_name") or row.get("Winner") or row.get("winner")
                    loser = row.get("loser_name") or row.get("Loser") or row.get("loser")
                    if winner and loser:
                        date = str(row.get("tourney_date") or row.get("date") or path.stem[-4:])
                        matches.append((date, winner, loser))
        except (OSError, UnicodeError, csv.Error):
            continue
    for _, winner, loser in sorted(matches):
        update(ratings, winner, loser, 1.0)
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
