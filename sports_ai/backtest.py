#!/usr/bin/env python3
"""Leakage-safe chronological Elo backtest for Ash historical sports results.

Predictions are made before each match, then ratings are updated with that result.
Football draws update Elo at 0.5 but are excluded from binary winner metrics because
this baseline does not yet model a separate draw probability.
Tennis source rows store the winner as participant_a; the model still compares both
pre-match ratings and predicts whether participant_a was stronger.
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

START_RATING = 1500.0
K_FACTOR = 24.0
DEFAULT_WARMUP = 100
SPORTS = ("football", "tennis", "basketball")


def expected_score(rating_a: float, rating_b: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((rating_b - rating_a) / 400.0))


def _date_key(value: object) -> str:
    raw = str(value or "").strip()
    if len(raw) == 8 and raw.isdigit():
        return raw[:4] + "-" + raw[4:6] + "-" + raw[6:8]
    return raw[:10] if len(raw) >= 10 else "0000-00-00"


def run_backtest(rows, warmup: int = DEFAULT_WARMUP, k_factor: float = K_FACTOR) -> dict:
    ratings = {sport: {} for sport in SPORTS}
    seen = defaultdict(int)
    metrics = {
        sport: {
            "matches_seen": 0, "evaluated_matches": 0, "warmup_matches": 0,
            "draws_excluded": 0, "correct": 0, "brier_sum": 0.0,
            "log_loss_sum": 0.0, "bins": [{"count": 0, "probability_sum": 0.0, "actual_sum": 0.0} for _ in range(10)]
        } for sport in SPORTS
    }

    ordered = sorted(rows, key=lambda row: (_date_key(row.get("match_date")), int(row.get("id") or 0)))
    for row in ordered:
        sport = str(row.get("sport") or "").lower()
        if sport not in ratings:
            continue
        a, b = str(row.get("participant_a") or "").strip(), str(row.get("participant_b") or "").strip()
        try:
            score_a, score_b = float(row["score_a"]), float(row["score_b"])
        except (KeyError, TypeError, ValueError):
            continue
        if not a or not b or score_a == score_b and sport != "football":
            continue

        table = ratings[sport]
        rating_a = table.get(a, START_RATING)
        rating_b = table.get(b, START_RATING)
        probability_a = expected_score(rating_a, rating_b)
        result_a = 1.0 if score_a > score_b else 0.0 if score_a < score_b else 0.5
        metric = metrics[sport]
        metric["matches_seen"] += 1

        if seen[sport] < warmup:
            metric["warmup_matches"] += 1
        elif sport == "football" and result_a == 0.5:
            metric["draws_excluded"] += 1
        else:
            actual = 1.0 if result_a > 0.5 else 0.0
            clipped = min(max(probability_a, 1e-12), 1.0 - 1e-12)
            metric["evaluated_matches"] += 1
            metric["correct"] += int((probability_a >= 0.5) == (actual == 1.0))
            metric["brier_sum"] += (probability_a - actual) ** 2
            metric["log_loss_sum"] += -(actual * math.log(clipped) + (1.0 - actual) * math.log(1.0 - clipped))
            bin_index = min(9, int(probability_a * 10))
            metric["bins"][bin_index]["count"] += 1
            metric["bins"][bin_index]["probability_sum"] += probability_a
            metric["bins"][bin_index]["actual_sum"] += actual

        # Update only after scoring the pre-match prediction.
        table[a] = rating_a + k_factor * (result_a - probability_a)
        table[b] = rating_b + k_factor * ((1.0 - result_a) - (1.0 - probability_a))
        seen[sport] += 1

    output = {}
    for sport, metric in metrics.items():
        n = metric["evaluated_matches"]
        bins = []
        for index, item in enumerate(metric["bins"]):
            count = item["count"]
            if count:
                bins.append({
                    "range": f"{index / 10:.1f}-{(index + 1) / 10:.1f}",
                    "count": count,
                    "mean_predicted": round(item["probability_sum"] / count, 4),
                    "observed_rate": round(item["actual_sum"] / count, 4)
                })
        output[sport] = {
            "matches_seen": metric["matches_seen"],
            "warmup_matches": metric["warmup_matches"],
            "evaluated_matches": n,
            "draws_excluded": metric["draws_excluded"],
            "accuracy": round(metric["correct"] / n, 4) if n else None,
            "brier_score": round(metric["brier_sum"] / n, 4) if n else None,
            "log_loss": round(metric["log_loss_sum"] / n, 4) if n else None,
            "calibration_bins": bins
        }
    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "method": "Pre-match chronological Elo; equal 1500 starting rating; K=24; update after prediction; no odds or injury/lineup adjustments.",
        "warmup_matches_per_sport": warmup,
        "sports": output,
        "limitations": [
            "Historical results are not historical bookmaker odds.",
            "Football draws are excluded from binary winner metrics; a separate draw model is still needed.",
            "Tennis rows in the source archive place the winner first; accuracy evaluates whether pre-match Elo ranks that winner above the opponent.",
            "Results measure historical ranking quality, not guaranteed future performance or betting profitability."
        ]
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="data/history/ash_sports_history.sqlite")
    parser.add_argument("--output", default="data/history/backtest-report.json")
    parser.add_argument("--warmup", type=int, default=DEFAULT_WARMUP)
    args = parser.parse_args()
    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"History database not found: {db_path}")
    with sqlite3.connect(db_path) as connection:
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute(
            "SELECT id,sport,match_date,participant_a,participant_b,score_a,score_b FROM matches "
            "WHERE score_a IS NOT NULL AND score_b IS NOT NULL"
        )]
    report = run_backtest(rows, warmup=max(0, args.warmup))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({sport: {key: value for key, value in stats.items() if key != "calibration_bins"}
                      for sport, stats in report["sports"].items()}))
    if not any(stats["evaluated_matches"] for stats in report["sports"].values()):
        raise SystemExit("No evaluated historical matches; inspect imported history coverage.")


if __name__ == "__main__":
    main()
