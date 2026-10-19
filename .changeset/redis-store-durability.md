---
"@bot-wa/redis-store": minor
---

New `RedisDurability` backend for `BotConfig.durability` (durable inbox/outbox). Each record is a versioned string written by a single Lua script that compares the current value, writes the new one and updates the record's `due`/`done` sorted sets atomically. Keys live under `{prefix}:{durable:inbox|outbox[:<scope>]}` (one scope per bot namespace), so the script is Redis Cluster safe and never touches `RedisStore` keys.
