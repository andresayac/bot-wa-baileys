---
"@bot-wa/core": minor
---

Add automatic typing indicator (`BotConfig.typing`), per-reply pacing (`ctx.reply(text, { typing, delay })` on `reply`/`say`/`answer`/`text`/`quote`), `ctx.edit()` for the bot's last message or a given ref (native via `provider.editMessage`, falling back to a new message), `ctx.react(emoji, target?)` that resolves `skipped` on providers without reaction support, and `ctx.supports(feature)` reporting `native` / `degraded` / `unsupported`. A failing typing indicator never fails a send.
