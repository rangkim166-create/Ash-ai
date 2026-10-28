#!/usr/bin/env python3
"""Import Football-Data.co.uk match results and supplied odds into Ash SQLite.

The raw CSV row is retained in raw_json so bookmaker columns are not thrown away.
Existing identical result rows are skipped to avoid repeated imports.
"""
from __future__ import annotations
import csv
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "history" / "raw" / "football_data"
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"


def norm(value):
    return " ".join(str(value or "").strip().casefold().split())


def date_normalize(value):
    value = str(value or "").strip()
    if not value:
        return ""
    # Football-Data normally uses day/month/two-digit-year; preserve original if invalid.
    for fmt in ("%d/%m/%y", "%d/%m/%Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            from datetime import datetime
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass
    return value


def main():
    if not DB.exists():
        raise SystemExit("SQLite database missing; run build_database.py first.")
    files = sorted(RAW.rglob("*.csv")) if RAW.exists() else []
    imported = 0
    skipped = 0
    with sqlite3.connect(DB) as db:
        existing = set()
        for row in db.execute("SELECT match_date, participant_a, participant_b, score_a, score_b FROM matches WHERE sport='football'"):
            existing.add((norm(row[0]), norm(row[1]), norm(row[2]), row[3], row[4]))
        for path in files:
            try:
                with path.open("r",encoding="utf-8-sig",newline="") as handle:
                    reader = csv.DictReader(handle)
                    for original in reader:
                        if not original:
                            continue
                        row = {str(k or "").strip().casefold():v for k,v in original.items()}
                        home = row.get("hometeam") or row.get("home team")
                        away = row.get("awayteam") or row.get("away team")
                        hg = row.get("fthg") or row.get("homegoals")
                        ag = row.get("ftag") or row.get("awaygoals")
                        if not home or not away or hg in (None,"") or ag in (None,""):
                            continue
                        try:
                            home_score, away_score = float(hg), float(ag)
                        except (ValueError,TypeError):
                            continue
                        date = date_normalize(row.get("date") or row.get("matchdate"))
                        key = (norm(date),norm(home),norm(away),home_score,away_score)
                        if key in existing:
                            skipped += 1
                            continue
                        existing.add(key)
                        winner = home if home_score > away_score else away if away_score > home_score else "draw"
                        competition = path.parent.name.replace("-"," ").title()
                        season = path.name.split("_",1)[0]
                        db.execute(
                            "INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            ("football",competition,season,date,home,away,home_score,away_score,winner,str(path.relative_to(ROOT)),json.dumps(original,ensure_ascii=False))
                        )
                        imported += 1
            except (OSError,UnicodeError,csv.Error):
                continue
        try:
            db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('football_data_imported',?)",(str(imported),))
            db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('football_data_duplicate_rows_skipped',?)",(str(skipped),))
        except sqlite3.OperationalError:
            pass
        db.commit()
        counts = dict(db.execute("SELECT sport, COUNT(*) FROM matches GROUP BY sport").fetchall())
    print(json.dumps({"files_read":len(files),"football_data_matches_imported":imported,"duplicate_rows_skipped":skipped,"database_counts":counts}))
    if imported == 0:
        print("No new rows imported. Check collector manifest and CSV header formats; existing rows may already cover these games.")


if __name__ == "__main__":
    main()
