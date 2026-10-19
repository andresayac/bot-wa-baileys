# Scheduler

Ejecuta tareas programadas: cada cierto intervalo, con cron, o después de
un delay. Cada método devuelve un `ScheduledTask` que puedes cancelar.

## every — repetir cada intervalo

```ts
bot.every('30 seconds', () => console.log('💓 heartbeat'))
bot.every('5 minutes', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '⏰ reminder')
})
bot.every('2 hours', async () => { /* cleanup */ })
bot.every(60000, () => console.log('1 minute'))  // ms
```

### Formatos aceptados

| String | Equivalente |
|---|---|
| `'30 seconds'` | 30000 ms |
| `'5 minutes'` | 300000 ms |
| `'2 hours'` | 7200000 ms |
| `'1 day'` | 86400000 ms |

## schedule — expresión cron

```ts
// Cada día a las 9:00 AM
bot.schedule('0 9 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 Good morning!')
})

// Días laborables a las 9:00 AM
bot.schedule('0 9 * * 1-5', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '💼 Time to work')
})

// Cada 15 minutos
bot.schedule('*/15 * * * *', async () => { /* ... */ })
```

### Formato cron (5 campos)

```
┌───── minuto (0-59)
│ ┌───── hora (0-23)
│ │ ┌───── día del mes (1-31)
│ │ │ ┌───── mes (1-12)
│ │ │ │ ┌───── día de la semana (0-7, 0 y 7 = domingo)
│ │ │ │ │
* * * * *
```

Cada campo acepta `*`, un número, un rango (`1-5`), un paso (`*/15`, `1-30/5`)
o una lista separada por comas de esos. Un paso sobre `*` cuenta desde el
mínimo del campo (`*/3` en el mes es enero, abril, julio y octubre; `*/2` en
el día del mes son los días impares).

Regla de días del cron estándar: si **ambos** campos, día del mes y día de la
semana, están restringidos, un día vale si cumple **cualquiera** de los dos —
`0 9 13 * 5` corre cada día 13 **y** cada viernes. Si uno de ellos empieza por
`*` (también un paso como `*/2`), se tienen que cumplir los dos, así que
`0 9 * * 1` es simplemente "los lunes". Los nombres (`mon`, `jan`) y las macros (`@daily`) no están
soportados: `bot.schedule()` lanza un `TypeError` que nombra el campo inválido
en lugar de crear una tarea que nunca se ejecuta.

### Zonas horarias

Por defecto los campos se leen en la zona horaria del proceso (el `TZ` del
host). Pasa una zona IANA para leerlos en otra, por tarea o para todo el bot:

```ts
// Una tarea: 9:00 entre semana, hora de Bogotá, corra donde corra el servidor.
bot.schedule('0 9 * * 1-5', { timeZone: 'America/Bogota' }, async () => { /* ... */ })

// Las tareas durables la llevan junto a su id.
bot.schedule('30 2 * * *', { id: 'informe-nocturno', timeZone: 'Europe/Madrid' }, async (run) => { /* ... */ })

// Por defecto para todas las tareas cron del bot (gana la timeZone de la tarea; 'local' = zona del proceso).
const bot = new Bot({ provider, scheduler: { timeZone: 'America/Mexico_City' } })
```

Las zonas se validan con `Intl` al crear la tarea (o el bot): un nombre
desconocido lanza un `RangeError`. `every` y `delay` rechazan `timeZone`
(solo aplica a los campos cron). `task.timeZone` indica qué zona usa una tarea.
Una tarea sin zona no cambia en nada.

Los cambios de horario de verano siguen una única política documentada. El
campo de la hora es **comodín** cuando empieza por `*` (`*`, `*/2`), igual que
en los campos de día:

| Situación | Hora fija (`30 2 * * *`) | Hora comodín (`*/15 * * * *`, `0 * * * *`) |
|---|---|---|
| **Hueco**: la hora local no existe (se adelanta el reloj) | Corre una vez, desplazada hacia delante lo que dura el hueco (las 02:30 pasan a las 03:30), como RFC 5545 y el `'compatible'` de Temporal. Si la hora desplazada coincide con otro hueco de la tarea, corre una sola vez. | Los huecos dentro del salto se omiten; el calendario sigue en la primera hora de pared que existe. |
| **Solape**: la hora local ocurre dos veces (se atrasa el reloj) | Corre una vez, en la primera ocurrencia. | Corre en las dos pasadas (son instantes distintos, con `occurrenceKey` distintas). |
| Cambio a medianoche (p. ej. `America/Santiago`) | `0 0 * * *` corre a la 01:00 de ese día; el día del mes y el de la semana siguen siendo los del calendario. | Igual que arriba. |

Las horas de ejecución siempre son estrictamente crecientes y todas las réplicas
calculan las mismas, así que las tareas durables coinciden en sus huecos, en las
ejecuciones perdidas y en el catch-up a través de un cambio de hora. Con zona,
la búsqueda mira hasta cuatro años hacia delante (así `0 0 29 2 *` funciona);
sin zona, un año.

## delay — una vez después de X tiempo

```ts
bot.delay('10 seconds', () => console.log('⏰ 10s elapsed'))
bot.delay('5 minutes', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', 'All good?')
})
```

## Cancelar una tarea

`bot.schedule`, `bot.every` y `bot.delay` devuelven todos un
`ScheduledTask` con un método `.cancel()`:

```ts
const heartbeat = bot.every('30 seconds', () => console.log('💓'))

// más adelante
heartbeat.cancel()
```

## Tareas durables (sobreviven a reinicios, una réplica por ejecución)

Las tareas anteriores viven en memoria: un reinicio olvida cuándo tocaban y, con
varias réplicas, cada una ejecuta su propia copia. Dale a una tarea un `id`
estable y pasa a ser **durable**:

- su próxima ejecución se guarda, así que un reinicio conserva el calendario en
  lugar de volver a planificar desde "ahora";
- las ejecuciones perdidas mientras el bot estaba caído siguen una política
  (`missed`);
- cada ejecución se reclama con un lease con fencing en el store compartido, así
  que N réplicas nunca la ejecutan a la vez (sigue siendo al menos una vez: ver
  [Garantías y límites](#garantias-y-limites)).

Es opt-in: las tareas sin `id` y los bots sin `scheduler` se comportan igual que
antes.

```ts
import { Bot } from '@bot-wa/core'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const store = new SQLiteStore({ file: './data/bot.db' })
const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })

// Los mismos métodos, con las opciones antes del handler.
bot.schedule('0 9 * * 1-5', { id: 'resumen-matinal', missed: 'run-once' }, async (run) => {
  await enviarResumen({ idempotencyKey: run.occurrenceKey })
})
bot.every('15m', { id: 'sync-crm', missed: 'catch-up', maxCatchUp: 4 }, async (run) => { /* ... */ })
```

Registra las tareas durables **al arrancar, en todas las réplicas**: solo se
guarda el calendario, nunca el handler, así que tras un reinicio una tarea solo
corre si el código vuelve a registrar su id (ver
[Registrar tareas](#registrar-tareas)).

El handler recibe un `ScheduledRun`:

| Campo | Significado |
|---|---|
| `taskId` | El `id` de la tarea. |
| `scheduledAt` | El hueco que cubre esta ejecución (no la hora real a la que empezó). |
| `occurrenceKey` | `` `${taskId}@${scheduledAt.toISOString()}` ``: estable por ejecución, úsalo como clave de idempotencia. |
| `fencingToken` | Token del reclamo: estrictamente creciente por id de tarea, también tras `cancel()` y un nuevo registro. Pásalo a los sistemas que escribes para rechazar escrituras obsoletas. Las ejecuciones de un mismo catch-up comparten su reclamo y, por tanto, su token. |
| `missed` | `true` cuando la ejecución viene de la política de ejecuciones perdidas. |
| `signal` | Se aborta cuando el bot se detiene o se pierde el lease de esta ejecución. |

### Opciones

| Opción | Por defecto | Significado |
|---|---|---|
| `id` | (obligatorio) | Estable y único por bot. Se le aplica el namespace del store del bot, así que bots que comparten backend no chocan. Registrar dos veces el mismo id lanza `TypeError`. |
| `missed` | `'skip'` | Qué hacer con las ejecuciones perdidas mientras no corría ningún scheduler (ver abajo). |
| `maxCatchUp` | `10` | Máximo de huecos perdidos que ejecuta `'catch-up'`. |
| `leaseMs` | `'60s'` | Cuánto dura el lease de una ejecución reclamada; se renueva cada tercio mientras corre el handler. |
| `timeZone` | `scheduler.timeZone`, si no la zona del proceso | Solo tareas cron: zona IANA de los campos (ver [Zonas horarias](#zonas-horarias)). Forma parte de la especificación guardada (`TZ=<zona> <cron>`), así que añadirla o cambiarla vuelve a planificar la tarea. |

### Ejecuciones perdidas

Un hueco está **perdido** cuando se reclama más de un periodo de gracia después
de vencer, lo que pasa cuando ninguna réplica lo estaba ejecutando (el bot
estaba caído o todas las réplicas paradas). El periodo de gracia es `tickMs`
(1 s por defecto), más dos veces `leaderTtlMs` si hay un `lease` de líder (un
seguidor o un failover pueden tardar eso en entrar, y eso no es una ejecución
perdida). Cada réplica lo decide solo con el estado guardado, así que todas
coinciden. Los huecos perdidos siguen la política de la tarea:

- `'skip'`: no ejecuta ninguna y espera al siguiente hueco después de ahora.
- `'run-once'`: ejecuta una (`missed: true`, `scheduledAt` es el primer hueco
  perdido) y espera al siguiente hueco.
- `'catch-up'`: ejecuta en orden cada hueco perdido, cada uno con su propio
  `scheduledAt` y `occurrenceKey`, hasta `maxCatchUp`; el resto se salta y se
  registra en el log. Todo el catch-up corre bajo un único reclamo en una sola
  réplica y se confirma al final: si ese proceso muere a medias, el catch-up
  vuelve a empezar desde su primer hueco (deduplica con `run.occurrenceKey`); si
  se detiene, sigue desde el primer hueco que no ejecutó.

Una ejecución interrumpida por una caída (su ejecutor murió con el lease) no
está perdida: cuando vence el lease se ejecuta otra vez como tal
(`missed: false`), y la política se aplica a los huecos posteriores.

Un `delay` de una sola vez cuenta como un hueco: `'skip'` descarta un
recordatorio que venció con el bot caído, así que usa `'run-once'` para
recordatorios. Su hora se fija cuando el id se guarda por primera vez; un
reinicio no la retrasa. Tras ejecutarse, la fila queda como tombstone (volver a
registrar el id no la ejecuta otra vez) hasta que `cancel()` o
`bot.forgetTask(id)` la borra.

Los intervalos no derivan: el siguiente hueco es el anterior más el intervalo,
no "ahora" más el intervalo. El cron usa la zona del proceso salvo que la tarea
o `scheduler.timeZone` fijen una (ver [Zonas horarias](#zonas-horarias)).

### Registrar tareas

- Registra las tareas recurrentes al arrancar, en todas las réplicas, con el
  mismo id y la misma especificación. También se puede registrar una tarea con
  el bot en marcha (la primera tarea durable arranca el motor durable), pero
  solo es durable mientras algún código la vuelva a registrar tras cada
  reinicio.
- Los recordatorios por entidad (un id por pedido, por usuario...) funcionan si
  puedes reconstruirlos al arrancar con tus propios datos: volver a registrar el
  mismo id conserva su hora original.

```ts
// Al arrancar: vuelve a registrar los seguimientos pendientes de tu base de datos.
for (const pedido of await pedidos.seguimientosPendientes()) programarSeguimiento(pedido.id)

// Y cuando se crea un pedido (desde un handler):
function programarSeguimiento(pedidoId: string) {
  bot.delay('2h', { id: `seguimiento:${pedidoId}`, missed: 'run-once' }, async (run) => {
    await enviarSeguimiento(pedidoId, { idempotencyKey: run.occurrenceKey })
    await bot.forgetTask(run.taskId) // hecho: borra el tombstone
  })
}
```

Un id por entidad que ningún código registra tras un reinicio es un huérfano:
se conserva y nunca se ejecuta.

### Backends

`BotConfig.scheduler` acepta:

| Opción | Por defecto | Significado |
|---|---|---|
| `store` | en memoria | Dónde se guardan los calendarios: el `schedules()` de tu store (ver la tabla de abajo). Sin él las tareas durables funcionan pero no sobreviven a un reinicio, y se avisa una vez en el log. |
| `lease` | ninguno | Liderazgo opcional, que ahorra viajes al store con muchas réplicas: la réplica que tiene `scheduler:leader` reclama a tiempo y las demás solo reclaman una ejecución que lleva `leaderTtlMs` vencida (una tarea que solo ellas registran, p. ej. durante un despliegue gradual, o un líder caído), así que esa tarea corre hasta `leaderTtlMs` tarde. Un `LeaseProvider` con fencing (`RedisStore#leases()`, `MemoryLeaseProvider`) o un `Coordinator` multi-réplica (`store.coordinator()`); con `BotConfig.coordination` usa ese coordinador por defecto. La corrección nunca depende de él. |
| `owner` | aleatorio | Id de dueño de lease de este proceso. |
| `tickMs` | `'1s'` | Periodo de sondeo: recoge una ejecución cuyo ejecutor cayó (cuando vence su lease) y reintenta tras errores del store. |
| `leaderTtlMs` | `'30s'` | TTL del lease de líder. Con un `Coordinator` (que renueva su liderazgo él mismo) es solo la gracia del seguidor; por defecto, el `leaseMs` del coordinador. |
| `timeZone` | zona del proceso | Zona IANA por defecto de todas las tareas cron del bot, normales o durables (ver [Zonas horarias](#zonas-horarias)). Por sí sola no arranca nada. |

Cada paquete de store trae su store de calendarios, que comparte la conexión y
el prefijo del store:

| Store | `store.schedules()` | Almacenamiento |
|---|---|---|
| `@bot-wa/sqlite-store` | `SQLiteScheduleStore` | Tabla `schedules` (más `schedule_fences`); cada llamada es una transacción `BEGIN IMMEDIATE`. |
| `@bot-wa/redis-store` | `RedisScheduleStore` | `{prefix}:sched:{id}`, scripts de compare-and-set. |
| `@bot-wa/postgres-store` | `PostgresScheduleStore` | Tabla `{tablePrefix}schedules`; cada llamada es una sentencia atómica (los reclamos son `UPDATE … RETURNING`). |
| `@bot-wa/mysql-store` | `MysqlScheduleStore` | Tabla `{tablePrefix}schedules` (ids VARBINARY, hasta 1024 bytes); los reclamos hacen `SELECT … FOR UPDATE` en una transacción corta. |
| `@bot-wa/mongo-store` | `MongoScheduleStore` | Colección `{collectionPrefix}schedules`; comandos de un solo documento (`findOneAndUpdate`), así que sirve un `mongod` standalone. |

```ts
import { PostgresStore } from '@bot-wa/postgres-store'

const store = new PostgresStore({ connectionString: process.env.DATABASE_URL })
const bot = new Bot({ provider, store, scheduler: { store: store.schedules() } })
```

El bot arranca su store antes que el scheduler, y el scheduler crea la tabla
(`CREATE TABLE IF NOT EXISTS`, idempotente). Si usas un store solo para los
calendarios, haz antes `await store.start()`. Los stores SQL y Mongo borran de
forma lógica: un id olvidado conserva su fila con `deleted` activo para que su
token de fencing nunca retroceda. Purga a mano los tombstones antiguos solo
cuando ningún ejecutor pueda seguir teniendo su token (por ejemplo
`DELETE FROM schedules WHERE deleted AND updated_at < <hace un día>`).

Sirve cualquier objeto que implemente `ScheduleStore` (exportado desde
`@bot-wa/core`, con `MemoryScheduleStore` como referencia y la suite compartida
`test-utils/schedule-store-conformance.ts` para comprobarlo).

### Garantías y límites

- **Al menos una vez por ejecución**, nunca dos ejecuciones de una tarea a la
  vez (mientras los leases se respeten). Si un ejecutor cae, o se queda parado
  más que `leaseMs`, su lease vence y otra réplica (o el proceso reiniciado)
  vuelve a ejecutar el mismo hueco. El `signal` del ejecutor obsoleto se aborta
  y su commit se rechaza (queda en el log). Haz los handlers idempotentes con
  `run.occurrenceKey`.
- **Solo se guarda el calendario**, no el handler. Un id guardado que ninguna
  tarea registrada reclama es un **huérfano**: se registra una vez al arrancar,
  se conserva y nunca se ejecuta. Bórralo con `bot.forgetTask(id)` (un
  `Scheduler` independiente tiene `forget(id)`), que aplica el namespace del bot
  por ti. Ese namespace incluye el `botId`, el provider y el id de conexión:
  cambiar cualquiera de ellos deja las filas antiguas como huérfanas.
- Los ids borrados conservan una marca pequeña con su último token de fencing
  (así los tokens nunca retroceden), y las tareas de una sola vez conservan su
  tombstone: con muchos ids por entidad, olvídalos al terminar.
- Cambiar la especificación de una tarea (cron o intervalo) entre despliegues la
  vuelve a planificar desde ahora; la política de perdidas no se aplica a la
  especificación anterior.
- `stop()` pausa: las filas se conservan. `task.cancel()` borra la fila.
- Los plazos de los leases usan el reloj de cada réplica: mantén los relojes
  sincronizados (NTP) y `leaseMs` muy por encima del desfase esperado.
- Las zonas horarias salen de los datos ICU de cada build de Node. Si las
  réplicas tienen tzdata distinta (o un gobierno cambia sus reglas de horario de
  verano), gana el `nextRunAt` guardado: las réplicas siguen la fila y solo el
  siguiente cálculo usa las reglas nuevas. Una zona que el Node de una réplica no
  conoce hace fallar su registro al arrancar, de forma visible.
- `bot.onIdle()` sigue en memoria a propósito: los temporizadores de inactividad
  por chat se reconstruyen con el tráfico entrante.

## Siguientes pasos

- [Sub-APIs](./sub-apis) — grupos, perfil, chats, etc.
- [Despliegue](./deploy) — configuración de producción
