# @botmesh/manager

> **Experimental — aún no publicado en npm.** Es una implementación real y con tests, pero el paquete es `private`: no forma parte de la primera alpha y su API puede cambiar. Úsalo desde este monorepo (`workspace:*`).

Orquestador multi-bot para [`@botmesh/core`](../core): gestiona muchas
instancias de `Bot` desde un único registro. Añade y quita bots por id, sigue
su estado de ejecución, arráncalos o detenlos uno a uno o todos a la vez y,
si quieres, exponlo todo con una pequeña API HTTP sin dependencias.

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'
import { BotManager, createManagerApi } from '@botmesh/manager'
import { createServer } from 'node:http'

const manager = new BotManager()

manager.on('error', ({ id, error }) => console.error(`[${id}]`, error))
manager.on('started', (id) => console.log(`[${id}] arriba`))

const bot = new Bot({ provider: new BaileysProvider({ session: 'acme' }) })
bot.when('hola', async (ctx) => ctx.reply('¡Hola! 👋'))

const id = manager.add(bot, { id: 'acme', meta: { tenant: 'Acme Corp' } })
// id === 'acme' (se genera 'bot-N' si no pasas id)

await manager.start(id)
console.log(manager.list()) // [{ id: 'acme', running: true, meta: { tenant: 'Acme Corp' } }]

// Plano de control por HTTP (opcional). Define siempre un token: sin `auth` la API no tiene autenticación.
createServer(createManagerApi(manager, { prefix: '/api', auth: { token: process.env.MANAGER_TOKEN! } })).listen(3000)
```

## BotManager

`BotManager extends EventEmitter`. Un bot se considera **en ejecución** entre
un `start(id)` correcto y su `stop(id)`: el manager guarda internamente el
conjunto de ids en ejecución y lo actualiza alrededor del `start()`/`stop()`
de cada bot.

Cualquier objeto con `start()` / `stop()` se puede gestionar (un `Bot` del
core o un stub) a través de la interfaz estructural `ManageableBot`.

### Registro

| Método | Devuelve | Notas |
| --- | --- | --- |
| `add(bot, opts?: { id?, tenantId?, name?, meta? })` | `string` (el id) | Id automático `bot-N` si se omite (nunca colisiona); **lanza si el id está repetido**. Emite `added`. |
| `get(id)` | `ManageableBot \| undefined` | La instancia del bot. |
| `has(id)` | `boolean` | |
| `remove(id)` | `Promise<boolean>` | Detiene antes el bot si está en ejecución (un `stop` fallido emite `error` pero no impide quitarlo). Emite `removed`. `false` si el id no existe. |
| `list()` | `Array<{ id, running, tenantId?, name?, meta? }>` | Foto del estado de todos los bots. |
| `status(id)` | `{ id, running, tenantId?, name?, meta? } \| undefined` | Foto del estado de un bot. |
| `entries()` | `BotEntry[]` | Entradas completas: `{ id, bot, createdAt, tenantId?, name?, meta? }`. |
| `isRunning(id)` | `boolean` | |
| `size` | `number` (getter) | Número de bots registrados. |

### Ciclo de vida

| Método | Comportamiento |
| --- | --- |
| `start(id)` / `stop(id)` | `Promise<void>`. Idempotentes (no hacen nada si ya está en ejecución / detenido). Lanzan con ids desconocidos; relanzan los fallos del bot tras emitir `error`. Un `stop` fallido deja el bot marcado como en ejecución. |
| `restart(id, { recreate? })` | Detiene (si está en ejecución) y vuelve a arrancar; emite `restarted`. `recreate: true` reconstruye con la factory un bot respaldado por configuración. |
| `startAll()` / `stopAll()` | `Promise<Record<string, 'ok' \| Error>>`. Corren **en paralelo** y nunca lanzan: los fallos se recogen por id en el mapa de resultados. |
| `shutdown()` | Cancela las reconexiones pendientes y detiene todos los bots **sin** cambiar el estado deseado persistido (así `restore()` los vuelve a levantar). |

```ts
const results = await manager.startAll()
// { acme: 'ok', beta: Error('connect ECONNREFUSED …') }
for (const [id, outcome] of Object.entries(results)) {
  if (outcome !== 'ok') console.error(id, outcome.message)
}
await manager.stopAll()
```

### Eventos

| Evento | Payload | Cuándo |
| --- | --- | --- |
| `added` | `id: string` | Tras registrar un bot con `add()`. |
| `removed` | `id: string` | Tras quitar un bot con `remove()`. |
| `started` | `id: string` | Tras un `start(id)` correcto. |
| `stopped` | `id: string` | Tras un `stop(id)` correcto. |
| `restarted` | `id: string` | Tras un `restart(id)` (manual o del supervisor). |
| `error` | `{ id: string, error: unknown }` | Falló una operación del ciclo de vida (también se relanza o aparece en los mapas de resultados). |
| `connection` | `{ id, state, reason?, authPayload?, updatedAt? }` | Cambió el estado de conexión de un bot (bots que emiten `connection`). |
| `reconnecting` / `reconnected` / `reconnectFailed` | `{ id, attempt, delayMs, reason }` / `{ id, attempts }` / `{ id, attempts, error? }` | Actividad del supervisor (ver *Reconexión automática*). |

Los listeners están tipados con `ManagerEventMap`. Se instala un listener
`error` por defecto que no hace nada, para que un fallo sin observar nunca
tumbe el proceso por la semántica de `EventEmitter`; añade tu propio listener
`error` para tratarlos.

## API HTTP

Hay tres superficies HTTP. La completa es **`createRestApi`** (ver *API REST `/v1` completa* más abajo). `createControlPlaneApi(manager, { tenantId, apiKeys })` es una superficie `/v1` mínima y auditada, sin modo anónimo (también usa el prefijo `/v1` por defecto, así que no la montes junto a `createRestApi` en el mismo prefijo). Cada API key lleva scopes, cada respuesta incluye `x-request-id` y las operaciones del ciclo de vida aceptan un `Idempotency-Key`.

```ts
createServer(createControlPlaneApi(manager, {
  tenantId: 'acme',
  apiKeys: [{ id: 'ops', tenantId: 'acme', secret: process.env.MANAGER_KEY!, scopes: ['bots:read', 'bots:operate', 'audit:read'] }],
})).listen(3000)
```

Rutas iniciales: `GET /v1/health`, `GET /v1/bots`, `POST /v1/bots/:id/start`, `POST /v1/bots/:id/stop` y `GET /v1/audit`. Consulta la [guía del plano de control](https://github.com/andresayac/botmesh/blob/main/docs/es/guide/control-plane.md).

La API compacta heredada, `createManagerApi(manager, opts?: { prefix?, auth?: { token, header? } })`,
devuelve un handler de Node `(req, res) => void` (solo usa `node:http`: móntalo
en `http.createServer` o llámalo desde cualquier framework). Todas las
respuestas son JSON. Con `auth`, cada petición debe presentar el token
(`Authorization: Bearer <token>` por defecto, o la cabecera indicada en
`auth.header`; comparación timing-safe) o recibe `401`. **Sin `auth` la API no
tiene autenticación**: cualquiera que alcance el socket puede listar, arrancar
y detener bots, y se registra un aviso una sola vez.

| Ruta | Éxito | Errores |
| --- | --- | --- |
| `GET {prefix}/health` | `200` — `{ status: 'ok', bots, running }` | |
| `GET {prefix}/metrics` | `200` — texto Prometheus (`botwa_manager_bots_registered`, `botwa_manager_bots_running`) | |
| `GET {prefix}/bots` | `200` — `Array<{ id, running, meta }>` | |
| `GET {prefix}/bots/:id` | `200` — `{ id, running, meta }` | `404 { error }` id desconocido |
| `POST {prefix}/bots/:id/start` | `200` — `{ id, running: true }` | `404` id desconocido · `500 { error }` fallo al arrancar |
| `POST {prefix}/bots/:id/stop` | `200` — `{ id, running: false }` | `404` id desconocido · `500 { error }` fallo al detener |

Cualquier otra ruta o método → `404 { "error": "not found" }`. Los ids de las
URLs pueden ir codificados con porcentaje.

```bash
H="Authorization: Bearer $MANAGER_TOKEN"
curl -H "$H" localhost:3000/api/bots                 # listar
curl -H "$H" localhost:3000/api/bots/acme            # estado
curl -H "$H" -X POST localhost:3000/api/bots/acme/start
curl -H "$H" -X POST localhost:3000/api/bots/acme/stop
```

## API REST `/v1` completa (`createRestApi`)

`createRestApi(manager, { tokens })` es la API recomendada para plataformas: `node:http` puro, sin dependencias, con documento **OpenAPI 3.1** en `GET /v1/openapi.json`.

```ts
import { createServer } from 'node:http'
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'
import { BotManager, createRestApi } from '@botmesh/manager'

const manager = new BotManager({
  // Construye un bot a partir de su config serializable (nunca guardes secretos crudos en provider.options).
  factory: (cfg) => new Bot({
    provider: new BaileysProvider({ session: `${cfg.tenantId}-${cfg.id}` }),
    tenantId: cfg.tenantId,
    botId: cfg.id,
  }),
  persistence: { dir: './data/bots' },          // <dir>/<tenantId>/<botId>.json (escritura atómica, 0600)
  autoReconnect: { maxRetries: 5, initialDelay: 1000, maxDelay: 30_000, jitter: 0.2 },
})
await manager.restore()                          // reconstruye los bots guardados y arranca los que estaban "running"

createServer(createRestApi(manager, {
  tokens: [
    { id: 'ops', token: process.env.OPS_TOKEN!, scopes: ['*'] },                                  // todos los tenants
    { id: 'acme', token: process.env.ACME_TOKEN!, tenantId: 'acme', scopes: ['bots:read', 'messages:send'] },
  ],
})).listen(3000)
process.on('SIGTERM', () => void manager.shutdown())   // para todo sin tocar el desiredState persistido
```

| Ruta (`/v1/...`) | Scope |
| --- | --- |
| `GET /health`, `GET /openapi.json`, `GET /flows/schema` | público (`publicDocs: false` exige token para docs) |
| `GET/POST /bots`, `GET/PUT/DELETE /bots/{id}` | `bots:read` / `bots:write` |
| `POST /bots/{id}/start\|stop\|restart` | `bots:operate` |
| `GET /bots/{id}/connection` (estado + QR/código de emparejamiento) | `connections:read` |
| `POST /bots/{id}/send` | `messages:send` |
| `GET /bots/{id}/messages?chatId=&limit=&cursor=` | `messages:read` |
| `POST /bots/{id}/trigger`, `GET /bots/{id}/conversations`, `POST /bots/{id}/conversations/{key}/cancel` | `conversations:*` |
| `GET/POST /bots/{id}/flows`, `GET/PUT/DELETE /bots/{id}/flows/{flowId}` | `flows:*` |
| `GET /metrics`, `GET /bots/{id}/metrics` | `metrics:read` |

Además: `X-Request-Id` en todas las respuestas, rate limiting por token (`RateLimit-*`, `Retry-After`), `Idempotency-Key` en rutas que mutan (replay 24 h, `422` si se reutiliza con otro cuerpo), límite de cuerpo (`413`), `415` si no es JSON, aislamiento por tenant (un token de tenant no ve bots ajenos: `404`). Los errores siguen `{ error: { code, message, requestId, details? } }`.

## Flows JSON dinámicos

`compileFlowDocument(doc)` convierte un documento JSON (sin código) en un `CompiledFlow` que se registra con `bot.registerFlow()` / `bot.replaceFlow()`. Pasos: `say`, `ask` (con `validate.expr`), `choose`, `delay`, `goto`, `end`, `condition`; plantillas `{{ path }}` y expresiones seguras (`len(name) > 2 && oneOf(plan, "pro", "max")`). Esquema JSON versionado: `FLOW_DOCUMENT_SCHEMA` (`GET /v1/flows/schema`).

## Reconexión automática

Con `autoReconnect`, si la conexión se cae (`connection: closed`, salvo `sessionTakenOver`) y el provider no se recupera solo en `graceMs`, o si un arranque falla, el manager reinicia el bot con backoff exponencial + jitter hasta `maxRetries` (eventos `reconnecting`, `reconnected`, `reconnectFailed`). Los bots con config se recrean con la factory (provider nuevo).

## Logging

El manager registra los eventos del ciclo de vida con pino en `debug`/`warn`.
Inyecta tu propio logger (`new BotManager({ logger })`) o activa el de por
defecto con `BOTWA_MANAGER_LOG_LEVEL=debug` (por defecto: `silent`).

## Desarrollo

```bash
pnpm --filter @botmesh/manager build   # tsc → lib/
pnpm --filter @botmesh/manager test    # vitest (herméticos: bots falsos, sin red)
```
