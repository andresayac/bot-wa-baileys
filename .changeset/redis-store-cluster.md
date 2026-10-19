---
"@bot-wa/redis-store": minor
---

Redis Cluster support (opt-in). Pass a node-redis cluster client, or the new `cluster: { rootNodes, nodeAddressMap?, defaults? }` option (also on `RedisCoordinator` and `RedisDurability`), and `RedisStore`, `coordinator()`, `schedules()`, `leases()` and `RedisDurability` switch to the `'cluster'` key layout (new `layout` option). In that layout every multi-key script stays in one hash slot (hash-tagged key groups), listings read per-bucket index sorted sets instead of `KEYS`/`SCAN`, and `MULTI` is not used. `TRYAGAIN`/`CLUSTERDOWN` and redirects node-redis did not follow are retried (`withClusterRetry`). Without configuration nothing changes: the default `'legacy'` layout keeps every key name, script and command.

A node-redis 4 cluster client now has its `EVAL` routed by its first key (`cluster.eval(script, { keys })` used the wrong argument and could fail with `MOVED`). This also fixes `RedisDurability`, `RedisScheduleStore` and `RedisLeaseProvider` on a cluster client.

New `migrateToClusterLayout()` copies an existing keyspace offline, in place or into a cluster. It keeps TTLs, fences only grow, it is resumable, and `direction: 'cluster-to-legacy'` rolls back. `inspectKeyspace()` counts keys per layout. Also exported: `isRedisClusterClient`, `hashSlot`, `bucketOf`, `encodeSegment`, `INDEX_BUCKETS`, `LAYOUT_MARKER`, and the related types.
