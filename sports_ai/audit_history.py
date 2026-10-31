#!/usr/bin/env python3
"""Build a compact coverage audit and explicitly list Arab leagues not detected."""
from __future__ import annotations
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"
OUT = ROOT / "data" / "history" / "coverage-report.json"
TARGETS = {
    "arab_football": [
        {"name": "Saudi Pro League", "exact": ["saudi arabia", "saudi pro league"], "prefixes": ["saudi pro league ", "saudi arabia saudi professional league "]},
        {"name": "Egyptian Premier League", "exact": ["egypt", "egyptian premier league", "egyptian premiership"], "prefixes": ["egyptian premier league ", "egypt premiership "]},
        {"name": "Moroccan Botola", "exact": ["morocco", "moroccan botola", "botola pro"], "prefixes": ["moroccan botola ", "botola pro ", "morocco botola pro "]},
        {"name": "Algerian Ligue 1", "exact": ["algeria", "algerian ligue 1"], "prefixes": ["algerian ligue 1 ", "algeria ligue 1 "]},
        {"name": "Qatar Stars League", "exact": ["qatar", "qatar stars league"], "prefixes": ["qatar stars league "]},
        {"name": "UAE Pro League", "exact": ["united arab emirates", "uae pro league", "uae league"], "prefixes": ["uae pro league "]},
        {"name": "Nigerian Premier Football League", "exact": ["nigeria", "nigeria professional league"], "prefixes": ["nigeria professional league "]},
        {"name": "Tunisian Ligue 1", "exact": ["tunisia", "tunisian ligue 1"], "prefixes": ["tunisian ligue 1 "]},
    ],
    "popular_europe": [
        {"name": "English Premier League", "exact": ["england", "english premier league"], "prefixes": ["english premier league "]},
        {"name": "English Championship", "exact": ["english championship"], "prefixes": ["english championship "]},
        {"name": "German Bundesliga", "exact": ["germany", "german bundesliga"], "prefixes": ["german bundesliga "]},
        {"name": "Spanish La Liga", "exact": ["spain", "spanish la liga"], "prefixes": ["spanish la liga "]},
        {"name": "Italian Serie A", "exact": ["italy", "italian serie a"], "prefixes": ["italian serie a "]},
        {"name": "French Ligue 1", "exact": ["france", "french ligue 1"], "prefixes": ["french ligue 1 "]},
        {"name": "Dutch Eredivisie", "exact": ["netherlands", "dutch eredivisie"], "prefixes": ["netherlands eredivisie ", "dutch eredivisie "]},
        {"name": "Portuguese Primeira Liga", "exact": ["portugal", "portuguese primeira liga"], "prefixes": ["portuguese primeira liga "]},
        {"name": "Scottish Premiership", "exact": ["scotland", "scottish premiership"], "prefixes": ["scottish premiership "]},
    ],
}


def normalize_competition(value: str) -> str:
    return " ".join(str(value or "").casefold().replace("-", " ").replace("_", " ").split())


def is_target_competition(value: str, target: dict) -> bool:
    normalized = normalize_competition(value)
    if normalized in {normalize_competition(item) for item in target["exact"]}:
        return True
    return any(normalized.startswith(normalize_competition(prefix)) for prefix in target["prefixes"])



def main():
    if not DB.exists():
        raise SystemExit("History database not found.")
    with sqlite3.connect(DB) as db:
        by_sport = [
            {"sport": sport, "matches": count}
            for sport, count in db.execute(
                "SELECT sport, COUNT(*) FROM matches GROUP BY sport ORDER BY sport"
            )
        ]
        all_competitions = [
            {"sport": sport, "competition": str(comp or "unknown"), "matches": count,
             "first_date": first, "last_date": last}
            for sport, comp, count, first, last in db.execute(
                "SELECT sport, COALESCE(competition,'unknown'), COUNT(*), "
                "MIN(NULLIF(match_date,'')), MAX(NULLIF(match_date,'')) "
                "FROM matches GROUP BY sport, competition ORDER BY COUNT(*) DESC"
            )
        ]
        season_counts = [
            {"sport": sport, "year": year, "matches": count}
            for sport, year, count in db.execute(
                "SELECT sport, substr(COALESCE(NULLIF(season,''), NULLIF(match_date,''), 'unknown'),1,4) AS year, COUNT(*) "
                "FROM matches GROUP BY sport, substr(COALESCE(NULLIF(season,''), NULLIF(match_date,''), 'unknown'),1,4) "
                "ORDER BY sport, year"
            )
        ]
        metadata = dict(db.execute("SELECT key,value FROM metadata").fetchall())

    target_report = {}
    for group, items in TARGETS.items():
        target_report[group] = []
        for target in items:
            matched = [
                item for item in all_competitions
                if is_target_competition(item["competition"], target)
            ]
            target_report[group].append({
                "target": target["name"],
                "detected": bool(matched),
                "matched_competitions": [item["competition"] for item in matched[:15]],
                "matches_found": sum(item["matches"] for item in matched),
            })

    total = sum(item["matches"] for item in by_sport)
    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "completeness": "best_effort_not_exhaustive",
        "summary": {
            "total_matches": total,
            "by_sport": by_sport,
            "competition_groups": len(all_competitions),
            "reported_competitions": min(500, len(all_competitions)),
            "competition_counts_truncated": len(all_competitions) > 500,
        },
        "target_coverage": target_report,
        "top_competitions": all_competitions[:500],
        "match_counts_by_sport_and_year": season_counts,
        "pipeline_metadata": metadata,
        "warnings": [
            "Detected competition names do not prove every season is complete.",
            "A missing target means its name was not detected in this dataset; inspect source manifests.",
            "This dataset is not every match worldwide and does not contain complete historical odds for every league.",
            "Old global football records can contain errors or inconsistent team identities.",
            "Elo scores and probabilities are estimates, not guaranteed outcomes.",
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "total_matches": total,
        "by_sport": by_sport,
        "competitions": len(all_competitions),
        "missing_targets": {
            group: [item["target"] for item in values if not item["detected"]]
            for group, values in target_report.items()
        },
    }))
    if total == 0:
        raise SystemExit("No match records found in coverage audit.")


if __name__ == "__main__":
    main()
