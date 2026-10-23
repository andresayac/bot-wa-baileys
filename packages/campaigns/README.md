# @botmesh/campaigns

> **Private package** (`"private": true`, not published to npm). Real, persistent implementation; the API may change without notice while the alpha is out.

Campaign planner with consent, tag-based segmentation and durable reservations per tenant/campaign/recipient.

```ts
import { CampaignPlanner, KvCampaignStore, sendCampaign } from '@botmesh/campaigns'
import { PostgresDurableKv } from '@botmesh/postgres-store'

const planner = new CampaignPlanner(new KvCampaignStore(new PostgresDurableKv({ pool })))
const run = await sendCampaign(
  bot, planner,
  { id: 'sale', tenantId: 'acme', requiredTags: ['vip'] },
  [{ id: 'person-1', tenantId: 'acme', channel: 'whatsapp', optedIn: true, tags: ['vip'], chatId: '57300@s.whatsapp.net' }],
  'Nueva promo',
)
// run.deliveries[0].state === 'sent' (o 'failed' con el error real)
```

`CampaignPlanner.plan()` returns `queued` deliveries (with a `deliveryId`) and explainable discards (`opt_out`, `segment`, `duplicate`, `limit`). Planning is separate from sending: a worker reports the real outcome with `markSent(deliveryId)` or `markFailed(deliveryId, error?)`.

- `maxPerRecipient` (integer ≥ 0, default `1`) counts only deliveries confirmed with `markSent`. A `queued` delivery reserves its slot until it settles (so a re-plan does not duplicate sends) and `markFailed` releases it.
- An unresolved reservation stops holding its slot once its TTL expires (`reservationTtl`, 15 minutes by default): a crashed worker never blocks the recipient forever.
- `maxPerRecipient: 0` pauses the campaign: eligible recipients are discarded as `limit`, not `duplicate`.
- `sentCount(tenantId, campaignId, recipientId)` returns the confirmed deliveries.

## Real sending

`sendCampaign(bot, planner, campaign, recipients, content, options?)` plans and sends with `bot.broadcast()` (batched, with concurrency, rate limiting and cancellation), and settles each delivery with the real outcome:

- Accepted by the provider → `markSent` (counts towards `maxPerRecipient`).
- Definitive failure → `markFailed` with the error message.
- Skipped by a `before('send')` hook or left pending by an abort → `markFailed` with `'skipped'` / `'cancelled'` (releases the slot).
- Two recipients with the same `chatId` (default `recipient.id`) are sent once; the repeats fail with `duplicate chatId`.

`CampaignRun` returns the final deliveries, the raw `BroadcastResult` and the settlement errors (if the backend could not commit a change, the TTL releases the reservation).

## Storage

- `MemoryCampaignStore` — reference implementation, in RAM. Lost on restart; use it in tests.
- `KvCampaignStore` — persists over any core [`DurableKv`](../core/src/durability/kv.ts) (`MemoryKv`, `FileDurability`, `SQLiteDurableKv`, `PostgresDurableKv`, `RedisDurableKv`). The state of each `(tenant, campaign, recipient)` is a single document with `sent`, the reservations and the latest deliveries: reservation and settlement are atomic compare-and-set on the backend, even across processes.

Both pass the same conformance suite (`test-utils/campaign-store-conformance.ts`). The suites against real servers (`tests/integration.test.ts`) are enabled with `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_REDIS_URL` and `BOTWA_TEST_REDIS_CLUSTER_URL`; SQLite always runs on a temporary file.

```ts
const sqlite = new SQLiteStore({ file: 'campaigns.db' })
const planner = new CampaignPlanner(new KvCampaignStore(sqlite.durability().kv))
```
