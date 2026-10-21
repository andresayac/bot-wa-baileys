---
"@bot-wa/ai": patch
---

Lazy loading of the optional AI SDKs (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`) only reports "not installed" when the SDK package itself cannot be found, and keeps the original resolution error as `cause`. An SDK that is installed but fails while loading (or misses one of its own dependencies) is no longer misreported as missing: its real error is rethrown.
