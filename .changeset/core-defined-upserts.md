---
"@bot-wa/core": patch
---

The `Bot` omits `undefined` fields from its chat and contact upserts, so a message without a display name (or chat name) no longer erases the one already stored. `IStore.upsertChat` / `upsertContact` document the contract: an own field set to `undefined` unsets it, so partial upserts must omit unknown fields.
