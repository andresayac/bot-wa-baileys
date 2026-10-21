# @bot-wa/inbox

> **Paquete privado** (`"private": true`, no se publica en npm). Implementación real y persistente; la API puede cambiar sin aviso mientras la alpha no salga.

Bandeja de entrada aislada por tenant para conversaciones omnicanal: asignación con compare-and-set (CAS), handoff bot/humano, contadores de no leídos, SLA, notas internas y proyección de los mensajes del ledger del core.

```ts
import { Inbox, KvInboxStore } from '@bot-wa/inbox'
import { PostgresDurableKv } from '@bot-wa/postgres-store'

const inbox = new Inbox(new KvInboxStore(new PostgresDurableKv({ pool })))
const conversation = await inbox.projectMessage(storedMessage)
const assigned = await inbox.assign('acme', conversation.id, 'agent-7', conversation.version)
await inbox.handoff('acme', assigned.id, true, assigned.version)
```

## Almacenamiento

- `MemoryInboxStore` — implementación de referencia, en RAM. Se pierde al reiniciar; úsala en tests.
- `KvInboxStore` — persiste sobre cualquier [`DurableKv`](../core/src/durability/kv.ts) del core (`MemoryKv`, `FileDurability`, `SQLiteDurableKv`, `PostgresDurableKv`, `RedisDurableKv`). Las claves/tablas llevan el tenant (`@bot-wa/tenant-kv`), así que dos tenants con el mismo id de conversación nunca se mezclan.

Ambas pasan la misma suite de conformidad compartida (`test-utils/inbox-store-conformance.ts`). Las suites contra servidores reales (`tests/integration.test.ts`) se activan con `BOTWA_TEST_POSTGRES_URL`, `BOTWA_TEST_REDIS_URL` y `BOTWA_TEST_REDIS_CLUSTER_URL`; SQLite siempre corre con un archivo temporal.

```ts
const sqlite = new SQLiteStore({ file: 'inbox.db' })
const inbox = new Inbox(new KvInboxStore(sqlite.durability().kv))
```

## Concurrencia

Toda mutación de una conversación existente exige `expectedVersion` y es un CAS **atómico en el backend**: dos agentes no pueden pisarse el handoff en silencio. Un desajuste lanza `InboxConflictError` sin escribir nada; una conversación inexistente lanza `InboxNotFoundError`.

`upsert(input, expectedVersion?)` también aplica CAS: sobre una conversación existente exige su versión actual; al crear acepta la versión omitida o `0` (`0` = solo crear).

`projectMessage()` incrementa `unread` de forma atómica sobre el estado más reciente, sin revertir cambios de agentes. La dirección sale de `direction` o, si falta, de `fromMe` (`true` = saliente); un mensaje sin ninguno de los dos se rechaza con `TypeError` sin escribir nada.

## Proyección automática desde un bot

```ts
import { attachInbox } from '@bot-wa/inbox'

const detach = attachInbox(bot, inbox, { tenantId: 'acme' })
// ...
detach()
```

`attachInbox` instala un plugin que proyecta cada mensaje entrante (`bot.on('message')`) y cada envío aceptado (`after('send')`). Un fallo de proyección va al evento `'error'` del bot y nunca bloquea el bot.

## Listados

`list(tenantId, { status?, assigneeId?, limit?, scan? })` devuelve lo más reciente primero. Las conversaciones se ordenan por `updatedAt` descendente y los filtros se aplican dentro de los `scan` (1000 por defecto) más recientes; con `status: 'open' | 'pending'` se escanea solo el índice de no resueltas, así que el historial resuelto nunca las desplaza fuera de la ventana.
