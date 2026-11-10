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

The Render process now checks once per hour for a Kampala-day publication that has not been sent yet. It refreshes configured public bookmaker pages before publication, imports only exact event/market matches from `source='public_scrape'`, then applies a conservative server-side filter:

- upcoming fixtures only, with scraped bookmaker snapshots no older than 15 minutes;
- head-to-head prices from multiple distinct bookmakers;
- at least five verified recent results for both participants;
- a positive recent-form edge, with stricter bookmaker/form requirements for higher prices;
- only the top three selections are sent; if none pass, Telegram receives a clear no-pick status rather than a forced bet.

Each daily publication is stored in `ash_daily_publications` using the Africa/Kampala date, so restarts and hourly retries do not duplicate a successful message. Delivery attempts are also recorded in `telegram_delivery_log`.

For delivery, configure both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the Render service environment, or save them through the authenticated `POST /v1/telegram/configure` route. If Telegram is not configured, the job remains in `waiting_for_telegram_config` and retries hourly. The message is plain text and every selection is ready to copy.

The daily selector is an evidence filter, not a calibrated prediction model or a guarantee. Missing form, stale prices, or weak bookmaker agreement result in no pick.


## Live research for every fixture

Upcoming fixtures are queued from `sports_matches` regardless of source. The scheduled Odds API collector is disabled by default; the optional `ASH_ENABLE_ODDS_API_FIXTURE_DISCOVERY=true` flag enables it only as an explicit fallback. Public bookmaker event pages can create fixture rows when they expose an unambiguous sport, both participants and kickoff time. Queue claims use row locking so overlapping workers do not research the same fixture simultaneously.

For each fixture Ash searches current public web/news sources through two independent news discovery feeds (Google News RSS and Bing News RSS), using twelve fixture-specific searches for match previews and expert/tipster views, breaking news from the last 48 hours, home/away injuries and fitness, lineups, suspensions, manager/training news, weather/venue, recent form/head-to-head, official club/league statements and African/regional sports coverage. Searches use both a 48-hour freshness window for breaking updates and a seven-day context window. It deduplicates results, prioritizes fresh and official/established publishers, fetches up to twelve readable source pages per fixture, and records publisher domains, publication dates, discovery provider and topic coverage. Groq performs a conservative evidence-only synthesis when configured. The evidence and synthesis are stored in `ash_fixture_research`. Research refreshes every 6 hours normally and every 20 minutes within three hours of kickoff; failed or interrupted work can be retried. Daily picks are held unless fresh research covers both participants, injury and lineup reporting, at least two independent publishers and a non-conflicting AI assessment.

Public read-only endpoints:
- `GET /v1/public/research/summary` — queue totals and the latest researched fixtures.
- `GET /v1/public/research/fixture?id=<stored-match-id>` — source links, excerpts, timestamps, coverage and evidence synthesis for one fixture.

This is multi-provider public-web news discovery, not a claim to crawl the entire internet. Search feeds can overlap or fail, and paywalls, publisher restrictions, indexing delays and client-side page rendering can limit what Ash can verify. A missing source or unknown injury/lineup remains unknown, never filled by guesswork. Groq is used only for evidence synthesis when configured; it does not supply the underlying match facts.

## Public bookmaker scraper (initial rollout)

The Render backend now has a rate-limited public-page scraper for approved bookmaker domains:
- BetPawa Uganda (`betpawa.ug`), Betika Uganda (`betika.com/en-ug`), 1xBet Uganda (`1xbet.ug`), 22Bet (`22bet.ug`) and BetPaka/Ecobet (`ecobetug.com`). The allowlist is aligned to the NLGRB 2026 licensed-company list and should be rechecked when that register changes.
- Sources are seeded on first scraper run and can be extended with exact public HTTPS event/market page URLs.
- The scraper follows at most three redirects and revalidates every redirect host, rejects non-HTTPS URLs, rejects credentials in URLs, and caps each response at 2 MB.
- It stores fetch metadata, extracted page text, embedded JSON/JSON-LD blocks and conservative odds candidates in `ash_scraper_runs`; source configuration and last-run state are stored in `ash_scraper_sources`.
- Render runs the scraper shortly after startup and every 30 minutes; the daily publisher also triggers a fresh scrape immediately before evaluating picks.
- Authenticated routes: `GET /v1/scraper/status`, `POST /v1/scraper/run` with optional `{"limit":8}`, and `POST /v1/scraper/sources` with `{"bookmaker":"BetPawa","url":"https://www.betpawa.com/..." }`.

Important: this is the first collection layer, not a guarantee that every bookmaker exposes odds in crawlable HTML. Many betting sites render markets client-side, geofence pages, require sign-in, or prohibit automated collection. The engine does not bypass access controls, CAPTCHAs or bot protections. A page that returns no public structured odds is recorded as such, not converted into invented prices.

Only candidates with an exact two-team event match, a recognized head-to-head market, a valid participant/draw outcome and a valid decimal price are imported into `bookmaker_odds` with `source='public_scrape'`. Event rows are created only when sport and kickoff metadata are explicit. Ambiguous matches are discarded. The daily prediction query accepts only fresh `public_scrape` prices (15-minute limit); The Odds API is not used for prices or scheduled collection by default. It remains an opt-in fixture-discovery fallback, not a required odds source.

## Prediction quality controls (Ash hybrid v1)

The daily candidate selector now:
- requires bookmaker prices collected within the last 15 minutes;
- requires a complete 1X2 market for football (home, draw, away), or a complete two-outcome market for tennis/basketball;
- requires at least four independent bookmaker prices (five for longer prices);
- rejects material disagreement between bookmakers;
- requires at least five recent results for both teams/players, or an imported Elo archive covering at least 1,000 matches for that sport;
- shrinks form/Elo adjustments toward the no-vig bookmaker consensus and only keeps candidates with at least a 1.5 percentage-point estimated edge over the best price's implied probability.

These estimates are a conservative screening heuristic, not a trained or proven profitable model. Every published candidate is recorded in `ash_predictions` with its probability, model version and evidence. Verified result settlement updates the prediction status. The public endpoint `GET /v1/public/predictions/metrics` reports settled sample size, average estimated probability, observed win rate, Brier score and unit-stake ROI by model version. Do not interpret small samples; the endpoint marks 100 settled predictions as the minimum sample before interpretation.

The scraper is a conservative generic first stage, not a guaranteed adapter for every bookmaker. It will produce no picks when pages hide markets behind client-side rendering, login, geofencing or anti-bot controls. Add exact public event/market URLs through the authenticated source route where a bookmaker's homepage does not expose structured markets. The optional Odds API fixture fallback is disabled unless explicitly enabled.


## Expanded fixture intelligence research

Ash searches public reporting for match previews, home/away injuries and fitness, doubtful or ruled-out players, confirmed or predicted lineups, suspensions, manager/coach press conferences, training and squad updates, weather/venue conditions, form and head-to-head. Sources are saved with URL, publisher, publication date and category tags. Coverage tags indicate related reporting was found, not that a claim is confirmed. Research refreshes every 15 minutes. Public coverage is not exhaustive; paywalls, publisher restrictions and unindexed pages remain unavailable. Unknown player availability and lineups must stay unknown.


## User scouting signals (new)

Authenticated endpoint `POST /v1/scout/signals` accepts:
```json
{"sport":"football","team":"Chelsea","opinion":"not_win","reason":"I expect them not to win"}
```
Supported opinions are `win`, `lose`, `not_win`, `draw`, `upset`, and `avoid`. A matching upcoming fixture is linked immediately and re-queued for research. If no fixture is currently indexed, the team signal is retained and attached when a matching upcoming fixture is later discovered. Use `GET /v1/scout/signals` to review saved signals.

A scouting signal is a research instruction, not a prediction override. It adds targeted searches for contrary views, draw/upset risk, form, injuries, lineups, suspensions and tactical context. It cannot force a pick and does not bypass current odds, evidence, freshness or value checks. This makes the user's football knowledge visible to the research process instead of silently ignoring it.


## Independent fixture discovery (new)

Before scheduled research and daily publishing, Ash now queries ESPN's public scoreboard endpoints independently of bookmaker odds for major football competitions (England, Spain, Germany, Italy, France, UEFA Champions/Europa League, MLS, Mexico, Brazil and Argentina) plus the NBA. It normalizes only events with an explicit event ID, both participants and a valid kickoff timestamp, then upserts them into `sports_matches` as `source='espn_public_schedule'`. These fixtures enter the same evidence-research queue even when no odds are listed yet. This source does not invent prices: odds-based picks still require verified bookmaker prices. Coverage depends on ESPN's public scoreboard availability and supported competitions; it is an additional discovery source, not an exhaustive worldwide fixture database.


## Android scouting signals

The Android app uses the public, device-scoped endpoint:

- `GET /v1/public/scout/signals`
- `POST /v1/public/scout/signals`

Requests send an app-generated random `X-Ash-Device-Id`. The server stores only a SHA-256 digest as the owner key and returns only signals belonging to that device. No server admin token is embedded in the APK. Each device is limited to 30 saved signal rows per 24 hours. Supported sports are football, basketball and tennis; supported views are win, lose, not-win, draw, upset and avoid. Signals add research queries and never force a pick or bypass odds/evidence checks.
