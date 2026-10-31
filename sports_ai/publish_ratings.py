#!/usr/bin/env python3
"""Build compact Elo ratings JSON for Ash Jarvis to read over HTTPS."""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"
OUT = ROOT / "data" / "history" / "ratings.json"
START = 1500.0
K = 24.0


def expected(a, b):
    return 1.0 / (1.0 + 10.0 ** ((b - a) / 400.0))


def main():
    if not DB.exists():
        raise SystemExit("History database not found; run build_database.py first.")
    ratings = {"football": {}, "tennis": {}, "basketball": {}}
    appearances = {"football": {}, "tennis": {}, "basketball": {}}
    counts = {sport: 0 for sport in ratings}
    with sqlite3.connect(DB) as db:
        rows = db.execute(
            "SELECT sport, match_date, participant_a, participant_b, score_a, score_b "
            "FROM matches WHERE score_a IS NOT NULL AND score_b IS NOT NULL "
            "ORDER BY match_date, id"
        ).fetchall()
    for sport, _, a, b, sa, sb in rows:
        if sport not in ratings or not a or not b:
            continue
        table = ratings[sport]
        appearances[sport][a] = appearances[sport].get(a, 0) + 1
        appearances[sport][b] = appearances[sport].get(b, 0) + 1
        ra, rb = table.get(a, START), table.get(b, START)
        ea = expected(ra, rb)
        result = 1.0 if sa > sb else 0.0 if sa < sb else 0.5
        table[a] = ra + K * (result - ea)
        table[b] = rb + K * ((1.0 - result) - (1.0 - ea))
        counts[sport] += 1
    if not any(counts.values()):
        raise SystemExit("No match records available to build ratings.")
    payload = {
        "schema_version": 2,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "model": "Chronological Elo baseline; equal starting ratings; K=24; no injuries, lineups, surface or venue adjustments",
        "match_counts": counts,
        "data_license_notes": {
            "football": "OpenFootball datasets are CC0; the global football-data archive is ODC-BY 1.0 and requires attribution.",
            "tennis": "Jeff Sackmann ATP/WTA results are CC BY-NC-SA 4.0: non-commercial use only, attribution and share-alike required.",
            "basketball": "NBA team-game results are derived from the Shufinskiy archive; retain its applicable Apache-2.0 notice and attribution."
        },
        "participant_counts": {sport: len(table) for sport, table in ratings.items()},
        "appearances": {
            sport: {name: played for name, played in sorted(table.items())}
            for sport, table in appearances.items()
        },
        "ratings": {
            sport: {name: round(value, 2) for name, value in sorted(table.items())}
            for sport, table in ratings.items()
        },
        "warning": "Estimates only; not guaranteed outcomes or betting advice. Data coverage varies by source.",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(OUT.relative_to(ROOT)), "match_counts": counts,
                      "participants": {k: len(v) for k, v in ratings.items()}}))


if __name__ == "__main__":
    main()
