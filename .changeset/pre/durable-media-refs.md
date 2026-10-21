---
"@bot-wa/core": minor
"@bot-wa/baileys": minor
"@bot-wa/meta": minor
"@bot-wa/telegram": minor
---

Durable media references, so a replayed inbound message can still download its media. `IProvider` gains two optional hooks: `serializeMediaRef(ref)` returns a JSON-safe, versioned `{ v, data }` (or `undefined`), and `rehydrateMediaRef(stored, ref)` rebuilds the `MediaRef`. With `BotConfig.durability` on, the inbox journals that reference instead of the live media token. A replay (crash recovery, background retry, operator `replayInbound`) rebuilds it inside the chat's turn, so per-chat order is kept. When the media cannot be rebuilt, the message still runs and only its download fails: `loadMediaOf(ctx, { throwOnError: true })` rejects with the new `MediaUnavailableError` (a `ProviderError` whose `reason` is `'not-durable'`, `'provider-mismatch'` or `'rehydrate-failed'`). `durability.inbox.mediaRefs: false` keeps the previous encoding. A provider without the hooks, and records written before this change, behave exactly as before. New exports: `MediaUnavailableError` and the `SerializedMediaRef` and `MediaUnavailableReason` types.

The providers implement the hooks. Baileys journals only the media content (CDN url, direct path, media key and hashes; no thumbnail, caption or quoted context) plus the message key that re-upload requests need. It skips view-once media unless `durableMedia: { viewOnce: true }` is set, and it returns the cached original message while it is still in memory. Cloud API journals the media id and Telegram the `file_id`. None of them journals credentials, and each validates the stored value when it reads it back.
