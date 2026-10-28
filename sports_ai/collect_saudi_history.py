#!/usr/bin/env python3
"""Download public Saudi Pro League historical CSV archive for research.

The upstream repository does not state a clear reuse license in its README. Keep
attribution/source metadata and obtain permission before commercial redistribution.
"""
from __future__ import annotations
import json
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "history" / "raw" / "arab_football" / "saudi"
URL = "https://codeload.github.com/alioh/Saudi-Professional-League-Datasets/zip/refs/heads/master"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    archive = OUT / "saudi-pro-league.zip"
    request = urllib.request.Request(URL, headers={"User-Agent":"AshSportsAI historical research"})
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = response.read()
    if not payload.startswith(b"PK"):
        raise SystemExit("Saudi dataset source did not return a ZIP archive")
    archive.write_bytes(payload)
    files=[]
    with zipfile.ZipFile(archive) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(".csv") or name.endswith("/"):
                continue
            target=OUT / "csv" / Path(name).name
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(zf.read(name))
            files.append(str(target.relative_to(ROOT)))
    manifest={
        "generated_at_utc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
        "source":URL,
        "source_readme":"https://github.com/alioh/Saudi-Professional-League-Datasets",
        "archive_bytes":len(payload),
        "csv_files_extracted":len(files),
        "coverage_note":"Upstream describes Saudi Professional League results since 2000; actual coverage is limited to files present in this archive.",
        "license_note":"No clear license was found in the upstream README. Do not redistribute or use commercially without permission.",
        "files":files
    }
    (OUT/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"csv_files_extracted":len(files),"archive_bytes":len(payload)}))
    if not files:
        raise SystemExit("Saudi archive contained no CSV files")


if __name__=="__main__":
    main()
