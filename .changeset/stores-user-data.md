---
"@bot-wa/sqlite-store": minor
"@bot-wa/redis-store": minor
---

Implement the `ctx.user` storage methods (`getUserData`, `setUserData`, `deleteUserData`, `listUserData`, `purgeExpiredUserData`). SQLite adds a `user_data` table with an expiry index; Redis stores one `{prefix}:ud:…` key per entry with native `PX` expiry.
