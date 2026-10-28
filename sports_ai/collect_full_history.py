#!/usr/bin/env python3
"""Download public historical sports results for Ash Sports AI."""
from __future__ import annotations
import json, time, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
RAW=ROOT/"data"/"history"/"raw"
MANIFEST=ROOT/"data"/"history"/"full-history-manifest.json"
UA="AshSportsAI historical data collector/0.2"
def fetch(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        req=urllib.request.Request(url, headers={"User-Agent":UA})
        with urllib.request.urlopen(req, timeout=45) as response: data=response.read()
        if not data: raise ValueError("empty response")
        target.write_bytes(data)
        return {"url":url,"path":str(target.relative_to(ROOT)),"bytes":len(data),"status":"ok"}
    except Exception as exc:
        return {"url":url,"path":str(target.relative_to(ROOT)),"status":"unavailable","error":str(exc)[:240]}
def main():
    results=[]
    leagues={"england-premier-league":"en.1.json","england-championship":"en.2.json","germany-bundesliga":"de.1.json","germany-2-bundesliga":"de.2.json","spain-la-liga":"es.1.json","spain-segunda":"es.2.json","italy-serie-a":"it.1.json","italy-serie-b":"it.2.json","france-ligue-1":"fr.1.json","france-ligue-2":"fr.2.json","netherlands-eredivisie":"nl.1.json","portugal-primeira":"pt.1.json","scotland-premiership":"sc.1.json","usa-mls":"us.1.json","brazil-serie-a":"br.1.json","world-cup":"world.cup.json","europe-euro":"europe.euro.json"}
    for start in range(2000,2027):
        season=f"{start}-{(start+1)%100:02d}"
        for league,filename in leagues.items():
            url=f"https://raw.githubusercontent.com/openfootball/football.json/master/{season}/{filename}"
            results.append(fetch(url,RAW/"football"/league/f"{season}.json")); time.sleep(0.04)
    for tour in ("atp","wta"):
        for year in range(1968,2027):
            name=f"{tour}_matches_{year}.csv"
            url=f"https://raw.githubusercontent.com/JeffSackmann/tennis_{tour}/master/{name}"
            results.append(fetch(url,RAW/"tennis"/tour/name)); time.sleep(0.04)
    nba_url="https://codeload.github.com/dckp1000/NBA-96-26-DATASET/zip/refs/heads/main"
    results.append(fetch(nba_url,RAW/"basketball"/"NBA-96-26-DATASET.zip"))
    manifest={"generated_at_utc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"coverage_note":"Broad public-source collection, not every match ever played. Missing upstream files are expected. Results are not historical betting odds.","sources":results,"summary":{"downloaded":sum(x["status"]=="ok" for x in results),"unavailable":sum(x["status"]!="ok" for x in results),"downloaded_bytes":sum(x.get("bytes",0) for x in results)}}
    MANIFEST.parent.mkdir(parents=True,exist_ok=True); MANIFEST.write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(manifest["summary"]))
    if manifest["summary"]["downloaded"]==0: raise SystemExit("No sources downloaded; check network and upstream availability.")
if __name__=="__main__": main()
