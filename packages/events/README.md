# @bot-wa/events

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

journal.append(event)
const worker = new EventWorker(journal, {
  'message.received': async (received) => {
    console.log(received.payload)
  },
})

await worker.runBatch()
```

`MemoryEventJournal` sirve para desarrollo y pruebas. La interfaz `EventJournal` permite implementar adaptadores durables sobre Redis, PostgreSQL o un broker externo sin cambiar los workers.

Para una instancia única también existe `FileEventJournal.open('./data/events.json')`: recupera el snapshot tras un reinicio y escribe con reemplazo atómico. No se recomienda para múltiples réplicas; usa un adaptador coordinado en ese caso.
