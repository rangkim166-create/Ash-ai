#!/usr/bin/env python3
"""Fetch compact match-result parquet tables for several basketball leagues.

Upstream dataset has no clearly documented reuse license in the repository README;
retain attribution and obtain permission before commercial redistribution.
"""
from __future__ import annotations
import json
import time
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"data"/"history"/"raw"/"basketball_parquet"
BASE="https://raw.githubusercontent.com/timurkulenovic/basketball-dataset/main/data"
LEAGUES={"nba":"nba","euroleague":"euroleague","eurocup":"eurocup","aba":"aba","slovenian-league":"slo"}


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    results=[]
    for label,folder in LEAGUES.items():
        url=f"{BASE}/{folder}/games/parquet/games.parquet"
        target=OUT/f"{label}-games.parquet"
        req=urllib.request.Request(url,headers={"User-Agent":"AshSportsAI historical sports data"})
        try:
            with urllib.request.urlopen(req,timeout=45) as resp:
                data=resp.read()
            if not data or not data.startswith(b"PAR1"):
                raise ValueError("response is not a parquet file")
            target.write_bytes(data)
            results.append({"league":label,"url":url,"path":str(target.relative_to(ROOT)),"bytes":len(data),"status":"ok"})
        except Exception as exc:
            results.append({"league":label,"url":url,"status":"unavailable","error":str(exc)[:180]})
    manifest={"generated_at_utc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"source":"https://github.com/timurkulenovic/basketball-dataset","coverage_note":"NBA, EuroLeague, EuroCup, ABA League and Slovenian league game tables where available; not all global basketball.","license_note":"No clear license found in upstream README. Do not redistribute or use commercially without permission.","summary":{"downloaded":sum(x["status"]=="ok" for x in results),"unavailable":sum(x["status"]!="ok" for x in results)},"sources":results}
    (OUT/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(manifest["summary"]))
    if not manifest["summary"]["downloaded"]:
        raise SystemExit("No basketball parquet datasets downloaded")


if __name__=="__main__":
    main()
