---
"@bot-wa/core": minor
---

Calls from blacklisted or non-whitelisted senders/chats, or into a handed-off chat, are now fully blocked like a message: no `before`/`after('call')` hooks, no `bot.on('call')` event and no `CALL` trigger. Blocked calls count in `metrics().dropped.blocked` / `dropped.handoff` and are debug-logged.
