# Ash Sports API (The Odds API proxy)

This service keeps `ODDS_API_KEY` on the server rather than inside the Android APK.

## Run locally
```bash
ODDS_API_KEY=your_key_here python sports_api/server.py
``

Set the secret in the hosting provider's private environment variables. Never commit it or put it in a public issue.

## Endpoints
- `GET /health` — checks service and whether the key is configured (does not reveal it).
- `GET /sports` — provider's current sports list.
- `GET /odds?sport=soccer_epl&regions=uk,eu&markets=h2h,totals&oddsFormat=decimal` — upcoming/live odds for featured markets. The response includes provider quota headers.
- `GET /event-markets?sport=soccer_epl&event_id=EVENT_ID&regions=uk,eu` — asks the provider which markets were recently seen for one event.
- `GET /event-odds?sport=soccer_epl&event_id=EVENT_ID&regions=uk,eu&markets=odd_even` — attempts an event-level market request. If the provider says it is unsupported, treat it as unavailable.

## Odd/even truthfulness
The Odds API's published market list includes head-to-head, spreads, totals, BTTS and other event markets, but does **not** list odd/even as a standard market. Ash must only display odd/even bookmaker prices if the API actually returns that market from a bookmaker. Do not derive bookmaker odds from over/under odds. If the market is missing, show "Odd/even bookmaker odds unavailable from this feed" and optionally keep a separately labelled model estimate for later.

## Deploy
Use a Python service with start command `python sports_api/server.py`, and set:
- `ODDS_API_KEY` = your existing private The Odds API key
- `PORT` is supplied by most hosts automatically
- optionally `ODDS_CACHE_SECONDS=60`

Use the deployed HTTPS service URL as Ash's Sports API base URL. This repo's Android app does not automatically get a hosted endpoint just because the server files exist; the service must be deployed and configured before live odds work in-app.
