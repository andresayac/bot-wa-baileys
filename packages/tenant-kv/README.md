# @botmesh/tenant-kv

> Internal infrastructure · private (`"private": true`, not published to npm).

Tenant-isolated JSON documents with compare-and-set over any `@botmesh/core` `DurableKv`: `MemoryKv`, the `FileDurability` kv, `SQLiteDurableKv` (`@botmesh/sqlite-store`), `PostgresDurableKv` (`@botmesh/postgres-store`) and `RedisDurableKv` (`@botmesh/redis-store`, single node or cluster). It is the storage glue shared by `@botmesh/inbox`, `@botmesh/crm`, `@botmesh/campaigns`, `@botmesh/deployments` and `@botmesh/hub`; it is not meant to be used directly from a bot.

```ts
import { MemoryKv } from '@botmesh/core'
import { TenantDocs } from '@botmesh/tenant-kv'

const docs = new TenantDocs<{ n: number; updatedAt: number }>(new MemoryKv(), {
  family: ['demo', 'counter'],            // tablas product/demo/counter/<tenant>
  parse: (value) => value as { n: number; updatedAt: number },
  order: (doc) => -doc.updatedAt,         // list() returns the most recent first
})

const table = docs.in('acme')
await table.insert('x', { n: 1, updatedAt: Date.now() })
await table.update('x', (cur) => cur && { ...cur, n: cur.n + 1, updatedAt: Date.now() })
await table.list({ limit: 50 })
```

## Design decision

Product packages depend on no driver (`pg`, `redis`, `better-sqlite3`…) and stores do not know about the products: each product persists through the core's public `DurableKv` contract (versioned JSON document + two ordered indexes) and this package puts the shared pieces in one place:

- **Table name** `product/<family…>/<tenant>[/<sub>…]`, with each segment percent-encoded (`encodeSegment`, same alphabet as `@botmesh/redis-store`). The tenant is part of the backend primary key (`(tbl, id)` in Postgres/SQLite, hash tag `{durable:<table>}` in Redis), so no query can cross tenants and a hostile `tenantId` (`a/b`, `}{`, `*`) stays encoded. The `product/` prefix never collides with the core journal tables (`inbox`, `outbox`, `inbox:<scope>`…), so the same kv can back `BotConfig.durability`.
- **Compare-and-set**: the backend's opaque version is what CAS uses; `update(id, fn)` retries up to `attempts` times (32 by default, with a random pause) and then throws `KvContentionError`. There is never a silent overwrite.
- **Validation**: every document read goes through `parse`; if it is not valid JSON or does not match the expected shape, `CorruptDocumentError(table, id)` (the message never includes the content).
- **Bounded listings**: `list({ index: 'all' | 'active', limit, max })` reads at most `limit` ids from the index (ascending by score, ties by id) and re-reads each document. `DurableKv.range` only answers "the N smallest ≤ max", so there is no cursor pagination: products document their bounds (`limit`/`scan`).

## Limits

- One table per tenant means one hash slot per tenant-table in Redis Cluster: a very hot tenant concentrates its traffic on a single node.
- Index scores must be safe integers (Postgres and SQLite store them as 64-bit integers).
- Whoever creates the `DurableKv` calls `start()`/`stop()`; this package never does.
