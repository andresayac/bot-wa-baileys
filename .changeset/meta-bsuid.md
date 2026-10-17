---
"@bot-wa/meta": minor
---

Support WhatsApp usernames / BSUIDs: parse every business-scoped user id field, keep one stable id per person (phone when known, else BSUID), learn phone ↔ BSUID pairs through a pluggable `identityMap` (`MemoryIdentityMap`), send to BSUIDs via `recipient`, expose `isBsuid()`, and drop events without usable ids instead of emitting `undefined` ids.
