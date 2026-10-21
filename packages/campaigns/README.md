# @botmesh/campaigns

> **Paquete privado** (`"private": true`, no se publica en npm). Implementación real y persistente; la API puede cambiar sin aviso mientras la alpha no salga.

Planificador de campañas con consentimiento, segmentación por tags y reservas durables por tenant/campaña/destinatario.

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

`CampaignPlanner.plan()` devuelve envíos `queued` (con `deliveryId`) y descartes explicables (`opt_out`, `segment`, `duplicate`, `limit`). La planificación está separada del envío: un worker informa del resultado real con `markSent(deliveryId)` o `markFailed(deliveryId, error?)`.

- `maxPerRecipient` (entero ≥ 0, por defecto `1`) cuenta solo los envíos confirmados con `markSent`. Un envío `queued` reserva su hueco hasta que se resuelve (así un re-plan no duplica envíos) y `markFailed` lo libera.
- Una reserva no resuelta deja de ocupar su hueco al vencer su TTL (`reservationTtl`, 15 minutos por defecto): un worker caído no bloquea al destinatario para siempre.
- `maxPerRecipient: 0` pausa la campaña: los destinatarios elegibles se descartan con `limit`, no con `duplicate`.
- `sentCount(tenantId, campaignId, recipientId)` devuelve los envíos confirmados.

## Envío real

`sendCampaign(bot, planner, campaign, recipients, content, options?)` planifica y envía con `bot.broadcast()` (por lotes, con concurrencia, rate-limit y cancelación), y liquida cada delivery con el resultado real:

- Aceptado por el proveedor → `markSent` (cuenta para `maxPerRecipient`).
- Fallo definitivo → `markFailed` con el mensaje del error.
- Descartado por un hook `before('send')` o pendiente por un aborto → `markFailed` con `'skipped'` / `'cancelled'` (libera el hueco).
- Dos destinatarios con el mismo `chatId` (por defecto `recipient.id`) se envían una vez; los repetidos fallan con `duplicate chatId`.

`CampaignRun` devuelve los deliveries finales, el `BroadcastResult` crudo y los errores de liquidación (si el backend no pudo asentar un cambio, el TTL libera la reserva).

## Almacenamiento

- `MemoryCampaignStore` — implementación de referencia, en RAM. Se pierde al reiniciar; úsala en tests.
- `KvCampaignStore` — persiste sobre cualquier [`DurableKv`](../core/src/durability/kv.ts) del core (`MemoryKv`, `FileDurability`, `SQLiteDurableKv`, `PostgresDurableKv`, `RedisDurableKv`). El estado de cada `(tenant, campaña, destinatario)` es un único documento con `sent`, las reservas y los últimos envíos: reserva y liquidación son compare-and-set atómicos en el backend, incluso entre procesos.

Ambas pasan la misma suite de conformidad (`test-utils/campaign-store-conformance.ts`). Las suites contra servidores reales (`tests/integration.test.ts`) se activan con `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_REDIS_URL` y `BOTWA_TEST_REDIS_CLUSTER_URL`; SQLite siempre corre con un archivo temporal.

```ts
const sqlite = new SQLiteStore({ file: 'campaigns.db' })
const planner = new CampaignPlanner(new KvCampaignStore(sqlite.durability().kv))
```
