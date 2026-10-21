---
"@bot-wa/redis-store": minor
---

Add `sessionTtl` (a duration such as `'24h'`, or milliseconds, like every duration option of `@bot-wa/core`) and deprecate `ttl` (seconds). Setting both throws a `RangeError`. Export the `RedisMulti` type.
