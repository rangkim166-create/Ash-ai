#!/usr/bin/env python3
"""Import compact basketball game parquet tables into normalized SQLite."""
from __future__ import annotations
import json
import sqlite3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
RAW=ROOT/"data"/"history"/"raw"/"basketball_parquet"
DB=ROOT/"data"/"history"/"ash_sports_history.sqlite"

ALIASES={
 "date":["date","game_date","match_date","start_date","game_datetime","datetime"],
 "home":["home_team","home_team_name","hometeam","home","team_home","local_team","home_name"],
 "away":["away_team","away_team_name","awayteam","away","team_away","visitor_team","away_name"],
 "home_score":["home_score","home_points","home_pts","score_home","home_team_score","local_score","score1"],
 "away_score":["away_score","away_points","away_pts","score_away","away_team_score","visitor_score","score2"],
 "competition":["league","competition","tournament","league_name"],
 "season":["season","season_name","year"]
}


def pick(columns, candidates):
    lower={str(c).strip().casefold():c for c in columns}
    for name in candidates:
        if name in lower:
            return lower[name]
    return None


def main():
    if not DB.exists():
        raise SystemExit("SQLite database missing; run build_database.py first.")
    try:
        import pandas as pd
    except ImportError:
        raise SystemExit("pandas/pyarrow missing; workflow must install pandas and pyarrow")
    files=sorted(RAW.glob("*-games.parquet")) if RAW.exists() else []
    imported=skipped=0
    schema_reports=[]
    with sqlite3.connect(DB) as db:
        existing={(str(d or "").strip().casefold(),str(a or "").strip().casefold(),str(b or "").strip().casefold(),sa,sb)
                  for d,a,b,sa,sb in db.execute("SELECT match_date,participant_a,participant_b,score_a,score_b FROM matches WHERE sport='basketball'")}
        for path in files:
            try:
                frame=pd.read_parquet(path)
            except Exception as exc:
                schema_reports.append({"file":path.name,"error":str(exc)[:160]})
                continue
            cols=list(frame.columns)
            found={key:pick(cols,names) for key,names in ALIASES.items()}
            schema_reports.append({"file":path.name,"columns":[str(c) for c in cols],"mapped":{k:str(v) if v is not None else None for k,v in found.items()}})
            if not all(found[k] for k in ("home","away","home_score","away_score")):
                continue
            for _,r in frame.iterrows():
                a,b=r[found["home"]],r[found["away"]]
                if pd.isna(a) or pd.isna(b) or not str(a).strip() or not str(b).strip():
                    continue
                try: sa,sb=float(r[found["home_score"]]),float(r[found["away_score"]])
                except (TypeError,ValueError): continue
                if sa==sb: continue
                date=r[found["date"]] if found["date"] else ""
                if hasattr(date,"strftime"):
                    date=date.strftime("%Y-%m-%d")
                elif date is None or (isinstance(date,float) and pd.isna(date)):
                    date=""
                else: date=str(date)[:32]
                key=(str(date).strip().casefold(),str(a).strip().casefold(),str(b).strip().casefold(),sa,sb)
                if key in existing:
                    skipped+=1
                    continue
                existing.add(key)
                competition=str(r[found["competition"]]) if found["competition"] and not pd.isna(r[found["competition"]]) else path.stem.replace("-games","").replace("-"," ").title()
                season=str(r[found["season"]]) if found["season"] and not pd.isna(r[found["season"]]) else ""
                winner=str(a) if sa>sb else str(b)
                raw={str(c): (None if pd.isna(r[c]) else str(r[c])) for c in cols}
                db.execute("INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    ("basketball",competition,season,str(date),str(a),str(b),sa,sb,winner,str(path.relative_to(ROOT)),json.dumps(raw,ensure_ascii=False)))
                imported+=1
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('basketball_parquet_imported',?)",(str(imported),))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('basketball_parquet_schema',?)",(json.dumps(schema_reports),))
        db.commit()
        counts=dict(db.execute("SELECT sport,COUNT(*) FROM matches GROUP BY sport").fetchall())
    print(json.dumps({"files_read":len(files),"basketball_matches_imported":imported,"duplicates_skipped":skipped,"database_counts":counts,"schema_reports":schema_reports}))
    if imported==0:
        print("No basketball rows imported. Review schema_reports; source columns may require additional aliases.")


if __name__=="__main__":
    main()
