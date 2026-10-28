#!/usr/bin/env python3
"""Download public historical results for Ash Sports AI.

Sources are best-effort mirrors; unavailable seasons are recorded in the manifest.
The collector intentionally downloads compact NBA team game logs, not huge play-by-play archives.
"""
from __future__ import annotations
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "history" / "raw"
MANIFEST = ROOT / "data" / "history" / "full-history-manifest.json"
UA = "AshSportsAI historical data collector/0.3"
TIMEOUT = 25


def fetch(url: str, target: Path) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            data = response.read()
        if not data:
            raise ValueError("empty response")
        # Avoid retaining an HTML error page as if it were a data file.
        if data[:100].lstrip().lower().startswith((b"<!doctype html", b"<html")):
            raise ValueError("source returned HTML instead of data")
        target.write_bytes(data)
        return {"url": url, "path": str(target.relative_to(ROOT)), "bytes": len(data), "status": "ok"}
    except Exception as exc:
        return {"url": url, "path": str(target.relative_to(ROOT)), "status": "unavailable", "error": str(exc)[:240]}


def main() -> None:
    results = []
    leagues = {
        "england-premier-league": "en.1.json", "england-championship": "en.2.json",
        "germany-bundesliga": "de.1.json", "germany-2-bundesliga": "de.2.json",
        "spain-la-liga": "es.1.json", "spain-segunda": "es.2.json",
        "italy-serie-a": "it.1.json", "italy-serie-b": "it.2.json",
        "france-ligue-1": "fr.1.json", "france-ligue-2": "fr.2.json",
        "netherlands-eredivisie": "nl.1.json", "portugal-primeira": "pt.1.json",
        "scotland-premiership": "sc.1.json", "usa-mls": "us.1.json",
        "brazil-serie-a": "br.1.json", "world-cup": "world.cup.json",
        "europe-euro": "europe.euro.json",
    }
    # OpenFootball is a free public-domain source; gaps vary by competition.
    for start in range(2000, 2027):
        season = f"{start}-{(start + 1) % 100:02d}"
        for league, filename in leagues.items():
            url = f"https://raw.githubusercontent.com/openfootball/football.json/master/{season}/{filename}"
            results.append(fetch(url, RAW / "football" / league / f"{season}.json"))
            time.sleep(0.015)

    # The original Jeff Sackmann repositories were taken offline. Use a public archive mirror.
    for tour in ("atp", "wta"):
        for year in range(1968, 2027):
            name = f"{tour}_matches_{year}.csv"
            url = f"https://raw.githubusercontent.com/Aneeshers/tennis-sackmann-archive/main/{tour}/{name}"
            results.append(fetch(url, RAW / "tennis" / tour / name))
            time.sleep(0.015)

    # Compact team game logs cover regular season + playoffs from 1996/97 onwards.
    # Each archive contains a CSV named like its archive key.
    nba_root = "https://raw.githubusercontent.com/shufinskiy/nba_data/main/datasets"
    for year in range(1996, 2026):
        for key in (f"nbastats_{year}", f"nbastats_po_{year}"):
            url = f"{nba_root}/{key}.tar.xz"
            results.append(fetch(url, RAW / "basketball" / f"{key}.tar.xz"))
            time.sleep(0.015)

    manifest = {
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "coverage_note": (
            "Best-effort public historical results, not every match ever played. Missing upstream seasons are expected. "
            "NBA source is team game logs; tennis mirror retains the original non-commercial CC BY-NC-SA terms. "
            "Results are not historical betting odds."
        ),
        "sources": results,
        "summary": {
            "downloaded": sum(x["status"] == "ok" for x in results),
            "unavailable": sum(x["status"] != "ok" for x in results),
            "downloaded_bytes": sum(x.get("bytes", 0) for x in results),
        },
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest["summary"]))
    if manifest["summary"]["downloaded"] == 0:
        raise SystemExit("No sources downloaded; check network and upstream availability.")


if __name__ == "__main__":
    main()
