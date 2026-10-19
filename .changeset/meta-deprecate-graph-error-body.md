---
"@bot-wa/meta": patch
---

Deprecate the unused `GraphErrorBody` type export (Graph responses go through `readGraphResponse()` from `@bot-wa/graph-core`); `GraphSendMessageResponse['error']` keeps the same shape.
