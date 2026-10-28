#!/usr/bin/env python3
"""Fetch Football-Data historical results and odds CSVs concurrently.

Coverage is best-effort. CSV rows are kept with their original columns so available
bookmaker odds can be audited later. Check the provider's current terms before use.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "data" / "history" / "raw" / "football_data"
MANIFEST = ROOT / "data" / "history" / "football-data-manifest.json"
UA = "AshSportsAI football history collector/1.0"
TIMEOUT = 15
LEAGUES = {
    "E0": "england-premier-league", "E1": "england-championship",
    "E2": "england-league-one", "E3": "england-league-two",
    "SC0": "scotland-premiership", "SC1": "scotland-championship",
    "D1": "germany-bundesliga", "D2": "germany-2-bundesliga",
    "I1": "italy-serie-a", "I2": "italy-serie-b",
    "SP1": "spain-la-liga", "SP2": "spain-segunda",
    "F1": "france-ligue-1", "F2": "france-ligue-2",
    "N1": "netherlands-eredivisie", "B1": "belgium-first-division",
    "P1": "portugal-primeira", "T1": "turkey-super-lig",
    "G1": "greece-super-league",
}


def fetch(item):
    url, target, league, season = item
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            data = response.read()
        if not data or data[:100].lstrip().lower().startswith((b"<!doctype html", b"<html")):
            raise ValueError("source returned no CSV data")
        head = data[:2000].lower()
        if b"hometeam" not in head or b"awayteam" not in head:
            raise ValueError("CSV header does not contain HomeTeam/AwayTeam")
        target.write_bytes(data)
        return {"url": url, "path": str(target.relative_to(ROOT)), "league": league,
                "season": season, "bytes": len(data), "status": "ok"}
    except Exception as exc:
        return {"url": url, "league": league, "season": season, "status": "unavailable",
                "error": str(exc)[:180]}


def main():
    BASE.mkdir(parents=True, exist_ok=True)
    tasks = []
    for start in range(2000, 2027):
        season = f"{start % 100:02d}{(start + 1) % 100:02d}"
        for code, league in LEAGUES.items():
            url = f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv"
            target = BASE / league / f"{season}_{code}.csv"
            tasks.append((url, target, league, season))
    results = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(fetch, item) for item in tasks]
        for future in as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda x: (x.get("league", ""), x.get("season", "")))
    manifest = {
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provider": "Football-Data.co.uk",
        "coverage_note": "Selected European divisions, 2000/01 through 2026/27 where files exist. Coverage and bookmaker odds vary by league and season.",
        "terms_note": "Review provider terms before commercial use or redistribution.",
        "summary": {
            "requested": len(tasks),
            "downloaded": sum(x["status"] == "ok" for x in results),
            "unavailable": sum(x["status"] != "ok" for x in results),
            "downloaded_bytes": sum(x.get("bytes", 0) for x in results),
        },
        "sources": results,
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest["summary"]))
    if manifest["summary"]["downloaded"] == 0:
        print("No Football-Data files were available; other result sources can still be used.")


if __name__ == "__main__":
    main()
