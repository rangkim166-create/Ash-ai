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
