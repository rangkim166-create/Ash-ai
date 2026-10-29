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

## League priorities and Arab football

Ash now keeps a prioritized league profile in `sports_ai/league_profiles.json`. The first data-quality priorities are the English Premier League, Championship, Bundesliga, La Liga, Serie A, Ligue 1, Eredivisie, Primeira Liga and Scottish Premiership because public historical results are relatively discoverable. This is a data-coverage priority, not a claim that matches are easy to predict.

The workflow also downloads the public-domain OpenFootball world archive using `sports_ai/collect_arab_football.py`. It targets African/Asian league data including Egypt, Morocco and Algeria where present. The archive is currently preserved and inventoried separately; its text files are **not yet normalized into the match database**, so Ash must not claim those matches are already included in its ratings. Saudi Pro League, Qatar Stars League and UAE Pro League still need a verified, legally usable source before their history can be advertised as available.

For recommendations, Ash should prefer leagues with a large recent sample, verified fixtures, stable data coverage and probabilities validated on held-out past seasons. It must show low/medium/high confidence and missing-data warnings rather than call any match a sure win. A popular league is not necessarily easier to predict, and odds can already reflect public information.

## Expanded coverage and audit status

The collector now attempts the OpenFootball world archive, Saudi Pro League CSV archive, NBA play-by-play source archives, and compact basketball game tables for NBA, EuroLeague, EuroCup, ABA League and the Slovenian league. The SQLite build then imports source formats that have verified parsers. Missing source files are recorded instead of being silently treated as zero-history competitions.

The data pipeline must never describe itself as literally complete: no public source contains every football match in every Arab league, every ATP/WTA match and every basketball competition. Coverage depends on season/source availability. The workflow should publish source manifests, normalized counts by sport/competition and parser warnings with every archive.

### Reuse/licensing guardrails

- OpenFootball's football JSON results are public domain; regional text files are imported only where the score line is unambiguous.
- The ATP/WTA archive used here is marked CC BY-NC-SA 4.0 upstream. It is non-commercial unless a separate permission/license is obtained.
- The Saudi league and multi-league basketball archives do not clearly state a reuse license in their README. Keep attribution and do not redistribute or use commercially until permission is confirmed.
- Football-Data.co.uk explicitly limits its free datasets to private individuals and excludes commercial/AI data-training projects with heavy repeated automated downloads. It is **not** downloaded or imported by the automated workflow. Do not use its CSVs for training or publish its data without permission.
- Results datasets are not a substitute for live fixtures, injuries, lineups or licensed historical bookmaker odds. No match is guaranteed.

## Expanded coverage pipeline

The daily GitHub Actions job now attempts these additional imports:

- A global ODC-BY football results dataset containing 1.2M+ match records across 207 domestic leagues and 20 international competitions, reported upstream from 1888–2023. Attribution is retained; old records may contain errors and team identities may vary.
- OpenFootball's world archive for regional football text files. The parser imports only score lines it can recognize; the audit report lists target leagues that were not detected.
- Saudi Pro League CSV archive where available. Its upstream reuse licence is unclear, so treat it as research-only until permission is confirmed.
- NBA, EuroLeague, EuroCup, ABA League and Slovenian league parquet tables where available. Their upstream reuse licence is also unclear; do not redistribute commercially without permission.
- A coverage audit in `data/history/coverage-report.json` records imported match counts, competitions/seasons and Arab league targets not found.

The workflow builds the SQLite database, imports additional sources, rebuilds `ratings.json`, packages the raw archive/database/report as the `ash-sports-history` Actions artifact, and commits small manifests/ratings to the repository. The artifact has a 90-day retention limit; each successful run removes older copies so the latest archive is easy to find. The full database is reproducible from source URLs but is not permanently stored in Git history.

## Current limitations

This is a broad best-effort collection configured in the repository, not literally every historical match worldwide. The global football archive greatly expands league coverage, but the coverage audit must be checked before assuming any specific Arab competition or season is complete. Some sources may disappear, change schemas, have incomplete seasons or impose non-commercial terms. The coverage audit is the source of truth after a successful workflow run; do not claim a league is covered until its match count is non-zero and the season range has been reviewed. Historical odds are available only for the CSV rows that actually include them. Current fixtures, injuries, confirmed lineups and live odds still require separate feeds.
