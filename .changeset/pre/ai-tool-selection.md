---
"@bot-wa/ai": minor
---

Per-turn tool selection: `replyInChat`/`ask` accept `tools: ['id', …]` to restrict the tool loop to those configured tools (unknown ids reject with a clear error; `[]` runs the turn without tools). Used by the declarative `ai` step of `@bot-wa/flow-schema`.
