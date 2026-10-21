---
"@bot-wa/baileys": minor
---

- Pin `@whiskeysockets/baileys` to `7.0.0-rc14`.
- Decrypt poll votes and emit the `poll` event with the aggregated tally; votes are bound to their poll's chat and creator and counted once.
- Canonical (LID → PN) ids on reactions, poll votes, group, call and presence events, inbound mentions and `selfId`; calls go through the same identity canonicalisation as messages and group calls carry `chatId`/`isGroup`.
- Leave the `browser` identity unset by default (Baileys' own macOS/Chrome), warn on custom tuples.
- Fix: reactions report the reactor, not the message author; device-qualified PNs from `getPNForLID` are normalised; errors log under pino's `err` key; `RateLimiterTimeout` maps to `RateLimitedError`; sent messages answer resend requests.
