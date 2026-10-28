# Ash Sports AI — historical data foundation

This module collects the broadest practical set of publicly available history from configured sources. No free source contains literally every match, every league, all player statistics, and all historical bookmaker odds.

## Collection

Run on a machine or GitHub Actions runner with internet access:

    python sports_ai/collect_full_history.py

The collector attempts football seasons from 2000/01 through 2026/27 across selected European leagues, MLS, Brazil, and major international tournaments; ATP/WTA match-result files from 1968 through 2026 where upstream files exist; and a public NBA historical dataset archive covering play-by-play and related records. Unavailable source URLs are logged, not treated as fatal for the whole import.

The older collect_history.py script is a smaller/faster collection option. Data is stored in data/history/raw and manifests show which downloads succeeded. Large archives may exceed GitHub repository size limits; for production, keep datasets in external object storage or workflow artifacts instead of committing every raw file to Git.

## Sources and licensing

- Football results: OpenFootball JSON, public domain. Coverage differs by competition and season.
- Tennis: Jeff Sackmann ATP/WTA data. The upstream data is licensed CC BY-NC-SA; review terms carefully and do not assume commercial redistribution is allowed.
- NBA: public dckp1000/NBA-96-26-DATASET archive. Review its upstream license and source attribution before commercial use.

Historical match results are not historical betting odds. Odds history, line movements, injuries, lineups, player availability, and real-time fixtures need separate sources and may require paid access.

## Prediction model status

The Elo baseline in predict.py supports football and tennis only. NBA data download is a data-ingestion step, not a finished basketball predictor. Validate schemas, deduplicate records, normalize team/player identities, and add chronological train/test evaluation before using the model for decision support.

## Responsible evaluation

- Save predictions before kickoff/first serve.
- Evaluate only on matches that occurred after each prediction.
- Use chronological holdouts to avoid leakage.
- Report calibration and baseline comparison, not just hit rate.
- Probabilities are estimates, never guarantees or betting advice.
- Never commit API keys or secrets to GitHub.
