# @bot-wa/crm

CRM ligero por tenant: contactos, canales, tags, atributos y consentimiento de marketing.

```ts
const contacts = new ContactDirectory()
contacts.upsert({ tenantId: 'acme', id: 'person-1', channels: { whatsapp: '57300' }, tags: ['vip'], attributes: { country: 'CO' }, marketingConsent: true })
const recipients = contacts.segment('acme', { tagsAll: ['vip'], marketingConsent: true })
```

No uses el consentimiento de marketing como autorización para mensajes transaccionales: modela ambos fines por separado en una integración de producción.
