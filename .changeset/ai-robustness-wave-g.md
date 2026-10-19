---
"@bot-wa/ai": patch
---

Robustness fixes across the AI plugin:

- The chat history handed to the providers always starts with a user turn and has no blank turns: an odd `context.maxMessages` no longer makes Anthropic/Gemini reject every later call, and an empty model answer is no longer stored (it used to poison the chat until `/reset`). The one-shot autoreply answers `errorMessage` (and logs a warning) instead of sending a blank message.
- Refusals are reported uniformly as `stopReason: 'refusal'` (so `refusalMessage` is used): OpenAI `message.refusal` / streamed refusal deltas, and Gemini safety blocks (finish reason `SAFETY`, `RECITATION`, … or a blocked prompt), which used to throw.
- Gemini and Ollama streams now call `onStreamEnd` with the stop reason (streamed refusals are detected there too).
- Ollama: the last NDJSON line of a stream is no longer dropped when it has no trailing newline, an `{"error"}` line rejects, HTTP errors include the server message, and `maxTokens` is sent as `options.num_predict` when set.
- OpenAI-compatible gateways that answer HTTP 200 with `{ error }` reject with that message instead of producing an empty reply.
- `baseUrl` is passed to the Anthropic SDK (gateways / proxies).
- `LazyProvider` retries a failed provider resolution on the next call instead of caching the failure forever.
- JSON Schema validation of tool arguments checks own keys only (`required` / `additionalProperties: false` are no longer fooled by `toString`, `constructor`, …).
- `formatMarkdown(..., 'html')` escapes `"` inside link URLs.
- A memory extraction cut off by the token cap reports an actionable error (raise `memory.autoExtract.maxTokens`).
- An unknown `provider` name now lists the valid ones in the error.
