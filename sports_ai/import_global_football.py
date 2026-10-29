#!/usr/bin/env python3
"""Import global historical football results from the ODC-BY parquet archive."""
from __future__ import annotations
import json
import sqlite3
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "history" / "raw" / "global_football" / "global-football-results.parquet"
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"


def pick(columns, *names):
    by_lower = {str(c).strip().casefold(): c for c in columns}
    for name in names:
        if name.casefold() in by_lower:
            return by_lower[name.casefold()]
    return None


def main():
    if not RAW.exists():
        raise SystemExit("Global football parquet missing; run collect_global_football.py first.")
    if not DB.exists():
        raise SystemExit("Sports history database missing; run build_database.py first.")
    frame = pd.read_parquet(RAW)
    cols = list(frame.columns)
    fields = {
        "home": pick(cols, "home", "home_team", "hometeam"),
        "away": pick(cols, "away", "away_team", "awayteam"),
        "date": pick(cols, "date", "match_date", "game_date"),
        "home_score": pick(cols, "gh", "home_score", "home_goals", "fthg"),
        "away_score": pick(cols, "ga", "away_score", "away_goals", "ftag"),
        "competition": pick(cols, "competition", "league", "tournament"),
        "country": pick(cols, "home_country", "country"),
        "level": pick(cols, "level"),
        "full_time": pick(cols, "full_time", "fulltime", "status"),
    }
    if not all(fields[k] for k in ("home", "away", "home_score", "away_score")):
        raise SystemExit("Unexpected global football parquet schema: " + json.dumps({k: str(v) if v else None for k, v in fields.items()}))
    imported = skipped = invalid = 0
    with sqlite3.connect(DB) as db:
        existing = {
            (str(d or "").strip()[:10], str(a or "").strip().casefold(),
             str(b or "").strip().casefold(), float(sa), float(sb))
            for d, a, b, sa, sb in db.execute(
                "SELECT match_date,participant_a,participant_b,score_a,score_b FROM matches WHERE sport='football' AND score_a IS NOT NULL AND score_b IS NOT NULL"
            )
        }
        for row in frame.to_dict(orient="records"):
            a, b = row.get(fields["home"]), row.get(fields["away"])
            if pd.isna(a) or pd.isna(b) or not str(a).strip() or not str(b).strip():
                invalid += 1
                continue
            status = str(row.get(fields["full_time"]) or "").strip().upper() if fields["full_time"] else ""
            # Penalty-shootout scorelines are not comparable with ordinary full-time results.
            if status == "P":
                skipped += 1
                continue
            try:
                sa, sb = float(row.get(fields["home_score"])), float(row.get(fields["away_score"]))
            except (TypeError, ValueError):
                invalid += 1
                continue
            if pd.isna(sa) or pd.isna(sb):
                invalid += 1
                continue
            date_value = row.get(fields["date"]) if fields["date"] else ""
            if pd.isna(date_value):
                date_value = ""
            elif hasattr(date_value, "strftime"):
                date_value = date_value.strftime("%Y-%m-%d")
            else:
                date_value = str(date_value)[:32]
            date_key = str(date_value)[:10]
            key = (date_key, str(a).strip().casefold(), str(b).strip().casefold(), sa, sb)
            if key in existing:
                skipped += 1
                continue
            existing.add(key)
            competition_value = row.get(fields["competition"]) if fields["competition"] else "Global historical football"
            country_value = row.get(fields["country"]) if fields["country"] else ""
            level_value = row.get(fields["level"]) if fields["level"] else ""
            comp = str(competition_value or "Global historical football").strip()
            if not pd.isna(country_value) and str(country_value).strip() and str(country_value).strip().casefold() not in comp.casefold():
                comp = f"{str(country_value).strip()} — {comp}"
            winner = str(a) if sa > sb else str(b) if sb > sa else "draw"
            raw = {str(k): (None if pd.isna(v) else str(v)) for k, v in row.items()}
            if level_value and not pd.isna(level_value):
                raw["_source_level"] = str(level_value)
            db.execute(
                "INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("football", comp, date_key[:4] if len(date_key) >= 4 else "",
                 date_key, str(a), str(b), sa, sb, winner,
                 "data/history/raw/global_football/global-football-results.parquet",
                 json.dumps(raw, ensure_ascii=False))
            )
            imported += 1
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('global_football_matches_imported',?)", (str(imported),))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('global_football_duplicates_or_penalties_skipped',?)", (str(skipped),))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('global_football_invalid_rows',?)", (str(invalid),))
        db.commit()
        counts = dict(db.execute("SELECT sport,COUNT(*) FROM matches GROUP BY sport").fetchall())
    summary = {"source_rows": len(frame), "imported": imported, "duplicates_or_penalties_skipped": skipped, "invalid_rows": invalid, "database_counts": counts, "schema": {k: str(v) if v else None for k,v in fields.items()}}
    print(json.dumps(summary))
    if imported == 0:
        print("No new rows added; source may overlap existing results or need schema review.")


if __name__ == "__main__":
    main()
