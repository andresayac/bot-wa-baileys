# @bot-wa/campaigns

> [!WARNING]
> **Prototipo en memoria · privado (`"private": true`, no se publica en npm).**
> El estado de deduplicación vive en RAM y se pierde al reiniciar; no hay programación, rate limiting, templates por canal ni envío real, y la API puede cambiar sin aviso. Sirve para fijar el contrato antes de la implementación durable.
>
> Roadmap: track [F. Campañas y automatización](../../ROADMAP.md#f-campañas-y-automatización), fase [F5 — Ecosistema y escala](../../ROADMAP.md#f5--ecosistema-y-escala) («Campañas compliance-first»).

Planificador de campañas con consentimiento, segmentación por tags y deduplicación por tenant/campaña/destinatario.

```ts
import { CampaignPlanner } from '@bot-wa/campaigns'

const planner = new CampaignPlanner()
const deliveries = planner.plan(
  { id: 'sale', tenantId: 'acme', requiredTags: ['vip'] },
  [{ id: 'person-1', tenantId: 'acme', channel: 'whatsapp', optedIn: true, tags: ['vip'] }],
)

for (const delivery of deliveries) {
  if (delivery.state !== 'queued') continue
  try {
    await send(delivery.recipientId)
    planner.markSent(delivery.deliveryId!)
  } catch (error) {
    planner.markFailed(delivery.deliveryId!, String(error))
  }
}
```

`CampaignPlanner.plan()` devuelve envíos `queued` (con `deliveryId`) y descartes explicables (`opt_out`, `segment`, `duplicate`, `limit`). La planificación está separada del envío: el worker informa del resultado real con `markSent(deliveryId)` o `markFailed(deliveryId, error?)`.

- `maxPerRecipient` (entero ≥ 0, por defecto `1`) cuenta solo los envíos confirmados con `markSent`. Un envío `queued` reserva su hueco hasta que se resuelve (así un re-plan no duplica envíos) y `markFailed` lo libera.
- `maxPerRecipient: 0` pausa la campaña: los destinatarios elegibles se descartan con `limit`, no con `duplicate`.
- `sentCount(tenantId, campaignId, recipientId)` devuelve los envíos confirmados.
