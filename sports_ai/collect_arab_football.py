#!/usr/bin/env python3
"""Fetch the public-domain OpenFootball world archive for additional regional leagues.

This is a source-acquisition helper, not a promise that every Arab league is covered.
It saves the archive and reports which country/season text files are present so the
normalizer can be extended against verified source schemas.
"""
from __future__ import annotations
import json
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "history" / "raw" / "football_world"
URL = "https://codeload.github.com/openfootball/world/zip/refs/heads/master"
UA = "AshSportsAI regional football archive/1.0"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    archive = OUT / "openfootball-world.zip"
    request = urllib.request.Request(URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = response.read()
    if not payload.startswith(b"PK"):
        raise SystemExit("OpenFootball archive URL did not return a ZIP file")
    archive.write_bytes(payload)
    with zipfile.ZipFile(archive) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith((".txt", ".md"))]
        # Only extract the public data text files; ignore repository metadata and binaries.
        extracted = []
        for name in names:
            parts = Path(name).parts
            if len(parts) < 3 or "/.git/" in name:
                continue
            target = OUT / "unpacked" / Path(*parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(name))
            extracted.append(str(target.relative_to(ROOT)))
    manifest = {
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": URL,
        "archive": str(archive.relative_to(ROOT)),
        "archive_bytes": len(payload),
        "text_files_extracted": len(extracted),
        "regional_targets": ["Egypt", "Morocco", "Algeria", "Nigeria", "Japan", "China", "Australia", "MLS"],
        "note": "This source does not guarantee Saudi Pro League, Qatar Stars League, or UAE Pro League history. Text files are preserved for schema-specific normalization; they are not counted as database matches yet."
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
