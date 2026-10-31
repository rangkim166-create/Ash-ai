# Ash Jarvis — Native Android AI Assistant

Ash Jarvis is a native Android app for chat, voice, phone assistance, offline GGUF inference, and sports intelligence.

## Android build

- Kotlin Android app, package: `com.ashjarvis`
- Minimum Android: 11 (API 30)
- ARM64 APK target for modern Android phones, including the Samsung Galaxy A70
- Online AI: OpenRouter, with the API key encrypted using Android Keystore
- Offline AI: `LLMEdge 0.3.9` (llama.cpp/JNI) with local GGUF model files

Build with GitHub Actions: **Actions → Build Ash Jarvis APK**. The workflow compiles and uploads an ARM64 debug APK artifact. The APK is not a Play Store release.

## Offline AI — important device notes

The app contains the GGUF import/download and local inference path. Model weights are downloaded separately and are not bundled in the APK.

For an 8 GB Android phone, start with **Qwen 2.5 0.5B Q4_K_M**. Qwen 2.5 1.5B Q4 may work depending on free RAM. A 3B model is heavier, and Dolphin 8B Q4 is not a reliable target on an 8 GB phone because the model needs additional memory for runtime and context.

A successful CI build verifies compilation, not real on-device inference. The final runtime check must be done on a physical Android device after downloading a compatible model.

## Sports intelligence

The native SPORTS screen provides:
- Live/upcoming bookmaker odds from The Odds API
- Football, basketball, and tennis competition selection
- Local match/odds history and saved research
- A server-generated **Odds of the Day** ticket with individual and full-ticket copy actions

The daily ticket is read from the Render API at:

`https://ash-sports-api.onrender.com/v1/public/odds/daily`

The backend stores the Kampala-day ticket in its database and only publishes selections that pass its current odds/form checks. It must return no pick rather than force a bet when evidence is insufficient. This is a research filter, not a guarantee of profit.

Historical match results and bookmaker odds are different datasets. Local odds history records snapshots observed by this app; it does not create a paid historical-odds archive.

## Render backend and Telegram

The production API service is `ash-sports-api` on Render:

`https://ash-sports-api.onrender.com`

It runs from the `ash-neon-backend` branch and exposes a public health check, public daily ticket/history reads, and authenticated provider/Telegram management routes.

Telegram delivery requires both Render environment variables:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Until those are configured, the daily ticket can still be stored and viewed in the app, but it cannot be sent to Telegram. The backend retries the daily publication on its schedule.

## Neon deployment

The Render API is the active backend deployment. The optional Neon Function workflow is disabled unless explicitly enabled with repository variable `ASH_ENABLE_NEON_FUNCTION_DEPLOY=true` and dedicated `ASH_NEON_PROJECT_ID` / `ASH_NEON_BRANCH_ID` variables plus `NEON_API_KEY`. Do not point it at another app's database.

## Security

- Never commit API keys, bot tokens, or database URLs.
- Keep provider credentials in Render environment variables or the app's encrypted local storage.
- Do not describe an unverified model or prediction as working or guaranteed.
