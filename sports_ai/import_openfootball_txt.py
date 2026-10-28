#!/usr/bin/env python3
"""Import verified full-time results from OpenFootball Football.TXT files into SQLite.

Parser intentionally accepts only simple, unambiguous score lines. Fixtures without a
final score and penalty/extra-time lines are skipped rather than guessed.
"""
from __future__ import annotations
import re
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "data" / "history" / "raw" / "football_world" / "unpacked"
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"
SCORE = re.compile(r"(?P<a>.+?)\s+(?P<sa>\d{1,2})-(?P<sb>\d{1,2})\s+(?P<b>.+?)\s*(?:@.*)?$")
DATE = re.compile(r"^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(?:\w{3,9}\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}[./-]\d{1,2}[./-]\d{4})$")


def clean_team(value: str) -> str:
    value = re.sub(r"\\([^)]*\\)", "", value)
    value = re.sub(r"^\\(\\d+\\)\\s*", "", value)
    # Some upstream fixtures prefix team names with kickoff time; never treat it as part of the name.
    value = re.sub(r"^\\d{1,2}:\\d{2}\\s+", "", value.strip())
    return " ".join(value.split()).strip(" -|")


def parse_line(line: str):
    line = re.sub(r"^\s*\(\d+\)\s*", "", line.strip())
    if not line or line.startswith(("#", "(", "[", "▪", "::", "=")):
        return None
    if re.search(r"\b(?:pen\.?|a\.?e\.?t\.?|agget|asget)\b", line, re.I):
        return None
    # Modern layout: Home Team v Away Team 2-1
    m = re.match(r"^(?P<a>.+?)\s+(?:v|vs\.?|-)\s+(?P<b>.+?)\s+(?P<sa>\d{1,2})-(?P<sb>\d{1,2})(?:\s+\([^)]*\))?(?:\s+@.*)?$", line, re.I)
    if m:
        a, b = clean_team(m.group("a")), clean_team(m.group("b"))
        if a and b and a.lower() != b.lower():
            return a, b, int(m.group("sa")), int(m.group("sb"))
    # Older layout: Home Team 2-1 Away Team
    m = SCORE.match(line)
    if m:
        a, b = clean_team(m.group("a")), clean_team(m.group("b"))
        if a and b and a.lower() != b.lower():
            return a, b, int(m.group("sa")), int(m.group("sb"))
    return None


def main():
    if not DB.exists():
        raise SystemExit("Database missing; run build_database.py first.")
    imported = 0
    seen = set()
    with sqlite3.connect(DB) as db:
        files = sorted(BASE.rglob("*.txt")) if BASE.exists() else []
        for path in files:
            competition = path.parent.name.replace("-", " ").title()
            season = next((part for part in path.parts if re.fullmatch(r"20\d{2}-\d{2}|19\d{2}-\d{2}", part)), "")
            current_date = ""
            try:
                lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
            except OSError:
                continue
            for raw in lines:
                line = raw.strip()
                if not line:
                    continue
                if DATE.fullmatch(line):
                    # Date-only headers are intentionally kept as text when year is absent.
                    current_date = line
                    continue
                parsed = parse_line(line)
                if not parsed:
                    continue
                a, b, sa, sb = parsed
                key = (competition, season, current_date, a, b, sa, sb)
                if key in seen:
                    continue
                seen.add(key)
                winner = a if sa > sb else b if sb > sa else "draw"
                db.execute(
                    "INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    ("football", competition, season, current_date, a, b, sa, sb, winner,
                     str(path.relative_to(ROOT)), raw[:1000]),
                )
                imported += 1
        row = db.execute("SELECT value FROM metadata WHERE key='world_archive_imported'").fetchone()
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('world_archive_imported',?)", (str(imported),))
        db.commit()
    print({"world_archive_files": len(files), "world_archive_matches_imported": imported})
    if imported == 0:
        print("No unambiguous scored text matches imported; archive retained for future parser improvements.")


if __name__ == "__main__":
    main()
