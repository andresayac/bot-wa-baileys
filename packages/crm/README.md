# @bot-wa/crm

> [!WARNING]
> **Prototipo en memoria · privado (`"private": true`, no se publica en npm).**
> El estado vive en RAM y se pierde al reiniciar; no hay persistencia, búsqueda ni identidad unificada entre canales, y la API puede cambiar sin aviso. Sirve para fijar el contrato antes de la implementación durable.
>
> Roadmap: track [E. Inbox, contactos y CRM ligero](../../ROADMAP.md#e-inbox-contactos-y-crm-ligero), fase [F4 — Operación y producto](../../ROADMAP.md#f4--operación-y-producto) («Contactos, tags, segmentos y consentimiento»).

CRM ligero por tenant: contactos, canales, tags, atributos y consentimiento de marketing.

```ts
import { ContactDirectory } from '@bot-wa/crm'

const contacts = new ContactDirectory()
contacts.upsert({
  tenantId: 'acme',
  id: 'person-1',
  channels: { whatsapp: '57300' },
  tags: ['vip'],
  attributes: { country: 'CO' },
  marketingConsent: true,
})
const recipients = contacts.segment('acme', { tagsAll: ['vip'], marketingConsent: true })
```

`upsert()` reemplaza el contacto completo (no hace merge) y guarda los tags deduplicados y ordenados.

No uses el consentimiento de marketing como autorización para mensajes transaccionales: modela ambos fines por separado en una integración de producción.
