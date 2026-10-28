#!/usr/bin/env python3
"""Elo baseline for football and tennis results. This is not betting advice."""
import argparse, csv, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "history" / "raw"
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
    for path in sorted((RAW / "football").glob("*/*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for m in data.get("matches", []):
                score = m.get("score", {}).get("ft")
                a, b = m.get("team1"), m.get("team2")
                if not a or not b or not score or len(score) < 2 or score[0] is None or score[1] is None:
                    continue
                result = 1.0 if score[0] > score[1] else 0.0 if score[0] < score[1] else 0.5
                update(ratings, a, b, result)
        except (OSError, ValueError, TypeError):
            continue
    return ratings

def tennis_ratings():
    ratings = {}
    for path in sorted((RAW / "tennis").glob("*/*.csv")):
        try:
            with path.open(encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    winner, loser = row.get("winner_name"), row.get("loser_name")
                    if winner and loser:
                        update(ratings, winner, loser, 1.0)
        except (OSError, UnicodeError):
            continue
    return ratings

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sport", required=True, choices=("football", "tennis"))
    p.add_argument("--home", required=True, help="First team/player")
    p.add_argument("--away", required=True, help="Second team/player")
    args = p.parse_args()
    ratings = football_ratings() if args.sport == "football" else tennis_ratings()
    a, b = ratings.get(args.home, START), ratings.get(args.away, START)
    prob = expected(a, b)
    print(json.dumps({
        "sport": args.sport,
        "first": {"name": args.home, "elo": round(a, 1)},
        "second": {"name": args.away, "elo": round(b, 1)},
        "first_win_probability_percent": round(prob * 100, 1),
        "second_win_probability_percent": round((1-prob) * 100, 1),
        "historical_participants_loaded": len(ratings),
        "warning": "Baseline only. It excludes current injuries, lineups, tennis surface, fatigue and live odds."
    }, indent=2))

if __name__ == "__main__":
    main()
