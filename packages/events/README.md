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
