#!/usr/bin/env python3
"""Download historical football results and odds CSVs from Football-Data.co.uk.

The source covers many popular European leagues and seasons. It does not cover every
country or every match. Requests are bounded and missing seasons are recorded.
Check the provider's current terms before commercial use.
"""
from __future__ import annotations
import concurrent.futures
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "history" / "raw" / "football_data"
MANIFEST = ROOT / "data" / "history" / "football-data-manifest.json"
UA = "AshSportsAI/1.0 (historical-results research)" 
TIMEOUT = 8
LEAGUES = {
    "E0":"england-premier-league", "E1":"england-championship",
    "E2":"england-league-one", "E3":"england-league-two",
    "SC0":"scotland-premiership", "SC1":"scotland-championship",
    "D1":"germany-bundesliga", "D2":"germany-2-bundesliga",
    "I1":"italy-serie-a", "I2":"italy-serie-b",
    "SP1":"spain-la-liga", "SP2":"spain-segunda",
    "F1":"france-ligue-1", "F2":"france-ligue-2",
    "N1":"netherlands-eredivisie", "B1":"belgium-first-division",
    "P1":"portugal-primeira", "T1":"turkey-super-lig",
    "G1":"greece-super-league",
}
SEASONS = [f"{y%100:02d}{(y+1)%100:02d}" for y in range(2000, 2026)]


def download(item):
    code, league, season = item
    url = f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv"
    path = OUT / league / f"{season}_{code}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = resp.read()
        if not data or b"," not in data[:1000] or data[:100].lstrip().lower().startswith((b"<html", b"<!doctype html")):
            raise ValueError("not a CSV response")
        path.write_bytes(data)
        return {"league":league,"code":code,"season":season,"url":url,"path":str(path.relative_to(ROOT)),"bytes":len(data),"status":"ok"}
    except Exception as exc:
        return {"league":league,"code":code,"season":season,"url":url,"status":"unavailable","error":str(exc)[:160]}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    items = [(code, league, season) for season in SEASONS for code, league in LEAGUES.items()]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(download, items))
    manifest = {
        "generated_at_utc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
        "provider":"Football-Data.co.uk",
        "provider_url":"https://www.football-data.co.uk/",
        "coverage":"Selected European leagues, 2000/01 through 2025/26 where files exist",
        "contains":"Match results, statistics and bookmaker odds columns when supplied in each season file",
        "limitations":"Not global coverage; columns and bookmaker availability vary by season. No claim of full Arab-league coverage.",
        "licensing_note":"Review current provider terms before commercial use or redistribution.",
        "summary":{"requested":len(results),"downloaded":sum(r["status"]=="ok" for r in results),"unavailable":sum(r["status"]!="ok" for r in results),"bytes":sum(r.get("bytes",0) for r in results)},
        "sources":results,
    }
    MANIFEST.parent.mkdir(parents=True,exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(manifest["summary"]))
    if manifest["summary"]["downloaded"] == 0:
        raise SystemExit("No Football-Data CSVs downloaded")


if __name__ == "__main__":
    main()
