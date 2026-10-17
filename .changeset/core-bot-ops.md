---
"@bot-wa/core": minor
---

Bot operations: `bot.broadcast(chatIds, content, { batchSize, delayBetween, concurrency, maxRetries, onProgress, onFail, signal })` now batches, honours `RateLimitedError.retryAfterMs` (pausing every worker) and is cancellable; it resolves `{ total, sent, failed, skipped, errors, messages, cancelled, pending }` (breaking: `sent`/`failed` are now counts — the accepted sends moved to `messages`, the failures to `errors`). New `bot.trigger(name, { chatId, userId?, isGroup?, data?, ifActive? })` starts a registered flow/conversation with `c.state` seeded from `data`, through the access-list and handoff gates and the chat's FIFO queue. New `bot.metrics()` / `bot.resetMetrics()` runtime counters, `'conversation:started'` / `'conversation:ended'` events (`{ name, chatId, userId, key, outcome, completed, durationMs, goto? }`) and a dependency-free Prometheus exporter `toPrometheus(snapshot, { prefix?, labels? })`.
