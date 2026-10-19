# Varias réplicas

Por defecto un bot es **un proceso**: cada chat tiene una cola FIFO en
memoria y el transporte se conecta una vez. Para correr varias copias del
mismo bot (disponibilidad, despliegues sin corte o más capacidad de
webhooks), activa la **coordinación**. Las réplicas comparten entonces un
backend (Redis) que decide qué réplica procesa cada chat y cuál conecta un
transporte exclusivo como WhatsApp Web.

La coordinación es opcional. Sin `coordination` no se ejecuta nada de lo que
sigue y el bot se comporta exactamente como antes.

## Cuándo la necesitas (y cuándo no)

| Situación | ¿Réplicas? |
| --- | --- |
| Un número de WhatsApp con Baileys y puedes tolerar un reinicio de vez en cuando | No: un proceso con reinicio de PM2/Docker es más simple |
| Baileys, y quieres una réplica en espera que tome el relevo en segundos | Sí: 1 activa + N en espera |
| Webhooks de Cloud API / Messenger / Telegram detrás de un balanceador | Sí: todas las réplicas reciben tráfico |
| Despliegues escalonados sin corte | Sí |

## Configuración

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { RedisStore } from '@bot-wa/redis-store'

const store = new RedisStore({ url: process.env.REDIS_URL, prefix: 'tienda' })

const bot = new Bot({
  provider: new BaileysProvider({ session: 'tienda' }),
  store,                                     // estado compartido: chats, checkpoints, ctx.user
  coordination: {
    coordinator: store.coordinator({ leaseMs: '15s' }), // mismo cliente y prefijo que el store
    // turnWaitMs: '2m',        // máximo que un mensaje espera el turno de su chat
    // settleMs: '1m',          // máximo que se retiene un turno por un paso de conversación en curso
    // providerSession: 'auto', // 'leader' | 'shared' | 'auto'
    // providerDownMs: '1m',    // una líder con el transporte cerrado este tiempo cede el puesto
  },
})
await bot.start()
```

Todas las réplicas corren el mismo código. Usa el mismo `prefix` en todas;
el id de réplica es un UUID aleatorio por proceso salvo que pases
`replicaId` (debe ser único entre las réplicas en marcha; sirve el nombre del
pod o del host). Cada instancia del coordinador añade su propio nonce en Redis
(`coordinator.incarnation`), así que una réplica reiniciada con el mismo
`replicaId` nunca hereda los turnos del proceso que murió. Con tu propia
conexión a Redis usa `new RedisCoordinator({ url, prefix })` en lugar de
`store.coordinator()`.

## Qué obtienes

**Una réplica por chat a la vez, en orden.** Cuando llega un mensaje, la
réplica que lo recibe toma un turno en la cola de ese chat en Redis. Los
turnos del chat se conceden en ese orden, sea cual sea la réplica, y solo una
réplica tiene el turno de un chat a la vez. Así, dos mensajes de un chat
nunca se procesan en paralelo y se atienden en el orden en que llegaron,
aunque un balanceador los reparta entre réplicas. Los chats distintos corren
en paralelo. En grupos la clave es por participante, igual que el alcance de
las conversaciones.

El turno se mantiene hasta que el handler termina **y** la conversación que
recibió el mensaje vuelve a esperar (o termina), también a través de un
`c.goto()`, así que otra réplica nunca ve un flujo a mitad de un paso.
`settleMs` limita esa espera: un paso que siga en marcha entonces (un `.do()`
lento, un `c.sleep` o un delay largos) se detiene, conservando su checkpoint,
antes de soltar el turno, de modo que nunca corre a la vez que la réplica que
recibe el chat después. Mantén `settleMs` por encima de tu paso más largo.

Los temporizadores de una conversación (su timeout de espera, `c.idle()`)
también actúan solo con el turno del chat. Si otra réplica atendió el chat
entretanto, la copia obsoleta se descarta en lugar de escribir al usuario o
borrar el checkpoint de la nueva dueña.

**Las conversaciones pasan de una réplica a otra a través del store.** Si el
siguiente mensaje de un flujo `.persistent()` llega a otra réplica, esa
réplica lee el checkpoint del store y sigue. Si el flujo esperaba en la
primera pregunta de su paso, el mensaje se toma como esa respuesta (no se
vuelve a preguntar). Si no (un paso `.do()` que esperaba en una pregunta
posterior, o una réplica que murió antes de preguntar), el paso se repite
desde el principio y hace su primera pregunta. La réplica que tenía el flujo
en memoria descarta su copia la próxima vez que reciba ese chat (o cuando
salte uno de sus temporizadores).

**Una sola conexión para los transportes exclusivos.** Con
`providerSession: 'auto'` (por defecto), un provider que declara
`capabilities.exclusiveSession` solo se arranca en la réplica elegida para
`provider:<id>`; las demás esperan y una de ellas toma el relevo cuando la
líder se detiene o muere.

| Provider | `exclusiveSession` | Con N réplicas |
| --- | --- | --- |
| `@bot-wa/baileys` | `true` | 1 conectada + en espera |
| `@bot-wa/telegram` (long polling) | `true` | 1 haciendo polling + en espera |
| `@bot-wa/telegram` (webhook) | `false` | todas reciben |
| `@bot-wa/discord` | `true` | 1 gateway + en espera |
| `@bot-wa/meta`, Messenger, Instagram y otros providers de webhook | sin definir (`false`) | todas reciben |

Si el transporte de la líder sigue `'closed'` durante `providerDownMs`
(sesión cerrada, sesión tomada por otro, reconexión abandonada), la réplica
cede el puesto, espera unos segundos y vuelve a presentarse, para que una
réplica en espera conecte entretanto.

Fuérzalo con `providerSession: 'leader'` o `'shared'`. En una réplica en
espera, `bot.ready` sigue pendiente (el transporte no está conectado) y
`bot.send()` rechaza con `ProviderNotLeaderError`.

**Relevo ante caídas.** Cada réplica renueva un heartbeat y sus leases cada
`leaseMs / 3`. Cuando una réplica muere, sus leases caducan tras `leaseMs` y
las demás siguen: los turnos en cola de la réplica muerta se saltan y una
réplica en espera conecta el transporte. Cuando una réplica se queda
congelada (pausa del GC, event loop bloqueado, red caída) durante casi todo
`leaseMs`, suelta sus leases **antes** de que caduquen en Redis: un envío que
intente después rechaza con `LeaseLostError` en lugar de responder fuera de
orden, y su conversación en memoria de ese chat se descarta (el checkpoint se
queda para la nueva dueña). Una liberación que falla en la red (un corte
breve de Redis) la repara el watchdog en `leaseMs / 3`, así que el chat no
se queda bloqueado detrás de una réplica viva.

## Requisitos y límites

- **Un store compartido** (`RedisStore`, o Postgres/Mongo/MySQL). Con
  `MemoryStore`/`SQLiteStore` cada réplica tiene sus propios datos.
- **Los flujos de varios turnos deberían ser `.persistent()`.** Un
  `bot.conversation` o un flujo no persistente vive en la memoria de la
  réplica que lo inició; si el siguiente mensaje llega a otra réplica, se
  enruta como un mensaje nuevo. Un flujo persistente solo se guarda tras su
  primer paso, así que empiézalo con un `.say()` si la primera pregunta debe
  sobrevivir a un cambio de réplica.
- **El dedupe de entrada es por proceso.** Un reintento de webhook que llegue
  a otra réplica se procesa otra vez. Haz los handlers idempotentes, o deja
  el transporte en una sola réplica (`'leader'`).
- **Un mensaje que espera turno en una réplica que muere se pierde** (como en
  un único proceso que se cae). El procesamiento de entrada durable es trabajo
  planificado.
- **Las tareas programadas (`bot.schedule/every`) corren en todas las
  réplicas.** Usa una tarea solo-líder con `coordinator.tryLead(nombre)` o el
  lock con fencing de abajo.
- **Un paso de conversación más largo que `settleMs` se interrumpe** (ver
  arriba): sube `settleMs` para trabajo largo en `.do()` o delays.
- **Redis**: un primario (standalone o Sentinel). Un failover que pierda las
  últimas escrituras puede conceder un lease dos veces. Redis Cluster no está
  soportado.

## Cómo elegir `leaseMs`

`leaseMs` (por defecto `15s`) es el tiempo de relevo tras una caída, y
también cuánto puede congelarse una réplica antes de soltar sus chats.
Mantenlo bastante por encima de tu peor pausa del event loop y del tiempo de
ida y vuelta a Redis; entre 5 y 30 segundos sirve para la mayoría de bots.
Mientras espera un turno, la réplica consulta Redis cada 5 a 100 ms
(`maxPollMs`).

## Eventos

```ts
bot.on('coordination:leader', ({ name, fence }) => log.info({ name, fence }, 'transporte conectado'))
bot.on('coordination:follower', ({ name, reason }) => log.warn({ name, reason }, 'en espera'))
bot.on('coordination:lease-lost', ({ key, reason }) => log.warn({ key, reason }, 'lease perdido'))
bot.on('error', ({ error }) => {
  // CoordinationUnavailableError: un mensaje no consiguió su turno (timeout o Redis caído)
})
```

## Tareas únicas y locks con fencing

```ts
const coordinator = store.coordinator()
bot.every('5m', async () => {
  const lead = await coordinator.tryLead('job:informe')   // null en las demás réplicas
  if (!lead) return
  try { await enviarInforme() } finally { await lead.release() }
})
```

Para tus propias secciones críticas, `store.acquireLockFenced(key, ttlMs)`
devuelve `{ token, fence }`: el fence crece en cada adquisición, así que un
recurso puede rechazar la escritura de un dueño que se quedó congelado más
allá de su lock. Alarga una sección larga con `renewLock(key, token, ttlMs)`
y libera con `releaseLock(key, token)`. El `acquireLock` anterior sigue
funcionando pero no tiene fence (obsoleto).

## Docker Compose con dos réplicas

```yaml
services:
  redis:
    image: redis:7-alpine
  bot:
    build: .
    environment:
      REDIS_URL: redis://redis:6379
    volumes:
      - ./sessions:/app/sessions   # Baileys: la líder necesita los archivos de sesión
    deploy:
      replicas: 2
    depends_on: [redis]
```

Con Baileys, todas las réplicas deben llegar a los mismos archivos de sesión
(un volumen compartido): solo la líder los abre, pero cualquiera puede pasar
a ser la líder.

## Tests

`MemoryCoordinator` es la implementación de referencia en un solo proceso.
Los bots que comparten un `MemoryCoordinationHub` se coordinan igual que
réplicas que comparten Redis, y `coordinator.crash()` simula la caída de una
réplica:

```ts
import { Bot, MemoryCoordinationHub, MemoryCoordinator, MemoryStore } from '@bot-wa/core'

const hub = new MemoryCoordinationHub()
const store = new MemoryStore()
const a = new Bot({ provider: pa, store, coordination: { coordinator: new MemoryCoordinator({ hub, replicaId: 'a' }) } })
const b = new Bot({ provider: pb, store, coordination: { coordinator: new MemoryCoordinator({ hub, replicaId: 'b' }) } })
```
