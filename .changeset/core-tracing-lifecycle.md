---
"@bot-wa/core": minor
---

Tracing of the bot lifecycle: each lifecycle step (`storage`, `coordination`, `restore`, `durability`, `transport`, `jobs`) opens a root `bot.lifecycle` span with `bot.lifecycle.step` / `bot.lifecycle.phase` (`start`, `stop` after the drain, `rollback` of a failed `start()`), `bot.id` and `bot.provider.id`. The `transport` span measures the provider handshake (Baileys connect + QR, Telegram polling, IMAP login), so a slow boot or a provider that refuses to start is visible in the trace. New `SPAN_NAMES.lifecycle` and `TRACE_ATTR.lifecycleStep` / `lifecyclePhase`. Without `BotConfig.telemetry` the steps run unwrapped, exactly as before.
