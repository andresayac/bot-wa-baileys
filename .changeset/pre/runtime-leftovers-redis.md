---
"@bot-wa/redis-store": minor
---

Implement the optional `IStore.setCheckpointIf` / `clearCheckpointIf` compare-and-set checkpoint writes (one Lua script per write, including the Redis Cluster layout), used by `ConversationRuntime` with `coordination`.
