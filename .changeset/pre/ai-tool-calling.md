---
"@bot-wa/ai": minor
"@bot-wa/core": minor
---

`@bot-wa/ai`: native tool / function calling. `aiPlugin({ tools })` maps each tool (description, JSON Schema or `safeParse` schema, handler, `confirm`) to Anthropic, OpenAI (and OpenAI-compatible presets), Gemini and Ollama, with a multi-step loop (`maxSteps`), per-tool timeouts, errors returned to the model, human confirmation for `confirm: true` tools through the conversation runtime (no FIFO deadlock) and audit events (`onToolEvent`, `bot.on('ai.tool')`). New exports: `defineTool`, `confirmWith`, `runToolLoop`, `AIToolCancelledError` and the tool types; `MockAIProvider` can script tool calls.

`@bot-wa/core`: `bot.enterConversation(nameOrHandler, ctx)` enters a conversation programmatically, fire-and-forget, so a handler can start one and release the chat queue; it returns a promise that settles (never rejects) once the conversation has ended.
