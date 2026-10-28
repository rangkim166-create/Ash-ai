#!/usr/bin/env python3
"""Audit historical data coverage and explicitly list requested leagues not found."""
from __future__ import annotations
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DB=ROOT/"data"/"history"/"ash_sports_history.sqlite"
OUT=ROOT/"data"/"history"/"coverage-report.json"
TARGETS={
 "arab_football":[
  ("Saudi Pro League",["saudi"]),
  ("Egyptian Premier League",["egypt","egyptian"]),
  ("Moroccan Botola",["morocco","moroccan","botola"]),
  ("Algerian Ligue 1",["algeria","algerian"]),
  ("Qatar Stars League",["qatar"]),
  ("UAE Pro League",["uae","united arab emirates"]),
  ("Tunisian Ligue 1",["tunisia","tunisian"])
 ],
 "popular_europe":[
  ("English Premier League",["premier league","england"]),
  ("English Championship",["championship"]),
  ("German Bundesliga",["bundesliga"]),
  ("Spanish La Liga",["la liga","spain"]),
  ("Italian Serie A",["serie a","italy"]),
  ("French Ligue 1",["ligue 1","france"]),
  ("Dutch Eredivisie",["eredivisie"]),
  ("Portuguese Primeira Liga",["primeira","portugal"]),
  ("Scottish Premiership",["scotland","premiership"])
 ]
}


def main():
    if not DB.exists():
        raise SystemExit("History database not found.")
    with sqlite3.connect(DB) as db:
        by_sport=[{"sport":s,"matches":n} for s,n in db.execute("SELECT sport,COUNT(*) FROM matches GROUP BY sport ORDER BY sport")]
        by_comp=[{"sport":s,"competition":c,"matches":n,"first_date":lo,"last_date":hi} for s,c,n,lo,hi in db.execute(
            "SELECT sport,COALESCE(competition,'unknown'),COUNT(*),MIN(NULLIF(match_date,'')),MAX(NULLIF(match_date,'')) FROM matches GROUP BY sport,competition ORDER BY sport,n DESC")]
        seasons=[{"sport":s,"season":str(y),"matches":n} for s,y,n in db.execute("SELECT sport,COALESCE(season,''),COUNT(*) FROM matches GROUP BY sport,season ORDER BY sport,season")]
        metadata=dict(db.execute("SELECT key,value FROM metadata").fetchall())
    comp_names=[str(x["competition"]).casefold() for x in by_comp]
    target_report={}
    for group,items in TARGETS.items():
        target_report[group]=[]
        for name,keywords in items:
            matches=[c for c in by_comp if any(k in str(c["competition"]).casefold() for k in keywords)]
            target_report[group].append({"target":name,"detected":bool(matches),"matched_competitions":[c["competition"] for c in matches],"matches_found":sum(c["matches"] for c in matches)})
    report={
      "generated_at_utc":datetime.now(timezone.utc).isoformat(),
      "completeness":"best_effort_not_exhaustive",
      "summary":{"total_matches":sum(x["matches"] for x in by_sport),"by_sport":by_sport,"competitions_with_matches":len(by_comp)},
      "target_coverage":target_report,
      "competition_counts":by_comp,
      "season_counts":seasons,
      "pipeline_metadata":metadata,
      "warnings":[
       "A detected competition name does not prove every season is complete.",
       "Missing target means no matching competition name was detected; inspect source manifests before concluding no source exists.",
       "This dataset is not every match worldwide and does not contain complete historical odds for every league.",
       "Elo scores and probabilities are estimates, not guaranteed outcomes."
      ]
    }
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    print(json.dumps(report["summary"]))
    print(json.dumps({g:[x["target"] for x in rows if not x["detected"]] for g,rows in target_report.items()}))


if __name__=="__main__":
    main()
