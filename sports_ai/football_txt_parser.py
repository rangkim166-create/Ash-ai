"""Conservative parser for OpenFootball Football.TXT regional match results.

Only rows with an identifiable date, two teams and an unambiguous full-time score
are emitted. Ambiguous lines are skipped rather than guessed.
"""
from __future__ import annotations
import re
from datetime import date
from pathlib import Path

SCORE = r"(\d{1,2})\s*[-:]\s*(\d{1,2})"
DATE_PATTERNS = (
    re.compile(r"(?P<y>20\d{2})-(?P<m>\d{1,2})-(?P<d>\d{1,2})"),
    re.compile(r"(?P<d>\d{1,2})[./](?P<m>\d{1,2})[./](?P<y>20\d{2})"),
    re.compile(r"\b(?P<d>\d{1,2})\s+(?P<mon>[A-Za-z]{3,9})\s+(?P<y>20\d{2})\b", re.I),
    re.compile(r"\b(?P<mon>[A-Za-z]{3,9})\s+(?P<d>\d{1,2}),?\s+(?P<y>20\d{2})\b", re.I),
    re.compile(r"\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?P<mon>[A-Za-z]{3,9})\s+(?P<d>\d{1,2})\b", re.I),
)
MONTHS = {name.lower()[:3]: number for number, name in enumerate(
    ("January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"), 1)}


def _season_year(path: Path) -> int | None:
    for part in reversed(path.parts):
        match = re.fullmatch(r"(20\d{2})-(\d{2})", part)
        if match:
            return int(match.group(1))
        if re.fullmatch(r"20\d{2}", part):
            return int(part)
    return None


def _date_and_remainder(line: str, path: Path):
    for pattern in DATE_PATTERNS:
        match = pattern.search(line)
        if not match:
            continue
        values = match.groupdict()
        year = int(values["y"]) if values.get("y") else _season_year(path)
        month = int(values["m"]) if values.get("m") else MONTHS.get(values["mon"].lower()[:3])
        if not year or not month:
            continue
        season = re.search(r"(20\d{2})-(\d{2})", str(path))
        if not values.get("y") and season and month <= 6:
            year = int(season.group(1)) + 1
        try:
            parsed = date(year, month, int(values["d"]))
        except ValueError:
            return None, line
        remainder = line[:match.start()] + " " + line[match.end():]
        remainder = re.sub(r"^\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+", "", remainder, flags=re.I)
        return parsed, remainder.strip(" ,|")
    return None, line


def _clean_team(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip(" \t|▪")
    value = re.sub(r"^\d{1,2}:\d{2}\s+", "", value)
    return value.strip()


def _parse_result(line: str):
    text = line.strip()
    if not text or text.startswith(("(", "#", ";", "=", "▪", "::")):
        return None
    text = re.sub(r"^\d{1,2}:\d{2}\s+", "", text)
    patterns = [
        (re.compile(rf"^(.*?)\s+(?:v|vs\.?|–|—|-)\s+(.*?)\s+{SCORE}(?:\s+\([^)]*\))?$", re.I), "home-away-score"),
        (re.compile(rf"^(.*?)\s+{SCORE}\s+(.*?)$"), "home-score-away"),
    ]
    for pattern, layout in patterns:
        match = pattern.match(text)
        if not match:
            continue
        if layout == "home-away-score":
            home, away, a, b = match.groups()
        else:
            home, a, b, away = match.groups()
        home, away = _clean_team(home), _clean_team(away)
        if not home or not away or home.lower() == away.lower() or len(home) > 90 or len(away) > 90:
            continue
        return home, away, int(a), int(b)
    return None


def parse_football_txt(path: Path):
    """Yield only clearly dated, completed match rows from a Football.TXT file."""
    current_date = None
    try:
        lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        found_date, remainder = _date_and_remainder(line, path)
        if found_date:
            current_date = found_date
            line = remainder
        result = _parse_result(line)
        if not result or not current_date:
            continue
        home, away, score_home, score_away = result
        yield {"date": current_date.isoformat(), "home": home, "away": away,
               "home_score": score_home, "away_score": score_away}
