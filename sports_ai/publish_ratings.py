#!/usr/bin/env python3
"""Build compact Elo ratings JSON for Ash Jarvis to read over HTTPS."""
import json
import sqlite3
from collections import deque
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"
OUT = ROOT / "data" / "history" / "ratings.json"
START = 1500.0
K = 24.0
FORM_LIMIT = 10
FORM_WINDOW_DAYS = 1095


def expected(a, b):
    return 1.0 / (1.0 + 10.0 ** ((b - a) / 400.0))


def main():
    if not DB.exists():
        raise SystemExit("History database not found; run build_database.py first.")
    ratings = {"football": {}, "tennis": {}, "basketball": {}}
    appearances = {"football": {}, "tennis": {}, "basketball": {}}
    recent_form = {"football": {}, "tennis": {}, "basketball": {}}
    counts = {sport: 0 for sport in ratings}
    cutoff = date.today() - timedelta(days=FORM_WINDOW_DAYS)
    with sqlite3.connect(DB) as db:
        rows = db.execute(
            "SELECT sport, match_date, participant_a, participant_b, score_a, score_b, competition "
            "FROM matches WHERE score_a IS NOT NULL AND score_b IS NOT NULL "
            "ORDER BY CASE WHEN length(match_date)=8 AND match_date NOT GLOB '*[^0-9]*' "
            "THEN substr(match_date,1,4)||'-'||substr(match_date,5,2)||'-'||substr(match_date,7,2) "
            "ELSE substr(match_date,1,10) END, id"
        ).fetchall()
    for sport, match_date, a, b, sa, sb, competition in rows:
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
        raw_date = str(match_date or "").strip()
        normalized_date = ""
        try:
            if len(raw_date) == 8 and raw_date.isdigit():
                normalized_date = datetime.strptime(raw_date, "%Y%m%d").date().isoformat()
            else:
                normalized_date = datetime.fromisoformat(raw_date.replace("Z", "+00:00")).date().isoformat()
        except ValueError:
            if len(raw_date) >= 10 and raw_date[4:5] == "-" and raw_date[7:8] == "-":
                normalized_date = raw_date[:10]
        if normalized_date:
            try:
                eligible = date.fromisoformat(normalized_date) >= cutoff
            except ValueError:
                eligible = False
            if eligible:
                result_a = "W" if sa > sb else "L" if sa < sb else "D"
                result_b = "L" if sa > sb else "W" if sa < sb else "D"
                event = "{} vs {}".format(a, b)
                for participant, opponent, outcome in ((a, b, result_a), (b, a, result_b)):
                    history = recent_form[sport].setdefault(participant, deque(maxlen=FORM_LIMIT))
                    history.append({
                        "date": normalized_date,
                        "event": event,
                        "opponent": opponent,
                        "outcome": outcome,
                        "score": "{}-{}".format(sa, sb),
                        "competition": str(competition or ""),
                        "source": "Ash historical results archive"
                    })
    if not any(counts.values()):
        raise SystemExit("No match records available to build ratings.")
    payload = {
        "schema_version": 3,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "model": "Chronological Elo baseline; equal starting ratings; K=24; no injuries, lineups, surface or venue adjustments",
        "match_counts": counts,
        "data_license_notes": {
            "football": "OpenFootball datasets are CC0; the global football-data archive is ODC-BY 1.0 and requires attribution.",
            "tennis": "Jeff Sackmann ATP/WTA results are CC BY-NC-SA 4.0: non-commercial use only, attribution and share-alike required.",
            "basketball": "NBA team-game results are from the llimllib stats.nba.com mirror (2009/10 onward); the repository does not publish an explicit dataset reuse license, so this source is not commercially cleared."
        },
        "participant_counts": {sport: len(table) for sport, table in ratings.items()},
        "recent_form_window_days": FORM_WINDOW_DAYS,
        "recent_form_per_participant": FORM_LIMIT,
        "recent_form": {
            sport: {name: list(records)[::-1] for name, records in sorted(table.items())}
            for sport, table in recent_form.items()
        },
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
