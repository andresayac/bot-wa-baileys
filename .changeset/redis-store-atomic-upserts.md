---
"@bot-wa/redis-store": patch
---

`upsertChat` / `upsertContact` are now atomic across replicas: the write is a compare-and-set Lua script that re-reads and merges again when another process changed the record in between, so concurrent upserts from any number of replicas never lose each other's fields. The merge runs in JS (`{ ...existing, ...patch }`, an explicit `undefined` removes the field), so values are stored byte-exact. Under pathological contention an upsert fails after 50 attempts.
