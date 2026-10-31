#!/usr/bin/env python3
"""Normalize downloaded football, tennis and NBA team game logs into SQLite."""
import csv
import io
import json
import sqlite3
import tarfile
from pathlib import Path
from datetime import datetime, timezone
from football_txt_parser import parse_football_txt

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "history" / "raw"
OUT = ROOT / "data" / "history" / "ash_sports_history.sqlite"


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()
    db = sqlite3.connect(OUT)
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("""CREATE TABLE matches(
        id INTEGER PRIMARY KEY, sport TEXT NOT NULL, competition TEXT, season TEXT,
        match_date TEXT, participant_a TEXT NOT NULL, participant_b TEXT NOT NULL,
        score_a REAL, score_b REAL, winner TEXT, source TEXT NOT NULL, raw_json TEXT
    )""")
    db.execute("CREATE INDEX idx_matches_sport_date ON matches(sport, match_date)")
    db.execute("CREATE INDEX idx_matches_participants ON matches(participant_a, participant_b)")
    count = {"football": 0, "tennis": 0, "basketball": 0}

    def add(sport, competition, season, date, a, b, sa, sb, winner, source, raw=None):
        if not a or not b:
            return
        db.execute(
            "INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (sport, competition, season, date, str(a), str(b), sa, sb, winner, source,
             json.dumps(raw, ensure_ascii=False) if raw is not None else None),
        )
        count[sport] += 1

    for p in sorted((RAW / "football").glob("*/*.json")):
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
            competition = obj.get("name", p.parent.name)
            for m in obj.get("matches", []):
                score_data = m.get("score")
                sc = score_data.get("ft") if isinstance(score_data, dict) else score_data if isinstance(score_data, list) else None
                if not sc or len(sc) < 2 or sc[0] is None or sc[1] is None:
                    continue
                a, b = m.get("team1"), m.get("team2")
                winner = a if sc[0] > sc[1] else b if sc[1] > sc[0] else "draw"
                add("football", competition, p.stem, m.get("date"), a, b,
                    float(sc[0]), float(sc[1]), winner, str(p.relative_to(ROOT)), m)
        except (OSError, ValueError, TypeError):
            continue

    for p in sorted((RAW / "tennis").glob("*/*.csv")):
        try:
            with p.open(encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    winner = row.get("winner_name") or row.get("Winner") or row.get("winner")
                    loser = row.get("loser_name") or row.get("Loser") or row.get("loser")
                    if not winner or not loser:
                        continue
                    date = row.get("tourney_date") or row.get("Date") or row.get("date")
                    date = str(date) if date else p.stem[-4:]
                    add("tennis", row.get("tourney_name") or row.get("Tournament") or p.parent.name,
                        p.stem[-4:], date, winner, loser, 1.0, 0.0, winner,
                        str(p.relative_to(ROOT)), row)
        except (OSError, UnicodeError, csv.Error):
            continue

    # NBA team game-log files contain two rows per GAME_ID: one row per team.
    for p in sorted((RAW / "basketball").glob("*.tar.xz")):
        try:
            with tarfile.open(p, mode="r:xz") as archive:
                members = [m for m in archive.getmembers() if m.isfile() and m.name.lower().endswith(".csv")]
                if not members:
                    continue
                member = members[0]
                stream = archive.extractfile(member)
                if stream is None:
                    continue
                rows = list(csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig", errors="replace")))
                grouped = {}
                for row in rows:
                    low = {str(k).lower().strip(): v for k, v in row.items() if k is not None}
                    game_id = low.get("game_id") or low.get("gameid")
                    team = low.get("team_name") or low.get("team") or low.get("team_abbreviation")
                    points = low.get("pts") or low.get("points") or low.get("team_score")
                    date = low.get("game_date") or low.get("date")
                    if not game_id or not team or points in (None, ""):
                        continue
                    try:
                        points = float(points)
                    except (TypeError, ValueError):
                        continue
                    grouped.setdefault(game_id, []).append({
                        "team": team, "points": points, "date": date, "raw": low
                    })
                for game_id, teams in grouped.items():
                    if len(teams) < 2:
                        continue
                    # De-duplicate possible repeated rows while preserving team order.
                    unique = []
                    seen = set()
                    for team in teams:
                        if team["team"] not in seen:
                            seen.add(team["team"])
                            unique.append(team)
                    if len(unique) < 2:
                        continue
                    a, b = unique[0], unique[1]
                    winner = a["team"] if a["points"] > b["points"] else b["team"] if b["points"] > a["points"] else "draw"
                    season = p.stem.split("_")[-1]
                    add("basketball", "NBA", season, a["date"] or b["date"],
                        a["team"], b["team"], a["points"], b["points"], winner,
                        f"{p.name}:{member.name}", {"game_id": game_id, "team_a": a["raw"], "team_b": b["raw"]})
        except (OSError, tarfile.TarError, csv.Error, UnicodeError):
            continue

    # Normalize the CC0 OpenFootball world archive (Africa/Asia/Middle East etc.).
    # The parser is deliberately conservative: only dated rows with a clear final score
    # enter the ratings database. The raw archive and skipped rows remain auditable.
    regional_counts = {}
    regional_root = RAW / "football_world" / "unpacked"
    if regional_root.exists():
        for p in sorted(regional_root.rglob("*.txt")):
            try:
                relative = p.relative_to(regional_root)
            except ValueError:
                continue
            parts = relative.parts
            if len(parts) < 2:
                continue
            competition = " / ".join(parts[:-1])
            season_match = __import__("re").search(r"(20\\d{2}(?:-\\d{2})?)", str(relative))
            season = season_match.group(1) if season_match else "unknown"
            for match in parse_football_txt(p):
                home_score, away_score = match["home_score"], match["away_score"]
                winner = match["home"] if home_score > away_score else match["away"] if away_score > home_score else "draw"
                add("football", competition, season, match["date"], match["home"], match["away"],
                    float(home_score), float(away_score), winner,
                    str(p.relative_to(ROOT)), match)
                regional_counts[competition] = regional_counts.get(competition, 0) + 1

    db.commit()
    total = db.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
    by_sport = dict(db.execute("SELECT sport, COUNT(*) FROM matches GROUP BY sport").fetchall())
    db.execute("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    metadata = {
        "built_at_utc": datetime.now(timezone.utc).isoformat(),
        "total_matches": str(total),
        "counts_by_sport": json.dumps(by_sport),
        "warning": "Coverage depends on upstream datasets; not all global matches or historical odds are included.",\n        "regional_football_txt_counts": json.dumps(regional_counts, sort_keys=True),
    }
    db.executemany("INSERT INTO metadata VALUES(?,?)", metadata.items())
    db.commit()
    db.close()
    print(json.dumps({"database": str(OUT.relative_to(ROOT)), "total_matches": total, "counts_by_sport": by_sport}))
    if total == 0:
        raise SystemExit("No normalized matches were found; inspect the manifest and source schemas.")


if __name__ == "__main__":
    main()
