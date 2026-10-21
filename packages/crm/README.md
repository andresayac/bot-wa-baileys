# @botmesh/crm

> **Paquete privado** (`"private": true`, no se publica en npm). Implementación real y persistente; la API puede cambiar sin aviso mientras la alpha no salga.

CRM ligero por tenant: contactos, canales, tags, atributos, consentimiento de marketing y segmentos por reglas.

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

`upsert()` reemplaza el contacto completo (no hace merge) y guarda los tags deduplicados y ordenados. `segment()` aplica todos los criterios con AND y compara atributos por igualdad estricta (`30` no coincide con `'30'`). `setConsent()` es un compare-and-set: dos escritores concurrentes se reintentan, nunca se pisan.

## Almacenamiento

- `MemoryContactStore` — implementación de referencia, en RAM. Se pierde al reiniciar; úsala en tests.
- `KvContactStore` — persiste sobre cualquier [`DurableKv`](../core/src/durability/kv.ts) del core (`MemoryKv`, `FileDurability`, `SQLiteDurableKv`, `PostgresDurableKv`, `RedisDurableKv`). La tabla lleva el tenant (`@botmesh/tenant-kv`), así que dos tenants con el mismo id de contacto nunca se mezclan.

Ambas pasan la misma suite de conformidad (`test-utils/contact-store-conformance.ts`). Las suites contra servidores reales (`tests/integration.test.ts`) se activan con `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_REDIS_URL` y `BOTWA_TEST_REDIS_CLUSTER_URL`; SQLite siempre corre con un archivo temporal.

```ts
const sqlite = new SQLiteStore({ file: 'crm.db' })
const contacts = new ContactDirectory(new KvContactStore(sqlite.durability().kv))
```

`segment(tenantId, rule, { limit, scan })` devuelve lo más reciente primero: escanea los `scan` (1000 por defecto) contactos más recientes y devuelve hasta `limit` (100 por defecto) coincidencias.

No uses el consentimiento de marketing como autorización para mensajes transaccionales: modela ambos fines por separado en una integración de producción.
