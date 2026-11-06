import unittest

from backtest import run_backtest


class ChronologicalBacktestTests(unittest.TestCase):
    def test_prediction_is_scored_before_rating_update(self):
        rows = [
            {"id": 1, "sport": "tennis", "match_date": "2020-01-01", "participant_a": "A", "participant_b": "B", "score_a": 1, "score_b": 0},
            {"id": 2, "sport": "tennis", "match_date": "2020-01-02", "participant_a": "A", "participant_b": "B", "score_a": 1, "score_b": 0},
        ]
        report = run_backtest(rows, warmup=0)
        tennis = report["sports"]["tennis"]
        self.assertEqual(tennis["evaluated_matches"], 2)
        self.assertEqual(tennis["accuracy"], 1.0)
        self.assertGreater(tennis["calibration_bins"][0]["count"], 0)

    def test_football_draw_updates_ratings_but_is_excluded_from_binary_metrics(self):
        rows = [
            {"id": 1, "sport": "football", "match_date": "2020-01-01", "participant_a": "A", "participant_b": "B", "score_a": 1, "score_b": 1},
            {"id": 2, "sport": "football", "match_date": "2020-01-02", "participant_a": "A", "participant_b": "B", "score_a": 2, "score_b": 0},
        ]
        report = run_backtest(rows, warmup=0)
        football = report["sports"]["football"]
        self.assertEqual(football["draws_excluded"], 1)
        self.assertEqual(football["evaluated_matches"], 1)

    def test_warmup_matches_are_not_used_in_metrics(self):
        rows = [
            {"id": 1, "sport": "basketball", "match_date": "2020-01-01", "participant_a": "A", "participant_b": "B", "score_a": 100, "score_b": 90},
            {"id": 2, "sport": "basketball", "match_date": "2020-01-02", "participant_a": "A", "participant_b": "B", "score_a": 100, "score_b": 90},
        ]
        report = run_backtest(rows, warmup=1)
        basketball = report["sports"]["basketball"]
        self.assertEqual(basketball["warmup_matches"], 1)
        self.assertEqual(basketball["evaluated_matches"], 1)


if __name__ == "__main__":
    unittest.main()
