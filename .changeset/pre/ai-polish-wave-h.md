---
"@bot-wa/ai": patch
---

Tool loop, thinking and sources polish:

- `thinking: { budgetTokens }` must be a positive integer: NaN, ±Infinity, fractions, zero, negatives or a non-number throw a `RangeError` from `aiPlugin()` / `new AnthropicProvider()` instead of reaching the API.
- Tool calls cut off by the output-token cap on the last allowed step are reported as truncated (`tool.truncated` events, `truncatedToolCalls`, `stopReason` `'max_tokens'`) with a clear localized reply (`ai.tools.truncated`) instead of the generic `maxSteps` message.
- `appendSources`: a cited passage without `citation`/`source` is listed as `[2]` instead of `[2] #2`.
- The `AIThinking` doc comment now says which models accept, deprecate or reject thinking budgets.
