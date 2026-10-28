#!/usr/bin/env python3
"""Import Saudi Pro League CSV results into the normalized sports database."""
from __future__ import annotations
import csv
import json
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
RAW=ROOT/"data"/"history"/"raw"/"arab_football"/"saudi"/"csv"
DB=ROOT/"data"/"history"/"ash_sports_history.sqlite"


def norm(v):
    return " ".join(str(v or "").strip().casefold().split())


def date_fix(v):
    v=str(v or "").strip()
    for fmt in ("%d.%m.%Y","%d/%m/%Y","%d.%m.%y","%Y-%m-%d"):
        try:
            return datetime.strptime(v,fmt).date().isoformat()
        except ValueError:
            pass
    return v


def main():
    if not DB.exists():
        raise SystemExit("SQLite database missing; run build_database.py first.")
    files=sorted(RAW.glob("*.csv")) if RAW.exists() else []
    imported=skipped=0
    with sqlite3.connect(DB) as db:
        existing={(norm(d),norm(a),norm(b),sa,sb) for d,a,b,sa,sb in db.execute(
            "SELECT match_date,participant_a,participant_b,score_a,score_b FROM matches WHERE sport='football'")}
        for path in files:
            try:
                with path.open(encoding="utf-8-sig",newline="") as handle:
                    for original in csv.DictReader(handle):
                        row={str(k or "").strip().casefold():v for k,v in original.items()}
                        a=row.get("team1") or row.get("home") or row.get("hometeam")
                        b=row.get("team2") or row.get("away") or row.get("awayteam")
                        sa=row.get("score1") or row.get("home_score") or row.get("fthg")
                        sb=row.get("score2") or row.get("away_score") or row.get("ftag")
                        if not a or not b or sa in (None,"") or sb in (None,""):
                            continue
                        try: sa,sb=float(sa),float(sb)
                        except (ValueError,TypeError): continue
                        date=date_fix(row.get("date") or row.get("match_date"))
                        key=(norm(date),norm(a),norm(b),sa,sb)
                        if key in existing:
                            skipped+=1
                            continue
                        existing.add(key)
                        winner=a if sa>sb else b if sb>sa else "draw"
                        season=path.stem.replace("SPL-","").replace("-FS","").replace("-SS","")
                        db.execute(
                            "INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            ("football","Saudi Pro League",season,date,a,b,sa,sb,winner,str(path.relative_to(ROOT)),json.dumps(original,ensure_ascii=False))
                        )
                        imported+=1
            except (OSError,UnicodeError,csv.Error):
                continue
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('saudi_matches_imported',?)",(str(imported),))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('saudi_duplicates_skipped',?)",(str(skipped),))
        db.commit()
        counts=dict(db.execute("SELECT sport,COUNT(*) FROM matches GROUP BY sport").fetchall())
    print(json.dumps({"saudi_csv_files":len(files),"saudi_matches_imported":imported,"duplicates_skipped":skipped,"database_counts":counts}))
    if imported==0:
        print("No new Saudi rows imported; inspect source column names and archive coverage.")


if __name__=="__main__":
    main()
