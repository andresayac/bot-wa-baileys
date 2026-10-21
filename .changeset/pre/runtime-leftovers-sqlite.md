---
"@bot-wa/sqlite-store": minor
---

Implement the optional `IStore.setCheckpointIf` / `clearCheckpointIf` compare-and-set checkpoint writes (one atomic statement), used by `ConversationRuntime` with `coordination`.
