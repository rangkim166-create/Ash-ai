# Ash Sports Neon Function

Node.js 24 Neon Function source. Neon injects DATABASE_URL.

Required environment secrets:
- ASH_APP_TOKEN: high-entropy bearer token used by the app.
- ASH_CREDENTIALS_KEY: base64 encoding of exactly 32 random bytes for AES-256-GCM.

Never commit these values or provider keys.

Routes:
- GET /health (public)
- GET /v1/public/history/summary (public historical results coverage)
- GET /v1/public/history/team?team=Al%20Ahly (last 20 completed matches)
- GET /v1/public/history/h2h?team_a=Al%20Ahly&team_b=Zamalek (last 20 meetings)
- GET /v1/providers/status (Bearer token)
- POST /v1/providers/the_odds_api with {"apiKey":"..."}
- POST /v1/providers/openrouter with {"apiKey":"..."}
- POST /v1/providers/groq with {"apiKey":"..."}
- POST /v1/telegram/configure with {"botToken":"...","chatId":"..."}
- POST /v1/telegram/test sends a real Telegram message and logs delivery
- POST /v1/telegram/send with {"message":"..."}
- GET /v1/odds/sports proxies The Odds API using the stored key
- POST /v1/ai/test with {"provider":"openrouter"} or {"provider":"groq"}

All routes except health require Authorization: Bearer ASH_APP_TOKEN.
Requires provider_credentials and telegram_delivery_log tables in ash_sports.
Deployment and endpoint verification are separate from committing source.


Historical results are imported from OpenFootball football.json and OpenFootball world (CC0). They are match results only, not historical bookmaker odds. The public history endpoints expose form and head-to-head rows for Ash's research layer.

## Automated Odds of the Day publishing

The Render process now checks once per hour for a Kampala-day publication that has not been sent yet. It refreshes bookmaker odds when the collector cooldown allows, then applies a conservative server-side filter:

- upcoming fixtures only, with bookmaker snapshots no older than 6 hours;
- head-to-head prices from multiple distinct bookmakers;
- at least five verified recent results for both participants;
- a positive recent-form edge, with stricter bookmaker/form requirements for higher prices;
- only the top three selections are sent; if none pass, Telegram receives a clear no-pick status rather than a forced bet.

Each daily publication is stored in `ash_daily_publications` using the Africa/Kampala date, so restarts and hourly retries do not duplicate a successful message. Delivery attempts are also recorded in `telegram_delivery_log`.

For delivery, configure both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the Render service environment, or save them through the authenticated `POST /v1/telegram/configure` route. If Telegram is not configured, the job remains in `waiting_for_telegram_config` and retries hourly. The message is plain text and every selection is ready to copy.

The daily selector is an evidence filter, not a calibrated prediction model or a guarantee. Missing form, stale prices, or weak bookmaker agreement result in no pick.


## Live research for every fixture

The Odds API collector inserts fixtures into `sports_matches` once per event ID and preserves later odds snapshots separately. Every stored upcoming Odds API fixture is added to `ash_fixture_research_queue`; the hourly worker processes four fixtures per pass and the collection worker processes up to eight. Queue claims use row locking so overlapping workers do not research the same fixture simultaneously.

For each fixture Ash searches current public web/news sources for match previews and expert/tipster views, home-team news, away-team news, and recent form/head-to-head reporting. It fetches readable source pages, records publisher domains and publication dates, and asks Groq for a conservative evidence-only synthesis when configured. The evidence and synthesis are stored in `ash_fixture_research`. Research is refreshed at least every six hours while the fixture remains in the feed; failed or interrupted work can be retried.

Public read-only endpoints:
- `GET /v1/public/research/summary` — queue totals and the latest researched fixtures.
- `GET /v1/public/research/fixture?id=<stored-match-id>` — source links, excerpts, timestamps, coverage and evidence synthesis for one fixture.

This is broad live public-web discovery, not a claim to crawl the entire internet. Search coverage, paywalls, publisher restrictions and API availability can limit what Ash can verify. A missing source or unknown injury/lineup must remain unknown, never be filled by guesswork. Live odds remain separate from web research and still depend on a working odds-provider quota/key.

## Public bookmaker scraper (initial rollout)

The Render backend now has a rate-limited public-page scraper for approved bookmaker domains:
- BetPawa, Betika, SportyBet, Bet365 and 1xBet.
- Sources are seeded on first scraper run and can be extended with exact public HTTPS event/market page URLs.
- The scraper follows at most three redirects and revalidates every redirect host, rejects non-HTTPS URLs, rejects credentials in URLs, and caps each response at 2 MB.
- It stores fetch metadata, extracted page text, embedded JSON/JSON-LD blocks and conservative odds candidates in `ash_scraper_runs`; source configuration and last-run state are stored in `ash_scraper_sources`.
- Render runs the scraper shortly after startup and every three hours.
- Authenticated routes: `GET /v1/scraper/status`, `POST /v1/scraper/run` with optional `{"limit":8}`, and `POST /v1/scraper/sources` with `{"bookmaker":"BetPawa","url":"https://www.betpawa.com/..." }`.

Important: this is the first collection layer, not a guarantee that every bookmaker exposes odds in crawlable HTML. Many betting sites render markets client-side, geofence pages, require sign-in, or prohibit automated collection. The engine does not bypass access controls, CAPTCHAs or bot protections. A page that returns no public structured odds is recorded as such, not converted into invented prices.

Scraped odds candidates are deliberately stored separately from `bookmaker_odds` until event identity and market mapping can be verified. The existing Odds API collector and daily-pick workflow are still present in this branch; they have not yet been removed or switched off. Removing that dependency safely requires validated bookmaker event/market adapters and a successful live scrape test first. Do not describe Ash as API-free until that migration is completed.

## Prediction quality controls (Ash hybrid v1)

The daily candidate selector now:
- requires bookmaker prices collected within the last 15 minutes;
- requires a complete 1X2 market for football (home, draw, away), or a complete two-outcome market for tennis/basketball;
- requires at least four independent bookmaker prices (five for longer prices);
- rejects material disagreement between bookmakers;
- requires at least five recent results for both teams/players, or an imported Elo archive covering at least 1,000 matches for that sport;
- shrinks form/Elo adjustments toward the no-vig bookmaker consensus and only keeps candidates with at least a 1.5 percentage-point estimated edge over the best price's implied probability.

These estimates are a conservative screening heuristic, not a trained or proven profitable model. Every published candidate is recorded in `ash_predictions` with its probability, model version and evidence. Verified result settlement updates the prediction status. The public endpoint `GET /v1/public/predictions/metrics` reports settled sample size, average estimated probability, observed win rate, Brier score and unit-stake ROI by model version. Do not interpret small samples; the endpoint marks 100 settled predictions as the minimum sample before interpretation.

The bookmaker scraper is still a first-stage public-page collector. It stores raw page evidence and candidate odds separately; it does not yet prove event/market identity or feed verified scraped prices into the production odds/prediction path. Do not remove the current odds collector or claim an API-free migration until site-specific adapters have been live-tested, normalized and independently verified end-to-end.
