# Ash Sports Neon Function

Node.js 24 Neon Function source. Neon injects DATABASE_URL.

Required environment secrets:
- ASH_APP_TOKEN: high-entropy bearer token used by the app.
- ASH_CREDENTIALS_KEY: base64 encoding of exactly 32 random bytes for AES-256-GCM.

Never commit these values or provider keys.

Routes:
- GET /health (public)
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
