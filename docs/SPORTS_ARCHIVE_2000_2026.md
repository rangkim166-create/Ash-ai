# Ash Sports Archive: 2000–2026

## What the Android app now stores

Ash's private SQLite database is `ash_sports_memory.db` inside the app's private storage. The app writes collected Odds API fixtures, bookmaker snapshots, manual research reports, team profiles, recent team results, player profiles, news items and dated daily picks there. Existing SharedPreferences match history is migrated once into SQLite.

The Sports > History screen shows local record counts and includes **Import Historical CSV (2000–2026)**. Imports are processed in batches of 500 rows. Each imported match retains its original CSV columns inside a `raw` JSON object, plus normalized sport, date, teams, scores, result and source fields. Rows outside 2000–2026 or without a supported date/team pairing are skipped. Re-importing the same sport/date/home/away identity updates the existing row rather than creating a duplicate.

Imported historical rows are stored separately as `historical_match`; they do not consume The Odds API credits.

## Current limitations

- The importer is a CSV importer. It does not directly read ZIP, Excel, Parquet, or JSON archives.
- The archive is not pre-populated by the APK. Select a CSV file already downloaded to the phone in Sports > History.
- A dataset must have a date column and two participant/team names (or a recognized basketball team/opponent or matchup layout).
- The importer preserves source fields, but different leagues and sports have different statistics. A common normalized feature layer still needs to be built before comparing all sports with one model.
- A historical match record is not the same thing as historical bookmaker odds. Odds are only present when the source file actually includes them.
- Do not treat missing data as zero, a loss, or proof that a player was unavailable.

## Dataset sources and licence warnings

### Football / soccer

- [Football-Data.co.uk](https://www.football-data.co.uk/data.php) has historical CSV/Excel results, match stats and odds, including major European leagues from around 2000/01. Its published terms explicitly say its free data is for private individuals only and not for commercial or automated AI/data-training products. Do not use it to train or power a commercial Ash product without separate permission.
- [OpenFootball](https://github.com/openfootball/football.json) provides public-domain fixture/result data for many competitions, with coverage varying by league and generally much shorter than 2000 for many competitions.

### Tennis

- [Jeff Sackmann's ATP data](https://github.com/JeffSackmann/tennis_atp) and [WTA data](https://github.com/JeffSackmann/tennis_wta) contain historical match results and player/match statistics. The commonly published data licence is CC BY-NC-SA 4.0: attribution and share-alike are required and commercial use is not permitted without permission.
- [Tennis-Data.co.uk](https://www.tennis-data.co.uk/data.php) offers ATP results/odds from 2000 and WTA from 2007, but retains copyright in its spreadsheet files. Check its terms before storing, redistributing, or using it in a commercial product.

### Basketball

- [NBA Data Archive (1996/97–2025/26)](https://huggingface.co/datasets/cdechoch/nba-data-archive) publishes historical NBA play-by-play, shot-detail and matchup data in Parquet. It is not directly importable by the current Android CSV importer; a CSV export or a Parquet-capable ingestion pipeline is required. Check the dataset card and underlying NBA source terms before commercial reuse.
- [NBA-96-26 dataset repository](https://github.com/dckp1000/NBA-96-26-DATASET) describes historical NBA play-by-play and shot data, with season coverage and file formats varying by data type.

## Accuracy and coverage policy

There is no single verified, complete, freely reusable dataset covering every football league, basketball competition and tennis tour from 2000 through 2026 with full results, player statistics, injuries, lineups and historical odds. Ash must track the source, coverage dates, import time and missing fields for each record. It must not claim complete 2000–2026 coverage until the actual imported record counts and year-by-year coverage have been audited on the device.
