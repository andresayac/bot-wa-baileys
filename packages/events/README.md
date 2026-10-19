# @bot-wa/events

> **Experimental — aún no publicado en npm.** Implementación real y con tests, pero el paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Primitivas sin dependencias para procesar trabajo asíncrono de forma fiable: envelopes versionados, idempotencia, leases, reintentos con backoff y cola de mensajes muertos (DLQ).

```ts
import { createEnvelope, EventWorker, MemoryEventJournal } from '@bot-wa/events'

const journal = new MemoryEventJournal()
const event = createEnvelope({
  eventType: 'message.received',
  context: {
    tenantId: 'acme', environmentId: 'production', botId: 'support',
    providerId: 'meta', connectionId: 'main', chatId: '573001234567',
  },
  payload: { text: 'hola' },
})

await journal.append(event)
const worker = new EventWorker(journal, { maxAttempts: 5, leaseMs: 30_000 })
worker.on('message.received', async (received) => {
  console.log(received.payload)
})

const { processed, failed, stale } = await worker.runBatch()
```

### Leases y fencing tokens

Cada `claim` entrega un `fencingToken` estrictamente creciente por evento (nunca se reutiliza, ni tras `replay`). `EventWorker` lo devuelve en `ack`/`fail`, y el journal rechaza un token superado con `StaleLeaseError`. Así, si el lease de un worker expira mientras su handler sigue corriendo y otro worker reclama el evento, el primero ya no puede marcarlo como hecho, reintentarlo ni mandarlo a la DLQ: `runBatch()` lo cuenta como `stale`. También se salta un registro cuyo lease venció antes de empezar su handler y lo devuelve con `release()`, que no gasta el intento: saltárselo nunca lo acerca a la DLQ.

La entrega sigue siendo *at-least-once*: un handler puede ejecutarse dos veces, así que hazlo idempotente (usa `envelope.idempotencyKey`). Llamar a `ack`/`fail` sin `fencingToken` es un override de operador sin comprobación. Un adaptador propio de `EventJournal` debe comprobar el token en la misma operación atómica que cambia el estado (p. ej. `UPDATE ... WHERE fencing_token = $1 AND state = 'processing'`).

Para tests, inyecta el reloj: `new EventWorker(journal, { clock: () => now })`.

`MemoryEventJournal` sirve para desarrollo y pruebas. La interfaz `EventJournal` permite implementar adaptadores durables sobre Redis, PostgreSQL o un broker externo sin cambiar los workers.

Para una instancia única también existe `FileEventJournal.open('./data/events.json')`: recupera el snapshot tras un reinicio y escribe con reemplazo atómico. No se recomienda para múltiples réplicas; usa un adaptador coordinado en ese caso.

### Backend de durabilidad del bot (`@bot-wa/events/durability`)

Si tu app ya usa un journal de eventos, puede servir también como backend de la [durabilidad](../../docs/es/guide/durabilidad.md) del bot (`BotConfig.durability`), sin otro store:

```ts
import { Bot } from '@bot-wa/core'
import { FileEventJournal } from '@bot-wa/events'
import { eventsDurability } from '@bot-wa/events/durability'

const journal = await FileEventJournal.open('./data/events.json', { lock: true })
const bot = new Bot({ provider, durability: { journal: eventsDurability({ journal }) } })
// …
await bot.stop()
await journal.close()
```

- **Inbox:** cada mensaje entrante del bot se guarda como un `EventRecord` del journal (`eventType: 'botwa.inbound.message'`, canal `'botwa:durable'`), con sus leases y fencing tokens. `list()` y `replay()` del journal los ven; un `EventWorker` **nunca** los reclama, porque un `claim` sin `channel` solo toma registros sin canal. Quien procesa esos registros es el propio bot (FIFO por chat, causalidad, ack al asentarse).
- **Outbox:** las máquinas de estado del outbox del core sobre un almacén clave-valor guardado como *sidecar* del mismo journal: mismo archivo y mismo snapshot atómico que la inbox. El archivo pasa al formato `version: 2` en cuanto hay un sidecar; un proceso que solo usa eventos lo reescribe conservando ese sidecar.
- `FileEventJournal` necesita `{ lock: true }`: un candado consultivo (`<archivo>.lock` con el pid) impide que dos procesos usen el mismo archivo; el de un proceso muerto se toma. Nunca se mata ningún proceso. Dentro de un mismo proceso, un segundo `open(ruta, { lock: true })` del mismo archivo se rechaza hasta que se llama a `close()` sobre el primero; tras `close()`, las escrituras rechazan.
- Coste: `FileEventJournal` reescribe el archivo entero en cada escritura (eventos de la app + registros del bot durante la retención + outbox). Las escrituras concurrentes comparten una sola reescritura y `extend()` (el heartbeat del lease) solo cambia la memoria: se escribe con el siguiente cambio o con `close()`. Con tráfico alto, usa un archivo propio para el bot, una retención corta o un `outbox` de base de datos.
- Varias réplicas necesitan un `LeasedEventJournal` compartido con operaciones atómicas y con fencing, más un `outbox` compartido (un `DurableKv` de Postgres o Redis). No se incluye ninguno: es el contrato para quien escriba el adaptador.

`LeasedEventJournal` (implementado por `MemoryEventJournal` y `FileEventJournal`) añade a `EventJournal` estas operaciones atómicas: `appendRecord` (opcionalmente ya reclamado), `claimOne`, `extend`, `purge`, y `claim` con `owner`/`reclaimOwn`/`channel`/`filter`/`order`. También añade `fail` con `dead`/`retryAt` explícitos, `release` con `toPending` y `sidecar()`. Las llamadas que ya existían se comportan igual.
