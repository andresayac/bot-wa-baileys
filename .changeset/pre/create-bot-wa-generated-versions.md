---
"create-bot-wa": patch
"@bot-wa/baileys": patch
---

`create-bot-wa` stamps `@bot-wa/*` dependency ranges derived at build time from each public package's current version (`^<exact version>`, e.g. `^2.0.0-alpha.2` or `^0.1.1-alpha.0`), instead of hand-written constants like `^0.1.0` that npm does not resolve to a prerelease — freshly scaffolded projects install while the packages are on the `alpha` line. The `@bot-wa/baileys` README links its example on GitHub (the relative link broke on npmjs.com).
