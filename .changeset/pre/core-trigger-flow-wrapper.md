---
"@bot-wa/core": minor
---

`bot.triggerFlow()` is now a thin wrapper over `bot.trigger()` with `ifActive: 'replace'` and returns `Promise<boolean>`: it goes through the same access-list and handoff gates, the chat's FIFO slot, i18n language resolution, the messaging/typing/edit/stream seams and the `triggered` metric. `TriggerOptions` gains `body` (the synthetic message's `ctx.body`).
