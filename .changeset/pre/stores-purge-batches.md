---
"@bot-wa/sqlite-store": minor
---

New `purgeBatchSize` option (default `1000`): `purgeExpiredUserData` deletes expired `ctx.user` rows in batches and yields to the event loop between them, instead of one unbounded `DELETE`.
