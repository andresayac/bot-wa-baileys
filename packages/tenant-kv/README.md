# @bot-wa/tenant-kv

> Infraestructura interna · privado (`"private": true`, no se publica en npm).

Documentos JSON aislados por tenant con compare-and-set sobre cualquier `DurableKv` de `@bot-wa/core`: `MemoryKv`, el kv de `FileDurability`, `SQLiteDurableKv` (`@bot-wa/sqlite-store`), `PostgresDurableKv` (`@bot-wa/postgres-store`) y `RedisDurableKv` (`@bot-wa/redis-store`, nodo único o cluster). Es el pegamento de almacenamiento que comparten `@bot-wa/inbox`, `@bot-wa/crm`, `@bot-wa/campaigns`, `@bot-wa/deployments` y `@bot-wa/hub`; no está pensado para usarse directamente desde un bot.

```ts
import { MemoryKv } from '@bot-wa/core'
import { TenantDocs } from '@bot-wa/tenant-kv'

const docs = new TenantDocs<{ n: number; updatedAt: number }>(new MemoryKv(), {
  family: ['demo', 'counter'],            // tablas product/demo/counter/<tenant>
  parse: (value) => value as { n: number; updatedAt: number },
  order: (doc) => -doc.updatedAt,         // list() devuelve los más recientes primero
})

const table = docs.in('acme')
await table.insert('x', { n: 1, updatedAt: Date.now() })
await table.update('x', (cur) => cur && { ...cur, n: cur.n + 1, updatedAt: Date.now() })
await table.list({ limit: 50 })
```

## Decisión de diseño

Los paquetes de producto no dependen de ningún driver (`pg`, `redis`, `better-sqlite3`…) ni los stores conocen a los productos: cada producto persiste a través del contrato público `DurableKv` del core (documento JSON versionado + dos índices ordenados) y este paquete pone lo común en un solo sitio:

- **Nombre de tabla** `product/<familia…>/<tenant>[/<sub>…]`, con cada segmento percent-encoded (`encodeSegment`, mismo alfabeto que `@bot-wa/redis-store`). El tenant forma parte de la clave primaria del backend (`(tbl, id)` en Postgres/SQLite, hash tag `{durable:<tabla>}` en Redis), así que ninguna consulta puede cruzar tenants y un `tenantId` hostil (`a/b`, `}{`, `*`) queda codificado. El prefijo `product/` nunca colisiona con las tablas del journal del core (`inbox`, `outbox`, `inbox:<scope>`…), por lo que el mismo kv puede respaldar `BotConfig.durability`.
- **Compare-and-set**: la versión opaca del backend es la que usa el CAS; `update(id, fn)` reintenta hasta `attempts` veces (32 por defecto, con pausa aleatoria) y después lanza `KvContentionError`. Nunca hay sobrescritura silenciosa.
- **Validación**: todo documento leído pasa por `parse`; si no es JSON válido o no cumple la forma esperada, `CorruptDocumentError(table, id)` (el mensaje nunca incluye el contenido).
- **Listados acotados**: `list({ index: 'all' | 'active', limit, max })` lee como mucho `limit` ids del índice (ascendente por puntuación, empates por id) y vuelve a leer cada documento. `DurableKv.range` solo responde «los N menores ≤ max», así que no hay paginación por cursor: los productos documentan sus límites (`limit`/`scan`).

## Límites

- Una tabla por tenant implica un hash slot por tenant-tabla en Redis Cluster: un tenant muy caliente concentra su tráfico en un nodo.
- Las puntuaciones de los índices deben ser enteros seguros (Postgres y SQLite las guardan como enteros de 64 bits).
- Quien crea el `DurableKv` es quien llama a `start()`/`stop()`; este paquete nunca los invoca.
