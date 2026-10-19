---
"@bot-wa/ai": minor
---

Model-aware Anthropic thinking, safer tool loop, roomier memory extraction and stable source numbers:

- New `thinking` option (`'auto' | 'adaptive' | 'off' | { budgetTokens }`, default `'auto'`). The Anthropic provider used to always send `thinking: { type: 'adaptive' }`, which models before 4.6 (e.g. `claude-haiku-4-5`) reject with a 400. `'auto'` now sends it only to models that support it (Opus/Sonnet 4.6+, Haiku 5+, Fable, Mythos and unknown ids), and `effort` only to models that accept it. `{ budgetTokens }` enables budgeted thinking on older models. A 400 whose message names `thinking`/`effort` is retried once without that parameter, and the model is remembered. New `anthropicModelSupport(model)` helper.
- The tool loop never runs tool calls cut off by the output-token cap (`stopReason` `max_tokens` / `length` / `MAX_TOKENS`): their arguments may be incomplete. The model gets an error result explaining it, a `tool.truncated` event is emitted, the plugin logs a warning and `ToolLoopResult.truncatedToolCalls` counts them.
- `memory.autoExtract.maxTokens` defaults to 1024 instead of 300 (still a soft cap that Ollama ignores), so reasoning models no longer spend the whole budget thinking.
- `rag.appendSources` keeps the original `[n]` of the cited passages (`Fuentes: [2] b.md`); uncited replies still list every source unnumbered. A custom `appendSources` function receives a second `cited` argument (`{ n, chunk }[]`); new `citedPassages()` helper. Visible change: the default sources line now carries the numbers.
