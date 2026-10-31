#!/usr/bin/env python3
"""Import dated, completed results from the CC0 OpenFootball world archive.

The shared parser normalizes date headings and accepts only unambiguous score rows.
Unknown date formats and ambiguous rows are skipped, never guessed.
"""
from __future__ import annotations
import json
import re
import sqlite3
from pathlib import Path
from football_txt_parser import parse_football_txt

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "data" / "history" / "raw" / "football_world" / "unpacked"
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"
SEASON_RE = re.compile(r"(?:19|20)\d{2}-\d{2}|20\d{2}")


def main():
    if not DB.exists():
        raise SystemExit("Database missing; run build_database.py first.")
    files = sorted(BASE.rglob("*.txt")) if BASE.exists() else []
    imported = skipped = 0
    seen = set()
    competition_counts = {}
    with sqlite3.connect(DB) as db:
        # Avoid double-counting results present in football.json or the global archive.
        # Competition labels differ between sources, so compare date, teams and score.
        for date, home, away, home_score, away_score in db.execute(
            "SELECT match_date,participant_a,participant_b,score_a,score_b FROM matches WHERE sport='football'"
        ):
            date_key = str(date or "")[:10]
            home_key = " ".join(str(home or "").casefold().split())
            away_key = " ".join(str(away or "").casefold().split())
            seen.add((date_key, home_key, away_key, home_score, away_score))
            seen.add((date_key, away_key, home_key, away_score, home_score))
        for path in files:
            relative = path.relative_to(BASE)
            parts = list(relative.parts)
            season = next((part for part in parts if SEASON_RE.fullmatch(part)), "")
            # Keep region/country and competition in the competition label, not season.
            label_parts = [part for part in parts[:-1] if part != season]
            competition = " / ".join(label_parts + [path.stem])
            for match in parse_football_txt(path):
                home, away = match["home"], match["away"]
                home_score, away_score = match["home_score"], match["away_score"]
                date_key = str(match["date"])[:10]
                home_key = " ".join(home.casefold().split())
                away_key = " ".join(away.casefold().split())
                key = (date_key, home_key, away_key, home_score, away_score)
                reverse_key = (date_key, away_key, home_key, away_score, home_score)
                if key in seen or reverse_key in seen:
                    skipped += 1
                    continue
                seen.add(key)
                seen.add(reverse_key)
                winner = home if home_score > away_score else away if away_score > home_score else "draw"
                db.execute(
                    "INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    ("football", competition, season, match["date"], home, away,
                     home_score, away_score, winner, str(path.relative_to(ROOT)),
                     json.dumps(match, ensure_ascii=False)),
                )
                imported += 1
                competition_counts[competition] = competition_counts.get(competition, 0) + 1
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('world_archive_imported',?)", (str(imported),))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('world_archive_skipped_duplicates',?)", (str(skipped),))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('world_archive_competition_counts',?)",
                   (json.dumps(competition_counts, sort_keys=True),))
        db.commit()
    print(json.dumps({
        "world_archive_files": len(files),
        "world_archive_matches_imported": imported,
        "duplicates_skipped": skipped,
        "competitions_detected": len(competition_counts),
        "competition_counts": competition_counts,
    }))
    if imported == 0:
        print("No dated, unambiguous results imported. Check source date/score formats; raw archive is preserved.")


if __name__ == "__main__":
    main()
