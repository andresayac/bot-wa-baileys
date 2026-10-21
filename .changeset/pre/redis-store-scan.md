---
"@bot-wa/redis-store": patch
---

Key listings (`listChats`, `listContacts`, `listCheckpoints`, `ctx.user` list and namespace deletes) use incremental `SCAN` through the client's `scanIterator` instead of the blocking `KEYS` (clients without it fall back to `KEYS`) and fetch records with parallel `GET`s. Aligned with `MemoryStore`: messages without `ref.id` or `chatId` are ignored, and `setUserData` rejects a non-JSON value with a `TypeError`.
