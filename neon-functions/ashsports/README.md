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
