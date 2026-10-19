---
"@bot-wa/sqlite-store": patch
---

`upsertChat`/`upsertContact` are atomic (read and write in one `IMMEDIATE` transaction), so concurrent partial upserts of one record no longer drop each other's fields. Aligned with `MemoryStore`: messages without `ref.id` or `chatId` are ignored, `getMessagesByChat` normalises `limit` (non-positive → none, fraction → rounded up, `Infinity` → all; a negative limit used to return everything), `setUserData` rejects a non-JSON value with a `TypeError`, and an invalid `maxMessagesPerChat` throws a `RangeError`. Statements are prepared once per store.
