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
| `FileDurability.open(ruta)` | `@bot-wa/core` | Sí | No (un archivo de lock rechaza un segundo proceso vivo, y un segundo `open()` en el mismo proceso hasta `close()`) |
| `PostgresDurability({ pool \| connectionString, tablePrefix })` | `@bot-wa/postgres-store` | Sí | Sí, con enrutado fijo por chat (ver *Varias réplicas*) |
| `RedisDurability({ client \| url, prefix })` | `@bot-wa/redis-store` | Sí (con la persistencia de Redis activada) | Sí, con enrutado fijo por chat (ver *Varias réplicas*) |
| `eventsDurability({ journal })` | `@bot-wa/events/durability` (privado, solo en el monorepo) | Con un `FileEventJournal` abierto con `{ lock: true }` o un `SharedFileEventJournal` | Con un `SharedFileEventJournal` (procesos en un mismo host; ver *Un journal de `@bot-wa/events`*) |

PostgreSQL crea una tabla, `{tablePrefix}durable`, de forma idempotente al
arrancar. Redis usa claves bajo `{prefix}:{durable:inbox:<scope>}` y
`{prefix}:{durable:outbox:<scope>}`. Ninguno toca las tablas ni las claves del store.

**Varios bots pueden compartir un backend.** Cada bot trabaja en su propia vista del
backend, acotada por su namespace (`tenantId`, `environmentId`, `botId`,
`connectionId`; `bot.durability.scope` es el id derivado). Un bot solo toma, reprocesa
y deduplica sus propios registros, y las claves de idempotencia explícitas son por
bot: dos bots que encolan `recordatorio:1` envían cada uno el suyo. Un backend propio
sin `scope()` no debe compartirse entre bots.
Todos los backends pasan la misma suite de conformidad
(`test-utils/durability-conformance.ts`), y puedes escribir el tuyo implementando la
pequeña interfaz `DurableKv` (compare-and-set con versión más dos índices
ordenados) y envolviéndola en `KvDurability`.

El bot arranca y detiene el backend por su cuenta. Usa también un **store**
persistente: los checkpoints de un flow `.persistent()` viven en el store y el
reproceso depende de ellos.

### Un journal de `@bot-wa/events`

Una app que ya lleva un journal de `@bot-wa/events` puede usarlo como backend, sin
otro store:

```ts
import { FileEventJournal } from '@bot-wa/events'
import { eventsDurability } from '@bot-wa/events/durability'

const journal = await FileEventJournal.open('./data/events.json', { lock: true })
const bot = new Bot({ provider, durability: { journal: eventsDurability({ journal }) } })
// después de bot.stop(): await journal.close()
```

- Los registros de la inbox son `EventRecord`s de ese journal, en el canal
  `'botwa:durable'`, con `eventType` `'botwa.inbound.message'` o
  `'botwa.inbound.interaction'`. El `list()` y el `replay()` del journal los ven, y el
  barrido del bot recoge un `replay`. Un `EventWorker` nunca los toma: un `claim` sin
  canal solo toma registros sin canal.
- El outbox es el del core, guardado como *sidecar* del journal: el mismo archivo y el
  mismo snapshot atómico que la inbox.
- Un `FileEventJournal` debe abrirse con `{ lock: true }`. El archivo de lock con el pid
  impide que un segundo proceso lo abra, y un segundo `open()` del mismo archivo en el
  mismo proceso se rechaza hasta que se cierra el primero.
- Coste: un `FileEventJournal` reescribe el archivo **entero** en cada escritura, y aquí
  ese archivo guarda los eventos de la app, los registros de entrada del bot (durante la
  retención, 7 días por defecto) y el outbox. Cada mensaje entrante y cada envío cuestan
  unas pocas reescrituras (las escrituras concurrentes comparten una, y los heartbeats de
  lease solo se escriben con el siguiente cambio). Para algo más que poco tráfico, da al
  bot un archivo de journal propio, acorta la retención o pasa un `outbox` respaldado por
  una base de datos; o usa `FileDurability` o un backend de base de datos.
- Para varias réplicas hace falta un `LeasedEventJournal` compartido, con operaciones
  atómicas y con fencing. `SharedFileEventJournal` es uno: varios procesos abren el mismo
  archivo y cada escritura corre bajo un mutex entre procesos (`<archivo>.mutex`) sobre el
  archivo actual, así que los claims son exclusivos y los fencing tokens valen entre
  procesos. El outbox vive en el mismo archivo y también se comparte:

  ```ts
  import { SharedFileEventJournal } from '@bot-wa/events'

  const journal = await SharedFileEventJournal.open('./data/events.json')
  const bot = new Bot({ provider, durability: { journal: eventsDurability({ journal }) } })
  ```

  Está pensado para pocos procesos en un mismo host (o un sistema de archivos con rename
  atómico y creación exclusiva; no NFS): cada escritura relee y reescribe el archivo
  entero. Un mutex que dejó un proceso muerto se rompe al momento, y uno retenido más de
  `staleLockMs` (30 s por defecto) se da por abandonado; nunca se mata nada. El formato
  del archivo es el de `FileEventJournal`, pero no abras un archivo con los dos a la vez
  (el journal compartido rechaza un archivo que tiene un `FileEventJournal` vivo). La
  regla del mismo chat de *Varias réplicas* sigue valiendo. Para mucho tráfico, usa otro
  `LeasedEventJournal` con un `outbox` compartido (`eventsDurability({ journal, outbox: kv })`,
  con el `DurableKv` de un backend de Postgres o Redis), o esos backends directamente.

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
| mientras un flow **no persistente** espera una respuesta | La conversación se perdió (vivía en memoria). La respuesta reprocesada pasa por el enrutado normal como un mensaje nuevo, y su respuesta se envía (ver `onDiverged` más abajo). Los flows que deban sobrevivir a un reinicio tienen que ser `.persistent()`. |
| en cada ejecución del mismo mensaje (tumba el proceso) | El mensaje se reprocesa hasta que se cobran `inbox.maxAttempts` ejecuciones sin terminar; después va a la DLQ (`'durability:dead'`) en vez de tumbar otra vez el siguiente arranque. |

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

El outbox guarda además una huella de cada envío (chat + contenido, antes de los
hooks `before('send')`). Cuando un reproceso produce **otro contenido** bajo una clave
de la regla 2, el handler tomó otro camino (un flow no persistente perdido en la
caída, una condición que cambió). `outbox.onDiverged` decide: `'send'` (por defecto)
envía el contenido nuevo con una clave nueva, para que ninguna respuesta se trague en
silencio; `'skip'` lo responde desde el envío anotado, como antes. En ambos casos lo
cuenta `metrics().outboxDiverged` y se registra un aviso. Elige `'skip'` cuando las
respuestas no son deterministas (texto generado por IA) y una segunda respuesta
distinta sería peor que ninguna. Las claves explícitas nunca se comparan: la clave que
pasas nombra el envío.

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
             //   outboxDead, outboxAmbiguous, outboxBypassed, staleLeases, outboxDiverged }
```

- **Leases y fencing.** Un registro en proceso se presta a `instanceId` durante
  `inbox.leaseMs` (60 s por defecto), y un envío en curso durante `outbox.leaseMs`
  (60 s por defecto). Un latido extiende ambos mientras corren el handler o la llamada
  al provider, así que una subida lenta nunca se toma por un envío abandonado. Si un
  préstamo vence (el proceso murió o se congeló), otra réplica, o esta misma tras
  reiniciar, toma el registro con un nuevo token de fencing. Entonces se rechaza la
  confirmación del dueño anterior y se cuenta en `staleLeases`.
- **`instanceId`.** Mantenlo estable entre reinicios de un despliegue, para que un
  proceso reiniciado recupere enseguida sus registros sin terminar en vez de esperar
  a que venzan sus préstamos. Hazlo único por réplica que corra a la vez (el nombre
  del pod de un StatefulSet, por ejemplo): dos procesos vivos con el mismo id se
  quitarían los préstamos. En un backend de un solo proceso (memoria, archivo) el valor
  por defecto es `<hostname>/<botId>/<connectionId>`. En un backend compartido
  (Postgres, Redis) se le añade un sufijo por arranque, para que dos procesos del mismo
  host nunca lo compartan; entonces un reinicio espera a que venzan los préstamos
  anteriores. Fíjalo explícitamente para evitar esa espera.
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
- **Media en un reproceso.** Ver *Media en un reproceso* más abajo.
- **Ediciones, borradores e indicadores de escritura** no se anotan. Las ediciones
  son idempotentes, y los borradores y los indicadores son pasajeros.

## Media en un reproceso

El journal no guarda la media de un mensaje, solo una referencia a ella. Los bytes se
descargan bajo demanda con `loadMediaOf(ctx)`. En algunos canales esa referencia es un
objeto vivo: Baileys guarda el mensaje original de WhatsApp. Por eso la inbox le pide al
provider una referencia serializable y versionada (`IProvider.serializeMediaRef`) y
anota esa. Un mensaje puede reprocesarse tras una caída, como reintento en segundo
plano o por un `replayInbound` de un operador. En todos los casos el provider
reconstruye la referencia (`IProvider.rehydrateMediaRef`) antes de que corra el handler,
y la media se descarga igual que con un mensaje en vivo.

| Provider | Qué se anota | Notas |
| --- | --- | --- |
| `@bot-wa/baileys` | El contenido de la media (url del CDN, ruta directa, clave y hashes, sin miniatura, pie de foto ni contexto citado) y la clave del mensaje | Si la media caducó en el CDN, se pide de nuevo al teléfono del remitente al descargarla, como con la media en vivo. La media de visualización única **no** se anota salvo con `durableMedia: { viewOnce: true }`. |
| `@bot-wa/meta` (Cloud API) | El id de la media | Meta guarda la media entrante unos 30 días. |
| `@bot-wa/telegram` | El `file_id` | Solo sirve con el mismo token del bot. |
| `@bot-wa/twilio` | La URL de la media | Al leerla solo se aceptan URLs `https` del origen de la API o de un host `twilio.com`. |
| `@bot-wa/messenger`, `@bot-wa/instagram` | La URL del adjunto | Solo se guardan y se aceptan URLs de las CDN de Meta (`fbcdn.net`, `fbsbx.com`, `cdninstagram.com`; `mediaRefHosts` reemplaza la lista). Las URLs van firmadas y caducan, así que una reproducción tardía no puede descargar. |
| `@bot-wa/discord` | La URL del adjunto | Solo URLs de las CDN de Discord (`discordapp.com`, `discordapp.net`; `mediaRefHosts` reemplaza la lista). Las URLs de adjuntos de Discord caducan a las 24 horas, más o menos. |
| Otros providers | El token tal cual (como antes) | Sus tokens ya son ids o URLs. |

No se anota ninguna credencial: los tokens y las claves se añaden de nuevo al
descargar. La referencia guardada se valida al leerla. Un mensaje reprocesado cuya
media no se puede reconstruir **se procesa igual**; solo falla su descarga.
`loadMediaOf(ctx, { throwOnError: true })` rechaza entonces con
`MediaUnavailableError` (un `ProviderError`), y su `reason` es uno de estos:

- `'not-durable'`: el provider no serializó la referencia (por ejemplo, visualización única).
- `'provider-mismatch'`: otro provider escribió el registro.
- `'rehydrate-failed'`: el valor guardado no es válido, es de una versión desconocida o fue manipulado.

Sin `throwOnError`, `loadMediaOf` resuelve `undefined`, igual que con cualquier descarga
fallida.

```ts
bot.when(IMAGE, async (ctx) => {
  try {
    const media = await loadMediaOf(ctx, { throwOnError: true })
    // …
  } catch (error) {
    if (error instanceof MediaUnavailableError) return ctx.reply('Envíame la imagen de nuevo, por favor.')
    throw error
  }
})
```

La referencia da acceso a la media, igual que el cuerpo del mensaje que se guarda a su
lado, así que protege el journal como proteges el store. Con
`durability.inbox.mediaRefs: false` los tokens de media se anotan como antes; un
mensaje reprocesado puede entonces no poder descargar su media. Los registros escritos
antes de esta función se reprocesan como antes.

Un provider añade los dos métodos opcionales de `IProvider`.
`serializeMediaRef(ref)` es síncrono y devuelve `{ v, data }` (JSON) o `undefined`.
`rehydrateMediaRef(stored, ref)` valida `stored`, lanza un `ProviderError` si no es
válido y no necesita el transporte conectado.

## Varias réplicas

Los journals se pueden compartir sin riesgo: dos réplicas nunca toman el mismo
registro y un dueño caducado no puede completarlo. El resto del bot sigue siendo por
proceso: las conversaciones activas, su `ask` pendiente y la cola por chat viven en la
memoria de la réplica que las ejecuta. Por eso:

- **Envía cada chat a una sola réplica a la vez** (enrutado fijo por id de chat en el
  balanceador, o reparte los chats entre réplicas). Si dos réplicas reciben mensajes
  del mismo chat, la respuesta a un `ask` que una réplica tiene pendiente llega a la
  otra como un mensaje nuevo.
- **La conmutación va por préstamos.** Cuando una réplica muere o se congela, otra toma
  sus registros sin terminar en cuanto vencen sus préstamos (`inbox.leaseMs`) y los
  reprocesa. Una réplica viva conserva sus préstamos gracias al latido, tarde lo que
  tarde su handler.
- Da a cada réplica su propio `instanceId` explícito.

**Con `coordination`** (ver [Varias réplicas](./replicas.md)) no hace falta el enrutado
fijo: los turnos por chat serializan cada chat entre réplicas y los flujos
`.persistent()` siguen en la réplica que reciba el siguiente mensaje. Los bots con el
mismo `botId` comparten un ámbito de journal, así que cualquier réplica puede
reprocesar o entregar un registro. Con una sesión de transporte solo en la líder
(`providerSession: 'leader'`, p. ej. Baileys), el barrido del outbox de una réplica en
espera nunca llama al transporte (el intento se rechaza con `ProviderNotLeaderError` y
se reintenta); lo entrega la líder.

Con coordinación, un registro que alimentó un paso de conversación se confirma solo
cuando aterriza la escritura del checkpoint que guarda su efecto (la marca de espera, o
la respuesta de un paso cortado); si un paso suspendido no pudo escribirla, libera el
registro y este se reprocesa. Una respuesta guardada apunta a su registro de entrada,
así que mantén `retention` por encima de tu pausa de conversación más larga. Ver
[Relevo de conversaciones](./replicas.md#relevo-de-conversaciones).

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
