# Ash Sports AI — historical data foundation

This module adds a free-first data collector and an explainable Elo baseline to the Ash Jarvis repository.

## Sources
- Football: OpenFootball JSON results for selected European leagues and seasons; public-domain dataset.
- Tennis: Jeff Sackmann ATP/WTA CSV results for years where published. Review upstream CC BY-NC-SA terms before commercial use.
- Basketball: BoxScore Lab NBA team-game CSVs, CC BY 4.0. Preserve attribution when redistributing.

The collector records successful and failed source downloads in data/history/manifest.json. Historical match results are different from historical betting odds.

## Run
Python 3.10+; standard library only.

    python sports_ai/collect_history.py
    python sports_ai/predict.py --sport football --home "Arsenal" --away "Chelsea"
    python sports_ai/predict.py --sport tennis --home "Player One" --away "Player Two"

The Elo baseline uses football and tennis results. Basketball data is collected first; validate its column schema before enabling a basketball-specific model.

## Responsible evaluation
- Probabilities are estimates, not certainties or betting advice.
- Log predictions before matches and evaluate against later results.
- Use chronological holdouts to avoid training and testing on the same matches.
- One month of new observations does not prove a lasting betting edge.
- Never commit API keys or secrets to GitHub.
