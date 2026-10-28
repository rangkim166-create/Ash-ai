# Ash Sports AI — historical data foundation

This module collects public historical results for football, tennis and NBA basketball, normalizes them into a local SQLite database, and offers a simple Elo baseline for all three sports.

## Run the collection

```bash
python sports_ai/collect_full_history.py
python sports_ai/build_database.py
python sports_ai/predict.py --sport basketball --home "Boston Celtics" --away "Los Angeles Lakers"
```

The GitHub Actions workflow runs daily, on changes to the sports module, or manually from the repository's Actions tab. It uploads the collected archive/database as the `ash-sports-history` artifact. GitHub Actions artifacts are temporary (configured for 90 days), not permanent storage.

## Sources and limits

- Football: OpenFootball JSON, public domain; selected leagues and seasons from 2000/01 onward. Coverage differs by league/season.
- Tennis: ATP/WTA match results mirrored in `Aneeshers/tennis-sackmann-archive`, decades of historical results where available. The data retains Jeff Sackmann's CC BY-NC-SA 4.0 terms: attribution, share-alike, non-commercial use. Do not use it commercially without permission.
- Basketball: NBA team game logs in `shufinskiy/nba_data`, regular season and playoffs from 1996 onward where archives exist. This is not every global basketball league.

No free source contains literally every match ever played, and match results are not historical bookmaker odds. Historical odds, line movement, injuries, lineups and current fixtures require separate sources.

## Model status

The Elo baseline now supports football, tennis and basketball. It is a starting point, not a production-validated prediction system. It does not account for injuries, lineups, tennis surface, fatigue, venue effects, odds or team/player identity changes. Run chronological backtests and calibration before using predictions to make decisions. No prediction is guaranteed.

The database is built on the GitHub Actions runner and attached as an artifact; it is not yet a permanent online database or automatically served to the Android app. To connect live app requests, Ash needs a hosted API/database endpoint and deployment configuration.
