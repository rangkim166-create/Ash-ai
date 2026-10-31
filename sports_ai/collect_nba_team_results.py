#!/usr/bin/env python3
"""Download compact NBA team-game logs and lookup tables from the stats mirror."""
from __future__ import annotations
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "history" / "raw" / "nba_team_logs"
BASE = "https://basketball-data.billmill.org/nba/stats"
SEASONS = range(2010, 2028)
DATASETS = ("team_game_logs", "team_seasons", "games")
UA = "AshSportsAI/1.0 historical NBA results collector"


def fetch(url: str, target: Path) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/octet-stream"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read()
            status = response.status
        if status != 200 or not data:
            raise ValueError("empty or non-200 response")
        if data[:100].lstrip().lower().startswith((b"<!doctype html", b"<html")):
            raise ValueError("server returned HTML instead of Parquet")
        target.write_bytes(data)
        return {"url": url, "path": str(target.relative_to(ROOT)), "bytes": len(data), "status": "ok"}
    except urllib.error.HTTPError as error:
        return {"url": url, "path": str(target.relative_to(ROOT)), "status": "unavailable",
                "error": "HTTP {}".format(error.code)}
    except Exception as error:
        return {"url": url, "path": str(target.relative_to(ROOT)), "status": "unavailable",
                "error": str(error)[:220]}


def main() -> None:
    results = []
    for season in SEASONS:
        for dataset in DATASETS:
            url = "{}/{}/season={}/data.parquet".format(BASE, dataset, season)
            target = OUT / dataset / "season_{}.parquet".format(season)
            results.append(fetch(url, target))
            time.sleep(0.08)
    good_logs = [item for item in results if item["status"] == "ok" and "/team_game_logs/" in item["path"]]
    manifest = {
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "llimllib/nba_data v2 stats.nba.com team_game_logs",
        "source_url": "https://github.com/llimllib/nba_data",
        "dataset_base": BASE,
        "seasons_attempted": list(SEASONS),
        "license_note": "The source repository does not publish an explicit dataset reuse license. This archive is not commercially cleared; confirm terms with the source maintainer before commercial redistribution or use.",
        "files": results,
        "summary": {
            "downloaded": sum(item["status"] == "ok" for item in results),
            "unavailable": sum(item["status"] != "ok" for item in results),
            "team_game_log_seasons": len(good_logs),
            "downloaded_bytes": sum(item.get("bytes", 0) for item in results),
        },
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest["summary"]))
    if not good_logs:
        raise SystemExit("No NBA team-game log seasons downloaded; check the dataset paths and source status.")


if __name__ == "__main__":
    main()
