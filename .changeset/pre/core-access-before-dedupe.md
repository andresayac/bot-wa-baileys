---
"@bot-wa/core": patch
---

The blacklist/whitelist now run before inbound dedupe: a blocked message or interaction is no longer recorded as seen, so a redelivery after un-blocking is processed. While still blocked, every delivery counts in `metrics().dropped.blocked` (never `duplicate`).
