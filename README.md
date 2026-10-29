# Ash Jarvis — Native Android AI Assistant

Ash Jarvis is being built as a **native Android application**. It is not a PWA or a website wrapped in an APK.

## Goals

- Native Android UI and local conversation storage
- AI chat with a configurable online provider
- A path to on-device, offline inference using a compatible GGUF model runtime
- Coding assistance and a safe ethical cybersecurity learning lab
- Build and test an installable APK through Android tooling/CI

## Honest status

This repository is the starting point. The APK and offline Dolphin model integration are **not yet built or verified**. A model file alone is not an Android runtime; the app needs a compatible inference engine and enough available memory/storage. Keep API keys out of source control.

## Development

The Android project will use Kotlin and Jetpack Compose. Build it with a compatible Android SDK and Gradle installation, or use the repository's CI workflow once added.


## Sports Intelligence (new foundation)

A free-first historical data collector and Elo prediction baseline for football and tennis, plus NBA historical team-game data collection, lives in [sports_ai/README.md](sports_ai/README.md). A scheduled GitHub Actions workflow refreshes available source data daily. Data availability depends on upstream sources; this is an early baseline, not a verified profitable prediction system.

## Live bookmaker odds integration

Ash's **SPORTS** button opens a separate native **Ash Sports Intelligence** screen with Today, History and Setup tabs. Each customer can paste their own The Odds API key into the app. The key is encrypted using Android Keystore on that device and is not committed to source control or embedded in the APK.

Customers can select leagues/competitions available to their API plan. Ash retrieves current/upcoming head-to-head odds, creates a clearly labelled shortlist using a simple price-range and multi-bookmaker availability filter, and stores newly discovered games plus recent snapshots locally. WorkManager schedules a background refresh every 24 hours after the Sports screen has been opened. The first refresh starts after a key is connected. API availability and quota depend on the customer's Odds API subscription; some sports may not be available on a free plan.

The shortlist is a filtering aid, **not a guarantee of a winning bet**. Odd/even is not a standard market in The Odds API's published list, so Ash must not invent bookmaker odd/even prices from over/under data. The local history stores games/odds snapshots seen by this app; it is not a substitute for the provider's paid historical-odds archive.

A GitHub Actions workflow builds a debug APK after app changes; check the latest Actions run before installing.
