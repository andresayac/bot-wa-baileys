---
"@bot-wa/core": patch
"@bot-wa/baileys": patch
"@bot-wa/meta": patch
"@bot-wa/telegram": patch
"@bot-wa/sqlite-store": patch
"@bot-wa/redis-store": patch
"@bot-wa/ai": patch
"@bot-wa/http": patch
"@bot-wa/graph-core": patch
---

Packaging: dependencies between `@bot-wa/*` packages are published as caret ranges (`^x.y.z`, from `workspace:^`) instead of exact versions, so npm dedupes a single `@bot-wa/core` instead of installing a second copy when one package lags a patch behind. Published READMEs use absolute GitHub links (relative links broke on npmjs.com), and `@bot-wa/core`/`@bot-wa/http` gain `repository.directory`, `homepage` and `bugs` metadata.
