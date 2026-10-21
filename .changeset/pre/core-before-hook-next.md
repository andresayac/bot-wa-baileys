---
"@bot-wa/core": minor
---

**Breaking:** a `before` hook that returns without calling `next()` now stops the event exactly like `abort()` (the message is not routed, the send is skipped, the provider event is not emitted). It used to skip only the remaining `before` hooks while the message was still routed. Observer and rewriting hooks must end with `await next()`.
