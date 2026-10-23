# @botmesh/crm

> **Private package** (`"private": true`, not published to npm). Real, persistent implementation; the API may change without notice while the alpha is out.

Lightweight per-tenant CRM: contacts, channels, tags, attributes, marketing consent and rule-based segments.

```ts
import { ContactDirectory, KvContactStore } from '@botmesh/crm'
import { PostgresDurableKv } from '@botmesh/postgres-store'

const contacts = new ContactDirectory(new KvContactStore(new PostgresDurableKv({ pool })))
await contacts.upsert({
  tenantId: 'acme',
  id: 'person-1',
  channels: { whatsapp: '57300' },
  tags: ['vip'],
  attributes: { country: 'CO' },
  marketingConsent: true,
})
const recipients = await contacts.segment('acme', { tagsAll: ['vip'], marketingConsent: true })
```

`upsert()` replaces the whole contact (no merge) and stores tags deduplicated and sorted. `segment()` applies every criterion with AND and compares attributes by strict equality (`30` does not match `'30'`). `setConsent()` is a compare-and-set: two concurrent writers retry, never overwrite each other.

## Storage

- `MemoryContactStore` — reference implementation, in RAM. Lost on restart; use it in tests.
- `KvContactStore` — persists over any core [`DurableKv`](../core/src/durability/kv.ts) (`MemoryKv`, `FileDurability`, `SQLiteDurableKv`, `PostgresDurableKv`, `RedisDurableKv`). The table carries the tenant (`@botmesh/tenant-kv`), so two tenants with the same contact id never mix.

Both pass the same conformance suite (`test-utils/contact-store-conformance.ts`). The suites against real servers (`tests/integration.test.ts`) are enabled with `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_REDIS_URL` and `BOTWA_TEST_REDIS_CLUSTER_URL`; SQLite always runs on a temporary file.

```ts
const sqlite = new SQLiteStore({ file: 'crm.db' })
const contacts = new ContactDirectory(new KvContactStore(sqlite.durability().kv))
```

`segment(tenantId, rule, { limit, scan })` returns the most recent first: it scans the `scan` (1000 by default) most recent contacts and returns up to `limit` (100 by default) matches.

Do not use marketing consent as authorization for transactional messages: model both purposes separately in a production integration.
