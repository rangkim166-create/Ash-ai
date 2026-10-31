#!/usr/bin/env python3
"""Import NBA team-game results from the public stats mirror into Ash history SQLite."""
from __future__ import annotations
import json
import math
import sqlite3
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "history" / "raw" / "nba_team_logs"
DB = ROOT / "data" / "history" / "ash_sports_history.sqlite"
SEASONS = range(2010, 2028)
ALLOWED_GAME_TYPES = {"regular_season", "playoffs", "play_in", "cup_final"}


def clean_id(value):
    if pd.isna(value):
        return ""
    return str(value).removesuffix(".0").strip()


def clean_date(value):
    if pd.isna(value):
        return ""
    try:
        return pd.Timestamp(value).date().isoformat()
    except Exception:
        text = str(value).strip()
        return text[:10] if len(text) >= 10 else text


def as_int(value):
    if pd.isna(value):
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def main():
    if not DB.exists():
        raise SystemExit("SQLite database missing; run build_database.py first.")

    # team_id is a franchise identifier. Use its latest display name for all seasons,
    # so Bobcats/Hornets, Nets, Pelicans and other franchise renames share one Elo history.
    team_names = {}
    for season in SEASONS:
        path = RAW / "team_seasons" / "season_{}.parquet".format(season)
        if not path.exists():
            continue
        frame = pd.read_parquet(path)
        required = {"team_id", "full_name"}
        if not required.issubset(set(frame.columns)):
            raise SystemExit("team_seasons schema missing columns: {}".format(sorted(required - set(frame.columns))))
        for row in frame.to_dict("records"):
            if "is_nba" in row and not bool(row.get("is_nba")):
                continue
            team_id = clean_id(row.get("team_id"))
            full_name = str(row.get("full_name") or "").strip()
            if team_id and full_name:
                team_names[team_id] = (season, full_name)
    canonical_names = {team_id: item[1] for team_id, item in team_names.items()}
    if len(canonical_names) < 20:
        raise SystemExit("Too few NBA franchise names resolved from team_seasons.")

    imported = skipped = missing_seasons = 0
    seen = set()
    with sqlite3.connect(DB) as db:
        existing = {
            (clean_date(d), str(a).casefold(), str(b).casefold(), as_int(sa), as_int(sb))
            for d, a, b, sa, sb in db.execute(
                "SELECT match_date,participant_a,participant_b,score_a,score_b FROM matches WHERE sport='basketball'"
            )
        }
        for season in SEASONS:
            logs_path = RAW / "team_game_logs" / "season_{}.parquet".format(season)
            games_path = RAW / "games" / "season_{}.parquet".format(season)
            if not logs_path.exists() or not games_path.exists():
                missing_seasons += 1
                continue
            logs = pd.read_parquet(logs_path)
            games = pd.read_parquet(games_path)
            log_required = {"game_id", "team_id", "opp_team_id", "game_date", "pts"}
            game_required = {"game_id", "game_type"}
            if not log_required.issubset(set(logs.columns)):
                raise SystemExit("{} team_game_logs missing {}".format(season, sorted(log_required - set(logs.columns))))
            if not game_required.issubset(set(games.columns)):
                raise SystemExit("{} games missing {}".format(season, sorted(game_required - set(games.columns))))
            game_types = {
                clean_id(row.get("game_id")): str(row.get("game_type") or "").strip().casefold()
                for row in games.to_dict("records")
            }
            logs["game_id"] = logs["game_id"].map(clean_id)
            for game_id, group in logs.groupby("game_id", sort=False):
                if not game_id or game_types.get(game_id) not in ALLOWED_GAME_TYPES:
                    skipped += 1
                    continue
                rows = group.to_dict("records")
                # A completed NBA game normally has exactly one team row per side.
                unique = {}
                for row in rows:
                    team_id = clean_id(row.get("team_id"))
                    if team_id and team_id not in unique:
                        unique[team_id] = row
                if len(unique) != 2:
                    skipped += 1
                    continue
                pair = list(unique.values())
                home_rows = [row for row in pair if "home" in row and not pd.isna(row.get("home")) and bool(row.get("home"))]
                team_a = home_rows[0] if len(home_rows) == 1 else pair[0]
                team_b = pair[1] if pair[0] is team_a else pair[0]
                id_a, id_b = clean_id(team_a.get("team_id")), clean_id(team_b.get("team_id"))
                if clean_id(team_a.get("opp_team_id")) != id_b or clean_id(team_b.get("opp_team_id")) != id_a:
                    skipped += 1
                    continue
                name_a, name_b = canonical_names.get(id_a), canonical_names.get(id_b)
                score_a, score_b = as_int(team_a.get("pts")), as_int(team_b.get("pts"))
                match_date = clean_date(team_a.get("game_date") or team_b.get("game_date"))
                if not name_a or not name_b or not match_date or score_a is None or score_b is None:
                    skipped += 1
                    continue
                key = (match_date, name_a.casefold(), name_b.casefold(), score_a, score_b)
                reverse = (match_date, name_b.casefold(), name_a.casefold(), score_b, score_a)
                if key in existing or reverse in existing or key in seen or reverse in seen:
                    skipped += 1
                    continue
                seen.add(key)
                game_type = game_types[game_id]
                winner = name_a if score_a > score_b else name_b if score_b > score_a else "draw"
                db.execute(
                    "INSERT INTO matches(sport,competition,season,match_date,participant_a,participant_b,score_a,score_b,winner,source,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    ("basketball", "NBA " + game_type.replace("_", " "), str(season), match_date,
                     name_a, name_b, score_a, score_b, winner,
                     "llimllib/nba_data:stats/team_game_logs",
                     json.dumps({"game_id": game_id, "team_ids": [id_a, id_b], "game_type": game_type}, ensure_ascii=False))
                )
                imported += 1
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('nba_team_results_imported',?)", (str(imported),))
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('nba_team_results_skipped',?)", (str(skipped),))
        db.commit()
        counts = dict(db.execute("SELECT sport,COUNT(*) FROM matches GROUP BY sport").fetchall())
    print(json.dumps({
        "nba_seasons_attempted": len(list(SEASONS)),
        "nba_matches_imported": imported,
        "nba_rows_skipped": skipped,
        "nba_seasons_missing_required_files": missing_seasons,
        "nba_franchises_mapped": len(canonical_names),
        "database_counts": counts
    }))
    if imported == 0:
        raise SystemExit("No NBA games imported. Check parquet paths, schemas and game-type values.")


if __name__ == "__main__":
    main()
