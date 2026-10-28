#!/usr/bin/env python3
"""Download public historical sports results for Ash Sports AI."""
from __future__ import annotations
import json, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "history" / "raw"
MANIFEST = ROOT / "data" / "history" / "manifest.json"
UA = "AshSportsAI/0.1 (historical sports research)"

def fetch(url: str, target: Path) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=35) as response:
            payload = response.read()
        if not payload:
            raise ValueError("empty response")
        target.write_bytes(payload)
        return {"url": url, "path": str(target.relative_to(ROOT)), "bytes": len(payload), "status": "ok"}
    except Exception as exc:
        return {"url": url, "path": str(target.relative_to(ROOT)), "status": "error", "error": str(exc)}

def main() -> None:
    results = []
    leagues = {
        "england-premier-league": "en.1.json",
        "spain-la-liga": "es.1.json",
        "germany-bundesliga": "de.1.json",
        "italy-serie-a": "it.1.json",
        "france-ligue-1": "fr.1.json",
    }
    # Public-domain OpenFootball fixtures and results.
    for season in ("2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26", "2026-27"):
        for league, filename in leagues.items():
            url = f"https://raw.githubusercontent.com/openfootball/football.json/master/{season}/{filename}"
            results.append(fetch(url, RAW / "football" / league / f"{season}.json"))
            time.sleep(0.1)
    # Jeff Sackmann ATP/WTA result CSVs. Review upstream CC BY-NC-SA terms
    # before commercial use.
    for tour in ("atp", "wta"):
        for year in range(2015, 2027):
            url = f"https://raw.githubusercontent.com/JeffSackmann/tennis_{tour}/master/{tour}_matches_{year}.csv"
            results.append(fetch(url, RAW / "tennis" / tour / f"{tour}_matches_{year}.csv"))
            time.sleep(0.1)
    # BoxScore Lab NBA team-game CSVs, CC BY 4.0; preserve attribution.
    for season in ("2022-23", "2023-24", "2024-25", "2025-26", "2026-27"):
        url = f"https://boxscorelab.com/downloads/{season}-team-game-results.csv"
        results.append(fetch(url, RAW / "basketball" / f"{season}-team-game-results.csv"))
        time.sleep(0.1)
    manifest = {
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": "Only status=ok entries downloaded; source gaps are recorded, not fabricated.",
        "sources": results,
        "summary": {"ok": sum(x["status"] == "ok" for x in results),
                    "errors": sum(x["status"] != "ok" for x in results)}
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest["summary"]))
    if manifest["summary"]["ok"] == 0:
        raise SystemExit("No historical datasets downloaded successfully.")

if __name__ == "__main__":
    main()
