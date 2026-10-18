# Operación: métricas, eventos, inbox y entregas

Esta página cubre dos cosas: las métricas de runtime que expone todo `Bot`
(parte de `@bot-wa/core`) y los paquetes operativos opcionales (journal de
eventos, inbox, CRM, campañas...). Para enviar un mensaje a muchos chats o
iniciar un flujo desde un job, ve [Difusiones](./mensajes#difusiones-broadcast)
e [Iniciar un flujo desde código](./mensajes#iniciar-un-flujo-desde-codigo).

## Métricas de runtime

`bot.metrics()` devuelve una foto en memoria de contadores que solo el motor
conoce. Es JSON plano y no se persiste nada: los contadores son monótonos
desde que se construyó el bot, o desde `bot.resetMetrics()` (que los pone a
cero y conserva el uptime).

```ts
const m = bot.metrics()
// {
//   startedAt, uptimeMs, uptime,   // uptime: '3d 4h', '5m 12s'...
//   conversations: { started, completed, cancelled, timedOut, retriesExceeded, errored, avgDurationMs, active },
//   flows: { registro: { started, completed, cancelled, timedOut, retriesExceeded, errored, avgDurationMs } },
//   messages: { in, out, outFailed },
//   dropped: { duplicate, blocked, handoff },
//   triggered,   // llamadas a bot.trigger() que iniciaron una conversación
//   errors,      // errores reportados en bot.on('error')
// }
```

- `messages.in` cuenta los mensajes e interacciones de entrada aceptados
  tras el dedupe y las listas de acceso. `out` / `outFailed` cuentan los
  envíos que el provider aceptó o rechazó.
- `dropped.duplicate` cuenta las reentregas que descarta el
  [dedupe de entrada](./conceptos#dedupe-de-entrada), `blocked` la blacklist /
  whitelist, y `handoff` los mensajes que no se enrutan porque el chat está
  [en manos de un humano](./handoff).
- `flows` va por nombre de conversación/flujo. `avgDurationMs` es la duración
  media de las conversaciones que ya terminaron (`0` si ninguna terminó).
- `c.end()`, un `.guard()` que falla y un `goto` cuentan como `completed`;
  `/cancel`, `/reset`, un reemplazo o `bot.stop()` cuentan como `cancelled`.

### Prometheus

`toPrometheus(snapshot, { prefix?, labels? })` renderiza una foto en el
formato de texto de Prometheus (0.0.4), sin dependencias. Sírvela con
`PROMETHEUS_CONTENT_TYPE`:

```ts
import { createServer } from 'node:http'
import { toPrometheus, PROMETHEUS_CONTENT_TYPE } from '@bot-wa/core'

createServer((_req, res) => {
  res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE)
  res.end(toPrometheus(bot.metrics(), { labels: { bot: 'ventas' } }))
}).listen(9464)
```

El prefijo por defecto es `botwa_`. Familias: `uptime_seconds`,
`conversations_active`, `conversations_started_total`,
`conversations_ended_total{outcome}`, `conversation_duration_avg_seconds`,
`flow_started_total{flow}`, `flow_ended_total{flow,outcome}`,
`flow_duration_avg_seconds{flow}`, `messages_in_total`,
`messages_out_total{result}` (`sent` / `failed`),
`inbound_dropped_total{reason}` (`duplicate` / `blocked` / `handoff`),
`triggers_total` y `errors_total`. Un prefijo o un nombre de label inválido
lanza `TypeError`.

### Eventos de conversación

```ts
bot.on('conversation:started', ({ id, name, chatId, userId, key }) => { /* ... */ })
bot.on('conversation:ended', ({ id, name, chatId, outcome, completed, durationMs, goto }) => { /* ... */ })
```

- `conversation:started` se emite cada vez que se entra en un flujo o una
  `bot.conversation`: un trigger que coincide, `bot.trigger()`, una
  reanudación dormida o un `c.goto()`.
- `conversation:ended` añade `outcome` (`'completed' | 'cancelled' |
  'timedOut' | 'retriesExceeded' | 'error'`), `completed` (atajo de
  `outcome === 'completed'`), `durationMs` y, si terminó con un `goto`, su
  destino en `goto` (le sigue un nuevo `started`).
- `id` es único por instancia de conversación, así que empareja cada `ended`
  con su `started`. `key` es la clave del runtime (`chatId`, o
  `chatId:userId` para un participante de grupo). Cuando una conversación se
  reemplaza, su `ended` (`outcome: 'cancelled'`) se emite antes del `started`
  de la nueva.
- Un listener que lanza se reporta en `bot.on('error')`; nunca rompe la
  conversación.

## Paquetes operativos

::: warning Paquetes experimentales y prototipos — ninguno está publicado
`@bot-wa/events` es **experimental**: una implementación real y con tests,
pero todavía privada (no está en npm). `@bot-wa/inbox`, `@bot-wa/crm`,
`@bot-wa/hub`, `@bot-wa/campaigns` y `@bot-wa/deployments` son
**prototipos**: esqueletos mínimos en memoria para explorar el diseño. No
persisten nada, no escalan más allá de un proceso y no están pensados para
producción.
:::

Los paquetes operativos son agnósticos de canal y están aislados por tenant.

### Procesamiento de eventos

Usa `MemoryEventJournal` en tests. `FileEventJournal.open('./data/events.json')` persiste el journal de una sola instancia con snapshots atómicos, idempotencia, leases, reintentos y replay. Para múltiples réplicas implementa `EventJournal` sobre PostgreSQL, Redis o un broker.

`EventWorker` reclama eventos, invoca el handler, confirma el trabajo exitoso y mueve a la cola de mensajes muertos (DLQ) los que agotan sus reintentos.

### Inbox y CRM

`@bot-wa/inbox` incorpora asignación con concurrencia optimista, handoff, notas y unread. Proyecta los `StoredMessage` del ledger con `inbox.projectMessage(message)` para reconstruir conversaciones entre canales.

`@bot-wa/crm` guarda canales de contacto, tags, atributos y consentimiento de marketing. Segmenta siempre las campañas con datos aislados por tenant y con consentimiento.

### Campañas, plugins y despliegues

`@bot-wa/campaigns` descarta opt-outs, segmentos que no coinciden y destinatarios duplicados. Un worker durable debe realizar el envío real y registrar el resultado de cada entrega.

`@bot-wa/hub` valida manifiestos de plugins, compatibilidad con el runtime y permisos concedidos antes de habilitar un plugin. Por sí solo no ejecuta ni aísla código no confiable.

`@bot-wa/deployments` registra versiones inmutables y un despliegue activo por tenant/bot. Conéctalo a tu sistema de despliegue para hacer rollouts graduales y rollback físico.
