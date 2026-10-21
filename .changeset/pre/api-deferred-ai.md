---
"@bot-wa/ai": minor
---

Breaking (alpha): `aiPlugin({ instance })` is the public way to inject a ready-built `AIProvider` (`MockAIProvider` in tests, or your own); it skips the `provider`/`apiKey`/`model` resolution and the lazy SDK load. The test-only `__provider` hook is stripped from the published types (`stripInternal`) but still honoured at runtime; `instance` wins when both are set.
