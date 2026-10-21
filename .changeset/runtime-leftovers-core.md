---
"@bot-wa/core": minor
---

Opt-in runtime hardening: `BotConfig.echoFilter` drops inbound echoes of the bot's own sends (before access lists, dedupe and the journal; counted in `metrics().dropped.echo`); `IStore.setCheckpointIf`/`clearCheckpointIf` (optional CAS used with `coordination`, with `FlowCheckpoint.revision`) so a frozen replica cannot overwrite the new owner's checkpoint; `FileDurability.open(path, { appendLog })` appends deltas to `<path>.log` with periodic compaction instead of rewriting the snapshot.
