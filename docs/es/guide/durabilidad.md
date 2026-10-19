# Procesamiento durable de mensajes

Por defecto, un `Bot` guarda en memoria todo lo que tiene en curso. Si el proceso
muere mientras atiende un mensaje, ese mensaje se pierde (salvo que el canal lo
vuelva a entregar), y una respuesta que se estaba enviando puede haber salido o no.
Para muchos bots eso basta. Cuando no basta, activa la **durabilidad**:

```ts
import { Bot } from '@bot-wa/core'
import { PostgresDurability, PostgresStore } from '@bot-wa/postgres-store'

const bot = new Bot({
  provider,
  store: new PostgresStore({ pool }),
  durability: {
    journal: new PostgresDurability({ pool }),
    instanceId: 'bot-1',               // estable entre reinicios de este despliegue
    outbox: { retries: 5, backoff: { baseMs: 1000, capMs: 60_000 } },
  },
})
```

Con `durability`, el bot lleva dos journals:

- El **inbox**. Cada mensaje o interacción admitido se anota antes de que corra
  ningún handler, y se marca como hecho solo cuando sus efectos se asentaron. Tras
  una caída, el siguiente arranque reprocesa lo que quedó a medias.
- El **outbox**. Cada envío se anota con una **clave de idempotencia** antes de
  llamar al provider, y justo después se guarda el id de mensaje que devolvió el
  provider. Un envío cuya clave ya está guardada se responde desde el outbox en vez
  de salir otra vez. Así un reproceso no manda dos veces la misma respuesta. Los
  envíos que fallan se reintentan con backoff y van a la cola de muertos (DLQ)
  cuando se les acaban los reintentos.

Sin la clave `durability` no cambia nada: el bot ejecuta exactamente el mismo
código que antes, en memoria y en un solo proceso.

## Backends

| Backend | Paquete | Sobrevive a una caída | Varias réplicas |
| --- | --- | --- | --- |
| `MemoryDurability` (el de `durability: {}`) | `@bot-wa/core` | No (solo reintentos, backoff y DLQ) | No |
| `FileDurability.open(ruta)` | `@bot-wa/core` | Sí | No (un archivo de lock rechaza un segundo proceso vivo) |
| `PostgresDurability({ pool \| connectionString, tablePrefix })` | `@bot-wa/postgres-store` | Sí | Sí |
| `RedisDurability({ client \| url, prefix })` | `@bot-wa/redis-store` | Sí (con la persistencia de Redis activada) | Sí |

PostgreSQL crea una tabla, `{tablePrefix}durable`, de forma idempotente al
arrancar. Redis usa claves bajo `{prefix}:{durable:inbox}` y
`{prefix}:{durable:outbox}`. Ninguno toca las tablas ni las claves del store.
Todos los backends pasan la misma suite de conformidad
(`test-utils/durability-conformance.ts`), y puedes escribir el tuyo implementando la
pequeña interfaz `DurableKv` (compare-and-set con versión más dos índices
ordenados) y envolviéndola en `KvDurability`.

El bot arranca y detiene el backend por su cuenta. Usa también un **store**
persistente: los checkpoints de un flow `.persistent()` viven en el store y el
reproceso depende de ellos.

## Qué se garantiza

Los envíos son **exactamente una vez mientras el proceso vive**. Tras una caída
también lo son, salvo en una ventana que ningún canal permite cerrar: el proceso
muere después de que el provider aceptó un mensaje y antes de que el outbox lo
anotara.

| El proceso muere… | Al reiniciar |
| --- | --- |
| antes de anotar el mensaje entrante | No quedó nada anotado. El mensaje se procesa si el canal lo vuelve a entregar (los webhooks lo hacen; Baileys puede que no). |
| después de anotarlo, antes o durante el handler | El mensaje se reprocesa. Las respuestas que ya salieron se responden desde el outbox; las que faltan se envían. |
| entre "voy a llamar al provider" y anotar "enviado" | **Ambiguo.** `onAmbiguous: 'skip'` (por defecto) marca el envío como `unknown`: nunca se duplica, puede perderse. `'resend'` lo envía otra vez: nunca se pierde, puede duplicarse. En ambos casos se emite `'durability:ambiguous'`. |
| después de anotar el envío, antes de confirmar el mensaje entrante | El mensaje se reprocesa; todas las respuestas se responden desde el outbox. |
| mientras un flow persistente espera una respuesta | El flow sigue desde su checkpoint. La pregunta pendiente no se repite y el siguiente mensaje se toma como su respuesta. |

Los handlers son **al menos una vez**: un mensaje reprocesado vuelve a ejecutar su
handler y solo se deduplican sus envíos. Haz idempotentes los demás efectos (un
upsert, un `ctx.user.set`, una escritura en base de datos con clave `ctx.ref.id`) o
dales su propia clave.

## Claves de idempotencia

Cada envío lleva una clave:

1. `options.idempotencyKey` cuando la pasas: `bot.send(chatId, texto, { idempotencyKey: 'factura:42' })`.
2. Si no, mientras se atiende un mensaje entrante: `<id del registro entrante>:<n>`,
   el n-ésimo envío hecho para ese mensaje. Un paso de conversación usa el mensaje
   que lo alimentó, así que las respuestas de un flow conservan sus claves cuando el
   flow se reanuda.
3. Si no, una clave aleatoria. El envío igual se reintenta y sobrevive a una caída,
   pero una segunda llamada no se reconoce como el mismo envío.

Por la regla 2, **un handler durable debe enviar en un orden determinista**. Si un
reproceso hace otro número de envíos, o los hace en otro orden, las claves dejan de
cuadrar: salen envíos de más y los que desaparecieron no se reconocen. Para envíos
cuyo orden depende del tiempo (`bot.broadcast` con `concurrency > 1`, un
`Promise.all` de respuestas) pasa claves explícitas.

El provider nunca ve `idempotencyKey`: el core la quita antes de llamar al provider.

## Reintentos, envíos diferidos y la cola de muertos

Un envío que falla se reintenta con backoff (un `RateLimitedError` espera al menos
su `retryAfterMs`), salvo que el error sea definitivo. Estos errores son definitivos
y van directo a la DLQ: `UnsupportedContentError`, `PayloadTooLargeError`,
`OutsideSessionWindowError`, `RecipientUnreachableError` o cualquier error con
`retryable: false`.

`ctx.reply` y `bot.send` siguen reintentando en línea hasta `outbox.inlineMaxMs`
(por defecto `15s`). Pasado ese tiempo rechazan con `SendDeferredError`, que lleva
la `key` del outbox. El envío **no se pierde**: el barrido en segundo plano lo sigue
reintentando. Si quien llama no necesita esperar, encola el envío:

```ts
const { key } = await bot.enqueue(chatId, 'Tu cita es mañana a las 9', {
  idempotencyKey: `recordatorio:${cita.id}`,   // un segundo enqueue de esta clave no hace nada
})
```

`bot.enqueue` ejecuta los hooks `before('send')` una vez, anota el envío y vuelve
enseguida. El barrido lo entrega y después ejecuta `after('send')` y escribe el
registro de mensajes. Dentro de un proceso, los envíos a un chat conservan su orden
mientras uno de ellos se reintenta en línea.

Los mensajes entrantes cuyo procesamiento falla *antes* de los handlers (por
ejemplo, el store está caído) se reintentan con `inbox.backoff` y van a la DLQ tras
`inbox.maxAttempts`. Un handler que lanza un error **no** se reintenta: sus efectos
ya ocurrieron. El error llega a `bot.on('error')` y el mensaje se confirma.

## Operación

```ts
bot.on('durability:dead', ({ kind, id, error }) => alertar(kind, id, error))
bot.on('durability:ambiguous', ({ key, chatId }) => auditar(key, chatId))

const d = bot.durability!
await d.inbox.list({ state: 'dead' })          // la DLQ de entrada
await d.outbox.list({ state: 'dead' })         // la DLQ de salida
await d.replayInbound(id)                      // procesarlo otra vez
await d.retrySend(key)                         // enviarlo otra vez (dead, failed o unknown)
await d.outbox.discard(key)                    // olvidarlo
d.metrics()  // { inboundJournaled, inboundDuplicates, inboundReplayed, inboundDead,
             //   outboxJournaled, outboxDeduped, outboxRetried, outboxDeferred,
             //   outboxDead, outboxAmbiguous, outboxBypassed, staleLeases }
```

- **Leases y fencing.** Un registro en proceso se presta a `instanceId` durante
  `inbox.leaseMs` (60 s por defecto), y un latido extiende el préstamo mientras
  corre. Si el préstamo vence, otra réplica, o esta misma tras reiniciar, toma el
  registro con un nuevo token de fencing. Entonces se rechaza la confirmación del
  dueño anterior y se cuenta en `staleLeases`.
- **`instanceId`.** Mantenlo estable entre reinicios de un despliegue, para que un
  proceso reiniciado recupere enseguida sus registros sin terminar en vez de esperar
  a que venzan sus préstamos. Hazlo único por réplica que corra a la vez. Por
  defecto es `<hostname>/<botId>/<connectionId>`.
- **Retención.** Los registros `done` y `sent` se purgan tras `retention` (por
  defecto `7d`). Mantenla más larga que la ventana de reentrega más larga de tus
  canales, porque una reentrega solo se reconoce mientras su registro existe.
- **Cierre ante fallos.** Si el journal no puede anotar un mensaje entrante, el
  mensaje no se despacha. Se emite un `'error'` y el dedupe en memoria olvida el
  mensaje, así que una reentrega se procesa. Con `failOpen: true` se despacha sin
  journal.
- **Tamaño del contenido.** El contenido saliente se anota como JSON, con los
  Buffers en base64. Un contenido de más de `outbox.maxPayloadBytes` (1 MiB por
  defecto), o uno que no se puede codificar (un stream), se salta el outbox con un
  aviso. Para archivos grandes, usa media por URL o por ruta.
- **Media en un reproceso.** El journal nunca guarda `raw`, así que un mensaje
  reprocesado no siempre puede volver a descargar su media (Baileys necesita el
  mensaje original). Los handlers que dependen de la media deben tolerar que
  `ctx.media` no esté disponible en un reproceso.
- **Ediciones, borradores e indicadores de escritura** no se anotan. Las ediciones
  son idempotentes, y los borradores y los indicadores son pasajeros.

## Probar la recuperación ante caídas

`@bot-wa/core/testing` exporta `crashable(backend)`, que puede "matar" un bot en una
escritura concreta del journal, y `CrashableProvider`. Abandona el bot caído y
arranca uno nuevo sobre el mismo backend y el mismo store, con el mismo
`instanceId`:

```ts
import { crashable, CrashableProvider, MockProvider } from '@bot-wa/core/testing'

const shared = new MemoryDurability()
const a = crashable(shared)
a.crashBefore('outbox.markSent')    // se llamó al provider, el resultado nunca se anota
const botA = new Bot({ provider: new CrashableProvider(a), store, durability: { journal: a, instanceId: 'i1' } })
// … mueve botA hasta que a.crashed …
const botB = new Bot({ provider: new MockProvider(), store, durability: { journal: shared, instanceId: 'i1' } })
```

El repositorio corre una matriz de caídas (`test-utils/durability-crash.ts`) contra
cada backend. Cubre cada punto de caída con las dos políticas de ambigüedad, más
puntos aleatorios con semilla y un proceso hijo real al que se mata a mitad de un
handler.
