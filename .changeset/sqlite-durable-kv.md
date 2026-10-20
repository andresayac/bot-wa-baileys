---
"@bot-wa/sqlite-store": minor
---

`SQLiteDurableKv` and `SQLiteDurability`: core's `DurableKv` and durability backend (`BotConfig.durability`) on SQLite, in one table `durable` whose every write is a single statement conditioned on the stored version (atomic compare-and-set across processes on one file). `store.durability()` returns the backend on the store's own connection (`new Bot({ store, durability: { journal: store.durability() } })`); its `kv` is also what the product packages (`@bot-wa/inbox`, `@bot-wa/crm`, `@bot-wa/campaigns`, `@bot-wa/deployments`, `@bot-wa/hub`) persist to. Opt-in: nothing changes for existing stores until it is called.
