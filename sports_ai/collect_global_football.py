#!/usr/bin/env python3
"""Download the ODC-BY licensed global football results archive.

Upstream documents 1.2M+ results across 207 domestic leagues and 20 international
tournaments (1888-2023). This is broad coverage, not a guarantee of every match.
"""
from __future__ import annotations
import json
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "history" / "raw" / "global_football"
URL = "https://codeload.github.com/schochastics/football-data/zip/refs/heads/master"
UA = "AshSportsAI global football archive collector/1.0"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    archive = OUT / "schochastics-football-data.zip"
    request = urllib.request.Request(URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = response.read()
    if not payload.startswith(b"PK"):
        raise SystemExit("Global football source did not return a ZIP archive")
    archive.write_bytes(payload)
    candidates = []
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            if info.is_dir() or not info.filename.lower().endswith(".parquet"):
                continue
            low = info.filename.lower()
            if "/data/results" in low or low.endswith("results.parquet") or "result" in Path(low).name:
                candidates.append(info)
        if not candidates:
            raise SystemExit("No global match-results parquet found in source archive; inspect upstream schema.")
        # Prefer the explicit data/results parquet file; preserve other candidates only if needed.
        candidates.sort(key=lambda i: (0 if "/data/results" in i.filename.lower() else 1, -i.file_size))
        selected = candidates[0]
        target = OUT / "global-football-results.parquet"
        target.write_bytes(zf.read(selected))
    manifest = {
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": URL,
        "repository": "https://github.com/schochastics/football-data",
        "source_file": selected.filename,
        "archive_bytes": len(payload),
        "parquet_bytes": target.stat().st_size,
        "license": "Open Data Commons Attribution License (ODC-BY 1.0); provide attribution and follow license terms.",
        "upstream_coverage": "1,237,935 football matches across 207 domestic leagues and 20 international tournaments, 1888-2023 (upstream README; coverage may vary by competition).",
        "note": "Historical data can contain old-record errors and inconsistent team identities; inspect coverage report."
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest))
    

if __name__ == "__main__":
    main()
