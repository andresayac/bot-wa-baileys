---
"@bot-wa/core": minor
"@bot-wa/sqlite-store": minor
"@bot-wa/redis-store": minor
---

`messageKey(ref)` percent-escapes `%` and `:` in the chat id and the message id, so ids that contain `:` (Twilio's `whatsapp:+1…` chat ids) no longer collide; keys of ids without `:` or `%` are unchanged. New `legacyMessageKey(ref)` returns the old unescaped key. SQLite and Redis stores write the new key, still read and delete rows stored under the legacy key (checking the stored `ref` is the requested message, since a legacy key can be another message's new key), and drop the legacy copy when a message is saved again — no manual migration.
