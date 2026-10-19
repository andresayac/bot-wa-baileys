---
"@bot-wa/core": patch
---

`ctx.typing()`, `ctx.recording()`, `ctx.replyWithTyping()` and the `ctx.stream()` indicator are best-effort: a rejecting or throwing `provider.typing()` is logged at debug and ignored, so a failing indicator never aborts the reply after it. The Bot's default logger (no `logger`, no `debug`) now logs at `warn` instead of `error`, so warnings from plugins and handlers (e.g. a failed AI autoreply) are visible without `debug: true`.
