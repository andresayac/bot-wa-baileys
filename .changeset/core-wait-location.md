---
"@bot-wa/core": minor
---

Locations in conversations and storage: new `c.waitLocation(opts?)` (resolves the normalized `InboundLocation`; anything else re-prompts with `otherwise` or the localized `core.wait.location`, and `validate(body, message)` can reject one), `RuntimeMessage.sharedLocation`, and `StoredMessage.location` (optional), which the bot now fills when it persists an inbound location.
