import tempfile
import unittest
from pathlib import Path

from football_txt_parser import parse_football_txt


class FootballTxtParserTests(unittest.TestCase):
    def parse(self, body):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "2024-25" / "1-premierleague.txt"
            path.parent.mkdir(parents=True)
            path.write_text(body, encoding="utf-8")
            return list(parse_football_txt(path))

    def test_date_heading_and_middle_score_layout(self):
        rows = self.parse("Sat Aug 17\n12:30  Arsenal 2-1 Leicester City\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["date"], "2024-08-17")
        self.assertEqual((rows[0]["home"], rows[0]["away"]), ("Arsenal", "Leicester City"))
        self.assertEqual((rows[0]["home_score"], rows[0]["away_score"]), (2, 1))

    def test_date_heading_and_v_layout(self):
        rows = self.parse("Sun Jan 12\nLiverpool v Brentford 3-0\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["date"], "2025-01-12")
        self.assertEqual(rows[0]["home_score"], 3)

    def test_day_month_date_heading(self):
        rows = self.parse("Sat 17 Aug\n12:30 Arsenal 1-0 Wolves\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["date"], "2024-08-17")

    def test_iso_date_inline(self):
        rows = self.parse("2024-10-05 15:00 Team A 0-0 Team B\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["date"], "2024-10-05")

    def test_unscored_fixture_is_skipped(self):
        rows = self.parse("Sat Aug 17\n15:00 Arsenal v Leicester City\n")
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
