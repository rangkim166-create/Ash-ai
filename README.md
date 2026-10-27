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
