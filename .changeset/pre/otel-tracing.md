---
"@bot-wa/core": minor
"@bot-wa/ai": minor
---

Tracing hooks, opt-in through `BotConfig.telemetry`. Without the key nothing changes (no span code runs). With a `BotTracer` (OpenTelemetry through the private `@bot-wa/otel`, or your own) the bot emits spans for inbound events, persistence, dispatch (queue wait, routing stage), handlers, conversation turns (one per stretch between waits; flow steps as events), triggers, broadcasts, pacing and sends, with chat/sender/message ids hashed by default (`ids: 'hash' | 'raw' | 'omit'`, `idKey`) and never message bodies, prompts or error messages (unless `errorMessages: true`). A throwing tracer never breaks the bot. New API: `bot.tracing`, the `BotTracer`/`BotTracing`/`BotSpan`/`TelemetryConfig` types, `TRACE_ATTR`, `SPAN_NAMES`, `noopTracer`, `NOOP_TRACING`, `errorTypeOf`, and `createRecordingTracer()` in `@bot-wa/core/testing`. `Dispatcher.conversationMatcher()` takes an optional `{ flow }`.

`@bot-wa/ai`: `AIClientOptions.tracing` (aiPlugin passes `bot.tracing`) and `providerName`. Model calls become `chat {model}` spans with OpenTelemetry GenAI attributes (models, token usage, finish reason, purpose; a timeout is `error.type = timeout`), tool calls `execute_tool {name}` spans with their outcome, and RAG retrieval a `bot.ai.retrieve` span; no prompts, completions, arguments or results are recorded. `GenerateInput.onStreamEnd` also reports `usage` when the provider streams it (Anthropic, Gemini).
