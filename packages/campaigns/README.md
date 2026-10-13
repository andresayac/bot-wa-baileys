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
```

`CampaignPlanner.plan()` devuelve envíos `queued` y descartes explicables (`opt_out`, `segment`, `duplicate`). Un worker durable debe consumir los `queued` y registrar los resultados reales de envío.
