# @botmesh/inbox

> **Private package** (`"private": true`, not published to npm). Real, persistent implementation; the API may change without notice while the alpha is out.

Tenant-isolated inbox for omnichannel conversations: compare-and-set (CAS) assignment, bot/human handoff, unread counters, SLA, internal notes and projection of the core ledger messages.

```ts
import { Inbox, KvInboxStore } from '@botmesh/inbox'
import { PostgresDurableKv } from '@botmesh/postgres-store'

const inbox = new Inbox(new KvInboxStore(new PostgresDurableKv({ pool })))
const conversation = await inbox.projectMessage(storedMessage)
const assigned = await inbox.assign('acme', conversation.id, 'agent-7', conversation.version)
await inbox.handoff('acme', assigned.id, true, assigned.version)
```

## Storage

- `MemoryInboxStore` — reference implementation, in RAM. Lost on restart; use it in tests.
- `KvInboxStore` — persists over any core [`DurableKv`](../core/src/durability/kv.ts) (`MemoryKv`, `FileDurability`, `SQLiteDurableKv`, `PostgresDurableKv`, `RedisDurableKv`). Keys/tables carry the tenant (`@botmesh/tenant-kv`), so two tenants with the same conversation id never mix.

Both pass the same shared conformance suite (`test-utils/inbox-store-conformance.ts`). The suites against real servers (`tests/integration.test.ts`) are enabled with `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_REDIS_URL` and `BOTWA_TEST_REDIS_CLUSTER_URL`; SQLite always runs on a temporary file.

```ts
const sqlite = new SQLiteStore({ file: 'inbox.db' })
const inbox = new Inbox(new KvInboxStore(sqlite.durability().kv))
```

## Concurrency

Every mutation of an existing conversation requires `expectedVersion` and is an **atomic compare-and-set on the backend**: two agents cannot silently overwrite each other's handoff. A mismatch throws `InboxConflictError` without writing anything; a nonexistent conversation throws `InboxNotFoundError`.

`upsert(input, expectedVersion?)` also applies CAS: on an existing conversation it requires its current version; on create it accepts an omitted version or `0` (`0` = create only).

`projectMessage()` increments `unread` atomically on the latest state, without reverting agents' changes. The direction comes from `direction` or, when missing, from `fromMe` (`true` = outbound); a message with neither is rejected with `TypeError` without writing anything.

## Automatic projection from a bot

```ts
import { attachInbox } from '@botmesh/inbox'

const detach = attachInbox(bot, inbox, { tenantId: 'acme' })
// ...
detach()
```

`attachInbox` installs a plugin that projects every inbound message (`bot.on('message')`) and every accepted send (`after('send')`). A projection failure goes to the bot's `'error'` event and never blocks the bot.

## Listings

`list(tenantId, { status?, assigneeId?, limit?, scan? })` returns the most recent first. Conversations are ordered by `updatedAt` descending and filters apply within the `scan` (1000 by default) most recent ones; with `status: 'open' | 'pending'` only the unresolved index is scanned, so resolved history never pushes them out of the window.
