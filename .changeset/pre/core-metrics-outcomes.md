---
"@bot-wa/core": minor
---

Conversation metrics tell early exits apart: `c.end()` ends with the new outcome `'ended'` and a failed `.guard()` (farewell or `redirect`) with `'guarded'` (both used to count as `'completed'`). `ConversationOutcome` gains both values, `ConversationCounters` gains `ended` and `guarded`, and the Prometheus `conversations_ended_total` / `flow_ended_total` families gain the `ended` and `guarded` outcome labels.
