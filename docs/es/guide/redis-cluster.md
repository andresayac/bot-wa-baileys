# Redis Cluster

`@bot-wa/redis-store` funciona sobre **Redis Cluster** con un **layout de
claves** opcional. Un bot que no lo activa conserva exactamente los mismos
nombres de clave, scripts y comandos que antes.

## Por qué un layout aparte

Un Redis Cluster reparte el espacio de claves en 16384 hash slots entre varios
masters. Dos reglas rompen el layout histórico (`'legacy'`):

- un script, un `MULTI` o un comando con varias claves solo puede tocar claves
  de **un slot**; si no, el servidor responde `CROSSSLOT`;
- `KEYS` y `SCAN` solo ven **un nodo**, así que un listado basado en ellos
  queda incompleto sin avisar.

El layout `'cluster'` resuelve las dos. Cada grupo de claves que toca un script
comparte un **hash tag** (`{…}`), y los listados leen **índices (sorted sets)**
que viven en el mismo slot que sus registros, así que son exactos incluso
mientras se mueven slots.

## Configuración

Pasa un cliente cluster de node-redis, o deja que el componente cree uno:

```ts
import { createCluster } from 'redis'
import { Bot } from '@bot-wa/core'
import { RedisStore, RedisDurability } from '@bot-wa/redis-store'

const cluster = createCluster({ rootNodes: [{ url: 'redis://redis-0:6379' }], useReplicas: false })
cluster.on('error', (err) => logger.error({ err }, 'redis cluster'))
await cluster.connect()

const store = new RedisStore({ client: cluster, prefix: 'mybot' })   // elige el layout 'cluster' solo
const bot = new Bot({
  provider,
  store,
  coordination: { coordinator: store.coordinator() },              // mismo cliente y layout
  scheduler: { store: store.schedules(), lease: store.leases() },
  durability: { journal: new RedisDurability({ client: cluster, prefix: 'mybot' }), instanceId: process.env.HOSTNAME },
})
```

O con un cliente propio, que el store crea y cierra:

```ts
const store = new RedisStore({
  cluster: {
    rootNodes: ['redis://redis-0:6379', 'redis://redis-1:6379'],
    // Si el cluster anuncia direcciones que tu proceso no alcanza (Docker, NAT):
    nodeAddressMap: (address) => ({ host: 'localhost', port: Number(address.split(':').pop()) }),
    defaults: { password: process.env.REDIS_PASSWORD },
  },
  prefix: 'mybot',
})
```

`RedisCoordinator` y `RedisDurability` aceptan la misma opción `cluster`, que
no se puede combinar con `url` ni con `client`.

| Opción | Dónde | Por defecto |
| --- | --- | --- |
| `layout: 'legacy' \| 'cluster'` | `RedisStore`, `RedisCoordinator`, `RedisScheduleStore`, `RedisLeaseProvider` | `'cluster'` con un cliente cluster u opciones `cluster`; si no, `'legacy'` |
| `cluster: { rootNodes, nodeAddressMap?, defaults?, maxCommandRedirections? }` | `RedisStore`, `RedisCoordinator`, `RedisDurability` | ninguna |
| `allowLegacyData: true` | `RedisStore` | `false` |

Reglas:

- `layout: 'legacy'` con un cliente cluster lanza `RangeError`.
- En el layout cluster el prefijo no puede llevar `{` ni `}` (rompería los hash
  tags).
- `layout: 'cluster'` también funciona en **un solo nodo**: así se migra un
  keyspace existente en el sitio, y así puedes probar el layout en local.
- `store.coordinator()`, `store.schedules()` y `store.leases()` heredan el
  layout del store. Usa el mismo layout y prefijo en todas las réplicas.

## Layout de claves

`p` es el prefijo. Los segmentos variables van con percent-encoding (no queda
ningún `:`, `{`, `}` ni carácter de glob), así que un id de chat nunca rompe un
hash tag.

| Datos | Claves | Un slot por |
| --- | --- | --- |
| Mensajes | `p:{m:<chat>}:z` (log) y `p:{m:<chat>}:i:<member>` | chat |
| Chats, contactos, checkpoints, schedules | `p:{ch:<b>}:r:<id>` y el índice `p:{ch:<b>}:idx` (`ct`, `cp`, `sc`) | bucket `b` (32 por tipo) |
| Datos de usuario (`ctx.user`) | `p:{ud:<user>}:e:<ns>:<key>` y `p:{ud:<user>}:idx` | usuario |
| Locks | `p:{lk:<key>}:l` y el fence `p:{lk:<key>}:f` | lock |
| Turnos del coordinador | `p:co:{t:<clave del chat>}:seq\|tix\|serving\|owner\|last` | chat |
| Liderazgos | `p:co:{ld:<nombre>}` y `…:term` | nombre |
| Sin cambios | `p:conv:*`, `p:cursor:*`, `p:lease:*`, `p:co:rep:*`, `p:{durable:<tabla>}:*` | (una clave, o ya con tag) |
| Marcador de layout | `p:{meta}:layout` = `cluster:v1` | |

El bucket de un registro es FNV-1a de su id módulo 32 (parte del contrato
`cluster:v1`). Los tags de bucket no llevan prefijo, así que los bots que
comparten un cluster reparten cada tipo en los mismos 32 slots. Son unos 10 por
master en un cluster de 3 masters, y un listado cuesta 32 comandos.

### Qué cambia por dentro

- Cada script declara todas sus claves (el store comprueba que comparten slot
  antes de la llamada). El layout cluster usa scripts en lugar de `MULTI`.
- `deleteChat` borra los mensajes en tandas de 1000, cada tanda atómica: un item
  solo se va junto con su entrada del log. El registro del chat va al final. Un
  mensaje guardado durante el borrado sobrevive intacto. Ya no es un único
  script, porque el log y el registro viven en slots distintos.
- Los índices de checkpoints y de datos de usuario llevan como score la
  caducidad del servidor y se podan al leer, así que las entradas caducadas
  desaparecen de los listados igual que las claves caducadas.
- Un coordinador que espera turno no puede leer desde su script el heartbeat de
  otra réplica (otro slot). El script del turno informa del titular anterior, y
  el coordinador consulta su heartbeat con una llamada aparte de una sola clave
  antes de saltar su ticket. La exclusión mutua sigue basándose en la
  comprobación atómica de la clave `owner` en el slot del chat.
- Las respuestas `TRYAGAIN` y `CLUSTERDOWN`, y una redirección `MOVED`/`ASK` que
  node-redis no siguió, se reintentan con backoff (10 intentos, unos 2,5 s; se
  ajusta con `withClusterRetry(client, { attempts, baseMs })` pasando el cliente
  envuelto). Esas respuestas llegan antes de que se ejecute nada. Una respuesta
  perdida nunca se reintenta.

### Notas sobre node-redis 4

El paquete esquiva dos rarezas del cliente cluster de node-redis 4.x:

- `cluster.eval(script, { keys })` se enruta por el argumento equivocado, así que
  puede caer en un master al azar y no seguir nunca el `MOVED`. Los componentes
  envían el `EVAL` enrutado por su primera clave.
- Tras un cambio de topología, un `MULTI` puede fallar con `EXECABORT` sin que
  node-redis vuelva a leer la topología. El layout cluster no usa `MULTI`.

## Migrar un keyspace existente

No hay lectura dual de los dos layouts: rompería la atomicidad de las
escrituras compare-and-set, de los fences y de los índices. La migración se
hace en frío.

1. **Para todos los bots del prefijo.** El helper se niega mientras exista un
   heartbeat de coordinador o un ticket pendiente, salvo con `allowLive: true`.
2. Copia el keyspace:

   ```ts
   import { createClient } from 'redis'
   import { migrateToClusterLayout, inspectKeyspace } from '@bot-wa/redis-store'

   const source = createClient({ url: 'redis://viejo:6379' })
   await source.connect()
   console.log(await inspectKeyspace({ client: source, prefix: 'mybot' }))   // conteos por layout
   const report = await migrateToClusterLayout({ source, prefix: 'mybot', dryRun: true })
   await migrateToClusterLayout({ source, prefix: 'mybot' })                 // en el sitio, o bien:
   await migrateToClusterLayout({ source, target: cluster, prefix: 'mybot' }) // directo a un cluster
   ```

3. Arranca los bots con el layout cluster (`layout: 'cluster'` en el nodo único,
   o un cliente cluster). Tras una migración en el sitio puedes mover los datos
   al cluster con tus herramientas habituales.
4. Cuando lo hayas verificado, borra las claves de origen con
   `migrateToClusterLayout({ source, prefix, deleteSource: true })`.

Qué hace el helper:

- **Mensajes**: se leen desde el log de cada chat (nunca interpretando claves de
  item). Los items que no pertenecen a su chat se saltan, y los que ningún log
  referencia se listan en `report.orphans`.
- **Checkpoints y datos de usuario** conservan el TTL que les quedaba.
- **Fences de locks y terms de liderazgo** se suben con "fijar si es mayor", así
  que nunca retroceden. Los contadores de turno son efímeros y no se copian.
- **Schedules**, incluidos los marcadores de borrado, conservan su token de
  fencing.
- Conversaciones, cursores, leases y el journal de durabilidad conservan su
  nombre. Solo se copian si el destino es otro servidor u otro prefijo.
- **Idempotente y reanudable**: una clave de destino que ya existe gana, salvo
  con `overwrite: true`. El marcador de layout se escribe al final.
- **Vuelta atrás**: `direction: 'cluster-to-legacy'` (destino de un solo nodo).
  Lo escrito después de la migración solo existe en el layout cluster; la pasada
  inversa lo copia de vuelta.

Arrancar un store con layout cluster sobre un nodo único que todavía guarda
claves legacy bajo su prefijo lanza un error ("run migrateToClusterLayout()
first"). Esta comprobación revisa como mucho 10.000 claves. Pasa
`allowLegacyData: true` para arrancar igualmente.

## Límites

- **Replicación asíncrona.** Igual que con Sentinel, un failover puede perder
  las últimas escrituras confirmadas: un lease concedido dos veces, una
  actualización compare-and-set perdida, un fence o un term repetidos. No es
  Redlock. Configura `min-replicas-to-write 1` y apóyate en la idempotencia del
  outbox durable para los envíos.
- Cada tabla de durabilidad vive en un slot (`{durable:<tabla>}`), como antes.
- Movimiento de slots: los listados siguen siendo exactos. Las escrituras de
  varias claves sobre un slot en movimiento reciben `TRYAGAIN` y se reintentan
  hasta que termina el movimiento.
- Se lee solo de los masters (`useReplicas: false`): los bucles compare-and-set
  y los checkpoints tienen que ver sus propias escrituras.

## Probar en local

```bash
docker run -d --name botwa-it-redis-cluster -e IP=0.0.0.0 -e INITIAL_PORT=47100 \
  -e MASTERS=3 -e SLAVES_PER_MASTER=1 -p 127.0.0.1:47100-47105:47100-47105 grokzen/redis-cluster:7.0.10
BOTWA_TEST_REDIS_CLUSTER_URL=redis://127.0.0.1:47100 pnpm --filter @bot-wa/redis-store test
# opcional: failover y migración de slots bajo carga
BOTWA_TEST_REDIS_CLUSTER_CHAOS=1 BOTWA_TEST_REDIS_CLUSTER_URL=redis://127.0.0.1:47100 pnpm --filter @bot-wa/redis-store test
docker rm -f botwa-it-redis-cluster
```

Ver también [Varias réplicas](./replicas.md) y [Procesamiento durable](./durabilidad.md).
