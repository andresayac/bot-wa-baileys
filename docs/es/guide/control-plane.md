# Control plane

::: warning Experimental — aún no publicado en npm
`@bot-wa/manager` es **experimental**: una implementación real y con tests,
pero todavía privada (no está en npm ni forma parte de la primera alpha) y su
API puede cambiar. Úsalo desde el monorepo (`workspace:*`).
:::

`@bot-wa/manager` ejecuta muchos bots en un proceso y los expone por HTTP.
Tiene cuatro piezas:

- **`BotManager`**: un registro de bots (`add`, `start`, `stop`, `restart`,
  `startAll`, `stopAll`, `shutdown`) con eventos tipados.
- **Persistencia y supervisión**: configs serializables de bots por tenant,
  `restore()` tras un reinicio y reconexión automática con backoff.
- **Flows JSON**: documentos de flujo declarativos, sin código, que se compilan
  a flujos del core y se cambian en caliente con el
  [registro dinámico de flujos del core](#registro-dinamico-de-flujos-del-core).
- **APIs HTTP**: la API REST `/v1` completa (`createRestApi`, con documento
  OpenAPI 3.1) y dos superficies más pequeñas (`createControlPlaneApi` y la
  heredada `createManagerApi`).

Todos los handlers HTTP son handlers de `node:http` sin dependencias.

## Inicio rápido

```ts
import { createServer } from 'node:http'
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { BotManager, createRestApi } from '@bot-wa/manager'

const manager = new BotManager({
  // Builds a bot from its serializable config (never store raw secrets in provider.options).
  factory: (cfg) => new Bot({
    provider: new BaileysProvider({ session: `${cfg.tenantId}-${cfg.id}` }),
    tenantId: cfg.tenantId,
    botId: cfg.id,
  }),
  persistence: { dir: './data/bots' },   // <dir>/<tenantId>/<botId>.json
  autoReconnect: true,
})
await manager.restore()                   // rebuild saved bots, start the ones that were running

createServer(createRestApi(manager, {
  tokens: [
    { id: 'ops', token: process.env.OPS_TOKEN!, scopes: ['*'] },   // every tenant
    { id: 'acme', token: process.env.ACME_TOKEN!, tenantId: 'acme', scopes: ['bots:read', 'messages:send'] },
  ],
})).listen(3000)

process.on('SIGTERM', () => void manager.shutdown())   // stops everything, keeps the persisted desired state
```

## `BotManager`

Se puede gestionar cualquier cosa con `start()` / `stop()` (el tipo
estructural `ManageableBot`): un `Bot` del core o un stub. Las funciones más
allá de start/stop (enviar, flujos, conversaciones, historial de mensajes) solo
se usan si el bot tiene el método correspondiente; si no, la API REST responde
`501 NOT_SUPPORTED`. Un `Bot` del core los tiene todos.

| Método | Notas |
| --- | --- |
| `add(bot, { id?, tenantId?, name?, meta? })` | Registra un bot y devuelve su id (`bot-N` si se omite). Lanza si el id está repetido. |
| `get(id)` / `has(id)` / `remove(id)` | `remove` detiene antes el bot; la config persistida se conserva (usa `deleteBot`). |
| `list()` / `status(id)` / `entries()` / `isRunning(id)` / `size` | Snapshots de estado: `{ id, running, tenantId?, name?, meta? }`. |
| `start(id)` / `stop(id)` | Idempotentes. Lanzan con ids desconocidos y relanzan los fallos del bot tras emitir `error`. También persisten el estado deseado de un bot con config. |
| `restart(id, { recreate? })` | Detiene y vuelve a arrancar. `recreate: true` reconstruye un bot con config mediante la factory (provider nuevo). |
| `startAll()` / `stopAll()` | En paralelo y sin lanzar nunca: `Record<id, 'ok' \| Error>`. |
| `shutdown()` | Cancela las reconexiones pendientes y detiene todos los bots **sin** cambiar el estado deseado persistido, así que `restore()` los vuelve a levantar. |
| `connection(id)` | `{ state, reason?, authPayload?, updatedAt? }`. `state` es `connecting`, `authenticating`, `ready`, `closed` o `unknown`. `authPayload` es el QR o el código de emparejamiento mientras se autentica: trátalo como un secreto. |
| `metrics(id)` | `{ id, running, connection, startedAt?, uptimeMs, messagesIn, errors, starts, restarts, reconnectAttempts, activeConversations?, flows? }`. Los dos últimos solo aparecen si el bot expone `listConversations()` / `listFlows()`. |

Eventos (tipados con `ManagerEventMap`):

| Evento | Payload |
| --- | --- |
| `added`, `removed`, `started`, `stopped`, `restarted` | `id` |
| `error` | `{ id, error }` (un listener vacío por defecto evita que el proceso caiga) |
| `connection` | `{ id, state, reason?, ... }` para bots que emiten `connection` |
| `reconnecting` | `{ id, attempt, delayMs, reason }` |
| `reconnected` | `{ id, attempts }` |
| `reconnectFailed` | `{ id, attempts, error? }` |

Los logs pasan por pino en `debug`/`warn`: inyecta un logger
(`new BotManager({ logger })`) o define `BOTWA_MANAGER_LOG_LEVEL=debug`
(por defecto `silent`).

## Persistencia multi-tenant

Un bot creado con `createBot()` tiene detrás un `BotConfigRecord`: `id`,
`tenantId`, `name?`, `provider?: { type, options? }`, `flows?` (documentos de
flujo JSON), `meta?`, `desiredState` (`running` | `stopped`), `version`,
`createdAt` y `updatedAt`. El bloque `provider` es opaco para el manager: lo
interpreta tu `factory(config)`.

| Método | Notas |
| --- | --- |
| `createBot({ id?, tenantId?, name?, provider?, flows?, meta?, autoStart? })` | Construye el bot con la factory, lo registra, persiste la config y lo arranca (`autoStart` es `true` por defecto). Un arranque fallido se reporta con `error`; no rechaza. |
| `updateBot(id, patch, { expectedVersion? })` | Modifica `name`, `provider`, `flows`, `meta` o `desiredState`. Cambiar `provider` o `flows` reconstruye el bot. `expectedVersion` da concurrencia optimista (`CONFLICT` si no coincide). |
| `deleteBot(id)` | Detiene, desregistra y borra la config persistida. |
| `restore()` | Llámalo una vez al arrancar: reconstruye todos los bots guardados y arranca los que tienen estado deseado `running`. Devuelve `Record<id, 'started' \| 'stopped' \| Error>`. |
| `getConfig(id)` / `listConfigs(tenantId?)` | Copias de los registros guardados. |

Los ids de bot y de tenant deben cumplir `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`
(se usan como nombres de archivo). Los bots creados sin tenant usan
`defaultTenantId` (`'default'`).

El almacenamiento es intercambiable mediante `BotConfigStore` (`list`, `get`,
`put`, `delete`):

- `persistence: { dir }` es un atajo de
  `configStore: new FileBotConfigStore({ dir })`: un archivo JSON por bot en
  `<dir>/<tenantId>/<botId>.json`, escrituras atómicas, modo `0600`
  (directorios `0700`). Los archivos que no se pueden parsear se saltan, nunca
  se borran (`onCorrupt` los recibe).
- `MemoryBotConfigStore` guarda las configs en RAM (tests). Sin store no se
  persiste nada y `restore()` lanza `NOT_CONFIGURED`.

::: warning Secretos
`provider.options` se escribe en disco tal cual. Guarda una referencia (el
nombre de una variable de entorno, una ref de `SecretVault`) y resuélvela
dentro de la factory.
:::

## Supervisión y reconexión

Con `autoReconnect`, el manager supervisa cada bot que pediste arrancar:

- cuando un bot emite `connection: closed` (salvo `sessionTakenOver`) y el
  provider no se recupera solo en `graceMs`, o
- cuando falla un arranque,

reinicia el bot con backoff y jitter hasta agotar `maxRetries`. Los bots con
config se recrean mediante la factory (provider nuevo). Un `stop()` manual
cancela la supervisión.

| Opción | Por defecto |
| --- | --- |
| `enabled` | `true` si se pasa un objeto (`autoReconnect: true` usa todos los valores por defecto) |
| `maxRetries` | `5` (`Infinity` no se rinde nunca) |
| `initialDelay` / `maxDelay` | `1000` / `30000` ms |
| `backoff` / `factor` | `'exponential'` (o `'linear'`) / `2` |
| `jitter` | `0.2` (cada espera queda entre el 80 y el 100 % de su valor) |
| `graceMs` | `10000` |

`computeBackoff(attempt, opts)` y `resolveAutoReconnect(input)` se exportan
para supervisores propios.

## Registro dinámico de flujos del core

El manager usa estos métodos de `Bot` de `@bot-wa/core`; puedes usarlos
directamente en cualquier bot:

| Método | Comportamiento |
| --- | --- |
| `bot.registerFlow(flow)` | Registra un `FlowBuilder` o un `CompiledFlow` en tiempo de ejecución y devuelve su id. Lanza si el id ya existe. |
| `bot.replaceFlow(id, flow)` | Cambia en caliente (o registra) el flujo de `id`; su trigger reemplaza al anterior. Las conversaciones en curso siguen con la versión con la que entraron; los checkpoints persistidos se reanudan en los pasos nuevos por índice de paso. |
| `bot.unregisterFlow(id)` | Quita un flujo o una conversación; sus triggers dejan de coincidir. `false` si no existe. |
| `bot.hasFlow(id)` | Si hay un flujo o una conversación registrados con `id`. |
| `bot.listFlows()` | `RegisteredFlowInfo[]`: `{ id, kind: 'flow', steps, persistent }` o `{ id, kind: 'conversation' }`. |
| `bot.triggerFlow(id, { chatId, userId?, isGroup? }, { state?, body? })` | Inicia un flujo de forma proactiva en un chat. Devuelve `Promise<boolean>`. |
| `bot.listConversations()` | `ConversationSnapshot[]`: `{ key, state, waiting, queued, accepts? }`. |
| `bot.abortConversation(key)` | Aborta una conversación viva por su clave. |

`triggerFlow()` es una envoltura fina sobre `bot.trigger()` con
`ifActive: 'replace'`: pasa por los mismos gates de listas de acceso y handoff,
el turno FIFO del chat, la resolución de idioma y las métricas, y reemplaza una
conversación que ya esté en curso (o dormida) en la misma clave. `state` se
mezcla (superficialmente) en `c.state`; `body` es el `ctx.body` del mensaje
sintético (por defecto `''`). Resuelve `false` si el flujo no existe, las
listas de acceso bloquean al sujeto o el chat está en handoff, y rechaza si el
bot no está arrancado.

```ts
import { flow } from '@bot-wa/core'

bot.registerFlow(flow('encuesta').ask('¿Tu nombre?', 'name').say((_ctx, c) => `Gracias ${c.state.name}`))
await bot.triggerFlow('encuesta', { chatId }, { state: { source: 'campaign' } })
```

## Flows JSON

Un documento de flujo es solo datos, así que es seguro aceptarlo por la API y
persistirlo. `compileFlowDocument(doc)` lo valida y devuelve un `CompiledFlow`
para `bot.registerFlow()` / `bot.replaceFlow()`; lanza `FlowDocumentError`
(con `issues: { path, message }[]`) si el documento no es válido.
`validateFlowDocument(doc)` devuelve los problemas sin lanzar, e
`isFlowDocument(doc)` es un type guard.

```json
{
  "version": 1,
  "id": "encuesta",
  "trigger": { "keywords": ["encuesta", "sondeo"], "match": "equals", "scope": "dm" },
  "timeout": "10m",
  "steps": [
    { "kind": "ask", "text": "¿Tu nombre?", "stateKey": "name",
      "validate": { "expr": "len($answer) > 1", "message": "Muy corto, intenta de nuevo" } },
    { "kind": "choose", "text": "¿Plan para {{ name }}?", "stateKey": "plan",
      "options": [{ "key": "pro", "label": "Pro" }, { "key": "max", "label": "Max" }] },
    { "kind": "condition", "if": "oneOf(plan, \"pro\", \"max\")",
      "then": [{ "kind": "say", "text": "Buena elección, {{ name }}" }],
      "else": [{ "kind": "end", "text": "Adiós" }] }
  ]
}
```

| Campo | Notas |
| --- | --- |
| `version` | Siempre `1`. |
| `id` | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$` (el mismo patrón vale para `stateKey`, el `key` de las opciones y los destinos de `goto`). |
| `trigger` | Una palabra clave, un array de palabras clave o `{ keywords, match?: 'equals' \| 'contains' \| 'startsWith' \| 'endsWith', scope?: 'dm' \| 'group' \| 'all' }`. |
| `timeout` | Milisegundos o `'500ms'`, `'30s'`, `'5m'`, `'1h'` (como máximo 7 días). |
| `persistent` | Sobrevive a reinicios con un store persistente. |
| `name`, `description` | Texto libre. |

Pasos:

| `kind` | Campos |
| --- | --- |
| `say` | `text` |
| `ask` | `text`, `stateKey`, `timeout?`, `retries?` (0–20), `validate?: { expr, message? }` (`$answer` contiene la respuesta tal cual) |
| `choose` | `text`, `options: [{ key, label, steps? }]` (hasta 20; los `steps` de una opción se ejecutan al elegirla), `stateKey?`, `timeout?` |
| `delay` | `duration` (como máximo 5 minutos) |
| `goto` | `target` (el id de otro flujo) |
| `end` | `text?` |
| `condition` | `if` (expresión), `then` (pasos), `else?` (pasos) |

Los textos aceptan marcadores `{{ path }}` sobre `c.state` y `$body`, `$from`,
`$sender`, `$isGroup`. Las expresiones (`condition.if`, `ask.validate.expr`)
usan un lenguaje pequeño y seguro que se parsea al compilar (sin `eval` ni
regex): literales, rutas del estado, `== != < <= > >= && || ! + -`,
paréntesis y las funciones `len`, `lower`, `upper`, `trim`, `number`, `string`,
`contains`, `startsWith`, `endsWith`, `empty`, `oneOf`.

Límites (`FLOW_DOCUMENT_LIMITS`): 500 pasos, 8 niveles de anidación, 4096
caracteres por texto, 20 opciones, 50 palabras clave y expresiones de hasta
1000 caracteres. El JSON Schema (draft 2020-12) se exporta como
`FLOW_DOCUMENT_SCHEMA` y se sirve en `GET /v1/flows/schema`.

En un bot gestionado usa `manager.addFlow(botId, doc)`,
`manager.putFlow(botId, flowId, doc)` (crea o cambia en caliente; el `id` del
documento debe coincidir), `manager.removeFlow(botId, flowId)` y
`manager.listFlowDocuments(botId)`. En los bots con config, los documentos se
persisten con la config y se vuelven a registrar en cada reconstrucción.

## API REST `/v1` (`createRestApi`)

`createRestApi(manager, options)` devuelve un handler
`(req, res, next?) => void`. Las peticiones fuera del prefijo llaman a `next()`
si se pasa (para montarlo dentro de otro servidor) o reciben `404`.

| Opción | Por defecto |
| --- | --- |
| `tokens` | **Obligatorio** (al menos uno): `{ id, token, tenantId?, scopes }`. El secreto necesita 16 caracteres o más (usa 32+ bytes aleatorios). |
| `prefix` | `'/v1'` |
| `publicDocs` | `true`: `openapi.json` y `flows/schema` no piden token (con `false` piden `bots:read`) |
| `maxBodyBytes` | 1 MiB |
| `rateLimit` | Token bucket por token (por dirección del cliente en llamadas anónimas): ráfaga de 60, 1 petición/s. Pasa opciones, tu propio `RateLimiter` o `false`. |
| `idempotency` | En memoria, replay de 24 h. Pasa opciones, tu propio `IdempotencyStore` o `false`. |
| `defaultTenantId` | `'default'` (tenant de los bots añadidos sin tenant) |
| `openapi` | Sobrescrituras `{ title?, version?, servers? }` del documento |
| `allowInsecureMediaUrls` | `false`: `send` solo acepta URLs de media `https:` |

### Autenticación y tenants

Envía el token como `Authorization: Bearer <token>` o `X-API-Key: <token>`
(se compara mediante digests SHA-256 en tiempo constante). Un token sin
`tenantId` (o con `'*'`) ve todos los tenants; un token de tenant solo ve sus
propios bots, y cualquier otro bot responde `404`. Scopes (`'*'` los concede
todos):

`bots:read`, `bots:write`, `bots:operate`, `connections:read`,
`messages:read`, `messages:send`, `conversations:read`,
`conversations:write`, `flows:read`, `flows:write`, `metrics:read`.

### Rutas

Todas las rutas son relativas al prefijo.

| Ruta | Scope | Éxito |
| --- | --- | --- |
| `GET /health` | pública | `200 { status, uptimeMs }` |
| `GET /openapi.json` | pública (ver `publicDocs`) | `200` documento OpenAPI 3.1 |
| `GET /flows/schema` | pública (ver `publicDocs`) | `200` JSON Schema de los documentos de flujo |
| `GET /metrics` | `metrics:read` | `200 { bots, running, messagesIn, items }` |
| `GET /bots?tenantId=` | `bots:read` | `200` lista de bots |
| `POST /bots` | `bots:write` | `201` detalle del bot (necesita una `factory`) |
| `GET /bots/{botId}` | `bots:read` | `200` estado, estado de conexión y config (con las claves que parecen secretos de `provider` y `meta` redactadas) |
| `PUT /bots/{botId}` | `bots:write` | `200` (`expectedVersion` → `409` si no coincide) |
| `DELETE /bots/{botId}` | `bots:write` | `204` |
| `POST /bots/{botId}/start`, `/stop`, `/restart` | `bots:operate` | `200` estado nuevo |
| `GET /bots/{botId}/connection` | `connections:read` | `200` estado más el QR / código de emparejamiento |
| `POST /bots/{botId}/send` | `messages:send` | `200 { messageId?, chatId, skipped? }` |
| `GET /bots/{botId}/messages?chatId=&limit=&cursor=` | `messages:read` | `200 { data, nextCursor }`, más recientes primero, `limit` 1–200 (por defecto 50) |
| `POST /bots/{botId}/trigger` | `conversations:write` | `202 { started: true }` |
| `GET /bots/{botId}/conversations` | `conversations:read` | `200` conversaciones vivas |
| `POST /bots/{botId}/conversations/{key}/cancel` | `conversations:write` | `200 { cancelled: true }` |
| `GET /bots/{botId}/metrics` | `metrics:read` | `200` contadores del bot |
| `GET /bots/{botId}/flows` | `flows:read` | `200 { registered, documents }` |
| `POST /bots/{botId}/flows` | `flows:write` | `201 { id }` |
| `GET /bots/{botId}/flows/{flowId}` | `flows:read` | `200` documento guardado |
| `PUT /bots/{botId}/flows/{flowId}` | `flows:write` | `201` creado / `200` reemplazado |
| `DELETE /bots/{botId}/flows/{flowId}` | `flows:write` | `204` |

Cuerpos de las peticiones:

- `send`: `{ chatId, text }` o `{ chatId, content }`. `content` es un
  subconjunto permitido de `OutboundContent`: `text`, `image`, `video`,
  `audio`, `voice`, `document`, `sticker` (la media solo como
  `{ url: "https://..." }`, sin rutas ni buffers), `location`, `contact` y
  `poll` (2–12 opciones).
- `trigger`: `{ flowId, chatId, userId?, isGroup?, state? }` (`state` de hasta
  16 KiB de JSON). Llama a `bot.triggerFlow()`: `404` si el flujo no existe, el
  sujeto está bloqueado o el chat está en handoff; `409 BOT_NOT_RUNNING` si el
  bot está detenido.
- `POST /bots`: `{ id?, tenantId?, name?, provider?, flows?, meta?, autoStart? }`.
  Un token de tenant solo puede crear bots en su propio tenant.

```bash
H="Authorization: Bearer $ACME_TOKEN"
curl -H "$H" localhost:3000/v1/bots
curl -H "$H" -H 'content-type: application/json' -H 'Idempotency-Key: send-42' \
  -d '{"chatId":"573001234567","text":"Hola"}' localhost:3000/v1/bots/support/send
```

### Respuestas y códigos de estado

Las respuestas correctas son `{ data, requestId }` (el documento OpenAPI y el
schema de flujos se devuelven tal cual). Los errores son
`{ error: { code, message, requestId, details? } }`. Toda respuesta lleva
`X-Request-Id` (se reutiliza uno entrante válido), `Cache-Control: no-store` y
`X-Content-Type-Options: nosniff`. Con el rate limit activo (por defecto),
todas las rutas, públicas incluidas, están limitadas y añaden
`RateLimit-Limit` y `RateLimit-Remaining`.

| Estado | `code` | Cuándo |
| --- | --- | --- |
| `400` | `VALIDATION_FAILED`, `INVALID_JSON`, `BAD_REQUEST` | Cuerpo, query o ruta inválidos (los problemas del flujo van en `details`) |
| `401` | `UNAUTHORIZED` | Falta el token o no se reconoce (`WWW-Authenticate: Bearer`) |
| `403` | `FORBIDDEN` | Falta el scope, o `tenantId` de otro tenant |
| `404` | `NOT_FOUND` | Ruta, bot (o bot de otro tenant), flujo o conversación desconocidos |
| `405` | `METHOD_NOT_ALLOWED` | Ruta conocida con un método incorrecto (cabecera `Allow`) |
| `409` | `CONFLICT`, `BOT_NOT_RUNNING` | Id o flujo repetido, versión distinta, trigger con el bot detenido |
| `413` | `PAYLOAD_TOO_LARGE` | Cuerpo mayor que `maxBodyBytes`, o contenido por encima de un límite del provider |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | El cuerpo no es `application/json` |
| `422` | `IDEMPOTENCY_KEY_REUSED`, `UNSUPPORTED_CONTENT`, `RECIPIENT_UNREACHABLE`, `OUTSIDE_SESSION_WINDOW` | Clave reutilizada con otra petición, o el provider rechazó el envío |
| `429` | `RATE_LIMITED` | Se alcanzó el rate limit (`Retry-After`) |
| `500` | `INTERNAL`, `LIFECYCLE_FAILED` | Error inesperado, o falló start/stop/restart |
| `501` | `NOT_SUPPORTED`, `NOT_CONFIGURED` | Al bot le falta la capacidad, o el manager no tiene factory/store |
| `502` | `SEND_FAILED` | El provider no pudo enviar |
| `503` | `UPSTREAM_RATE_LIMITED` | El provider limitó el envío (`Retry-After`) |

### Idempotencia

Las rutas que mutan aceptan `Idempotency-Key` (1–200 caracteres ASCII
visibles). Las claves van por token. Repetir una petición con la misma clave,
método, ruta y cuerpo devuelve la respuesta guardada (cabecera
`Idempotent-Replayed: true`); reutilizar la clave para otra petición da
`422 IDEMPOTENCY_KEY_REUSED`. Los resultados 5xx no se guardan, así que se
pueden reintentar. `MemoryIdempotencyStore` y `TokenBucketRateLimiter` (los de
por defecto) viven en la memoria del proceso: con varias instancias, conecta tu
propio `IdempotencyStore` / `RateLimiter`.

### Documento OpenAPI

El documento OpenAPI 3.1 se genera a partir de la misma tabla de rutas que usa
el router (`ROUTES`), así que no puede desalinearse de la implementación.
Obtenlo de un servidor en marcha:

```bash
curl localhost:3000/v1/openapi.json > openapi.json
```

o constrúyelo en código, sin servidor:

```ts
import { buildOpenApiDocument } from '@bot-wa/manager'

const doc = buildOpenApiDocument({ title: 'Bots API', servers: ['https://bots.example.com'] })
```

`buildOpenApiDocument({ prefix?, title?, version?, servers? })` usa por
defecto `'/v1'`, `'bot-wa Manager API'`, `'1.0.0'` y un servidor relativo.
Declara los dos esquemas de seguridad (`bearerAuth` y `apiKey` mediante
`X-API-Key`) y un `x-required-scope` por operación.

## Otras superficies HTTP

### `createControlPlaneApi`

Una superficie mínima y auditada, con API keys ligadas a un tenant. También usa
el prefijo `/v1` por defecto, así que no la montes junto a `createRestApi` en
el mismo prefijo.

```ts
import { BotManager, createControlPlaneApi } from '@bot-wa/manager'

createServer(createControlPlaneApi(manager, {
  tenantId: 'acme',
  apiKeys: [{ id: 'ops', tenantId: 'acme', secret: process.env.MANAGER_KEY!, scopes: ['bots:read', 'bots:operate', 'audit:read'] }],
})).listen(3000)
```

- Exige `tenantId` y al menos una clave; no hay modo anónimo. Las claves van en
  `X-API-Key` o en `Authorization: Bearer <key>`.
- Rutas: `GET /v1/health` y `GET /v1/bots` (`bots:read`),
  `POST /v1/bots/:id/start` y `POST /v1/bots/:id/stop` (`bots:operate`),
  `GET /v1/audit` (`audit:read`).
- Las respuestas son `{ data, requestId }`; los errores,
  `{ error: { code, requestId } }` con `401 UNAUTHORIZED`, `403 FORBIDDEN`,
  `404 NOT_FOUND`, `409 CONFLICT` (una `Idempotency-Key` reutilizada para otra
  petición) y `500 INTERNAL`.
- Las llamadas de health, listado y start/stop, y toda petición denegada o a
  un bot desconocido de una clave autenticada, se escriben en un `AuditLog`
  (en memoria; pasa el tuyo con `auditLog`). Las claves de metadatos que
  parecen tokens, secretos, contraseñas o API keys se redactan.

Piezas relacionadas: `SecretVault` (AES-256-GCM, clave maestra de 32 bytes;
`put` solo devuelve `{ ref, version }`), `IdempotencyRegistry`,
`assertAuthorized` y `verifyApiKey` (comparación en tiempo constante).

### Reconciliador de estado deseado

`MemoryDesiredStateStore` y `BotReconciler` separan el estado deseado
(`running` / `stopped`) del observado. `reconcile(tenantId, botId)` arranca o
detiene un bot solo cuando hace falta; `reconcileTenant(tenantId)` lo hace con
todos los bots de un tenant. Las escrituras usan versiones compare-and-set
(`DesiredStateConflictError`), así que dos actualizaciones en competencia no se
pisan en silencio. Sustituye el store en memoria por un `DesiredStateStore`
durable antes de ejecutar más de un proceso.

### `createManagerApi` (heredada)

`createManagerApi(manager, { prefix?, auth?: { token, header? } })` conserva
la API compacta original: `GET {prefix}/health`, `GET {prefix}/metrics`
(texto Prometheus), `GET {prefix}/bots`, `GET {prefix}/bots/:id`,
`POST {prefix}/bots/:id/start` y `POST {prefix}/bots/:id/stop`. Sin `auth`
**no tiene autenticación** y registra un aviso una sola vez; pon siempre un
token. Para despliegues nuevos, usa `createRestApi`.

## Ver también

- [README de `@bot-wa/manager`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/manager)
- [Operación](/es/guide/operations)
- [Transcripciones doradas](/es/guide/transcripciones): condiciona los despliegues a conversaciones grabadas
