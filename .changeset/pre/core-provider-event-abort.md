---
"@bot-wa/core": patch
---

Provider events (`reaction`, `poll`, `group`, `presence`, `status`, `call`) follow the same hook contract as `message` and `send`: a `before` hook that aborts now suppresses the `after` hooks and the `bot.on(...)` event, which used to run anyway.
