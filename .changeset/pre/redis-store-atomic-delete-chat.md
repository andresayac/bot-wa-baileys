---
"@bot-wa/redis-store": patch
---

`deleteChat` runs as one Lua script, so a message saved while a chat is being deleted can no longer survive as an orphan item; `deleteMessage` only removes an item that belongs to that chat's log.
