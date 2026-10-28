#!/usr/bin/env python3
"""Import historical results and bookmaker odds from downloaded Football-Data CSV files."""
import csv
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "data" / "history" / "raw" / "football_data"
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"


def value(row, *names):
    lower = {str(k).strip().lower(): v for k, v in row.items() if k is not None}
    for name in names:
        item = lower.get(name.lower())
        if item not in (None, ""):
            return item
    return None


def main():
    if not DB.exists():
        raise SystemExit("Run build_database.py before importing Football-Data CSVs.")
    files = sorted(BASE.rglob("*.csv")) if BASE.exists() else []
    imported = 0
    with sqlite3.connect(DB) as db:
        for path in files:
            try:
                with path.open(encoding="latin-1", newline="") as stream:
                    for row in csv.DictReader(stream):
                        home = value(row, "HomeTeam", "Home Team", "Home")
                        away = value(row, "AwayTeam", "Away Team", "Away")
                        hg = value(row, "FTHG", "HG", "HomeGoals")
                        ag = value(row, "FTAG", "AG", "AwayGoals")
                        date = value(row, "Date", "MatchDate")
                        if not home or not away or hg is None or ag is None:
                            continue
                        try:
                            hg, ag = float(hg), float(ag)
                        except (TypeError, ValueError):
                            continue
                        winner = home if hg > ag else away if ag > hg else "draw"
                        comp = path.parent.name.replace("-", " ").title()
                        db.execute(
                            "INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            ("football", comp, path.stem[:4], date, home, away, hg, ag, winner,
                             str(path.relative_to(ROOT)), json.dumps(row, ensure_ascii=False))
                        )
                        imported += 1
            except (OSError, UnicodeError, csv.Error):
                continue
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('football_data_imported',?)", (str(imported),))
        db.commit()
    print(json.dumps({"csv_files_seen": len(files), "football_matches_imported": imported}))
    if imported == 0:
        print("No Football-Data CSV rows matched expected result columns; other historical sources remain available.")


if __name__ == "__main__":
    main()
