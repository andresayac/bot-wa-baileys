---
"@bot-wa/core": patch
---

`MemoryStore` documents its default cap of 1000 messages per chat (RAM only; the persistent stores stay unbounded unless configured), accepts `maxMessagesPerChat: Infinity` to disable it, and rejects a negative, fractional or `NaN` cap with a `RangeError`.
