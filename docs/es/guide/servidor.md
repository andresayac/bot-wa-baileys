# Servidor de webhooks (`@bot-wa/server`)

Los providers por webhook (WhatsApp Cloud API, Messenger, Instagram, Telegram
en modo webhook, Evolution, Twilio, TikTok...) no abren ninguna conexión: el
canal envía los eventos por POST a **tu** servidor HTTP, y tú le pasas cada
petición a `provider.ingest()`. `@bot-wa/server` es esa capa HTTP, bien
hecha:

- **Bytes crudos del body**: `ingest()` recibe el `Buffer` exacto que llegó.
  Las firmas como `X-Hub-Signature-256` de Meta se calculan sobre esos bytes,
  nunca sobre JSON re-serializado.
- **Límite de tamaño** (`413`), 1 MiB por defecto, comprobado contra
  `Content-Length` y mientras llega el stream.
- **Timeouts** para leer el body (`408`) y para `ingest()` (`503`).
- **Límite de concurrencia** (`503` + `Retry-After: 1` al saturarse).
- **Enrutado**: `GET` → `verifyChallenge()` (el handshake de Meta), `POST` →
  `ingest(raw, headers)`. El valor que devuelve `ingest()` es el status HTTP.
- **Endpoints de salud**: `/healthz` (liveness) y `/readyz` (readiness).
- **Sin logs sensibles**: solo método, ruta, status, tamaños y el nombre de
  la clase de error; nunca bodies, cabeceras, query strings ni mensajes de
  error.
- **Sin dependencias de frameworks**: adaptadores para `node:http`, Express,
  Fastify, Hono y runtimes estilo fetch, tipados estructuralmente.

> `@bot-wa/server` es **experimental**: el paquete es `private` y no se
> publica en npm. Úsalo desde este monorepo (`"workspace:*"`).

Los providers por socket (Baileys, Discord, Telegram en modo polling, Email
por IMAP) no necesitan ingress.

## Con `node:http`

```ts
import { createServer } from 'node:http'
import { Bot } from '@bot-wa/core'
import { CloudAPIProvider } from '@bot-wa/meta'
import { TelegramProvider } from '@bot-wa/telegram'
import { createIngress, createNodeHandler } from '@bot-wa/server'

const whatsapp = new CloudAPIProvider({
  accessToken: process.env.META_TOKEN!,
  phoneNumberId: process.env.META_PHONE_ID!,
  verifyToken: process.env.META_VERIFY_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
})
const telegram = new TelegramProvider({
  token: process.env.TELEGRAM_TOKEN!,
  polling: false,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
})
const bot = new Bot({ provider: whatsapp })
const tgBot = new Bot({ provider: telegram })

const ingress = createIngress({
  routes: [
    { path: '/webhook/whatsapp', provider: whatsapp },
    // TelegramProvider.ingest() parses strings: ask for the body as text
    { path: '/webhook/telegram', provider: telegram, body: 'text' },
  ],
  bot,                     // /readyz → 200 only when bot.getConnectionState() === 'ready'
  maxBodyBytes: 512 * 1024,
  maxConcurrent: 32,
})

const server = createServer(createNodeHandler(ingress))
await bot.start()
await tgBot.start()
server.listen(3000)

// Graceful shutdown: stop accepting webhooks, drain the ones in flight
process.on('SIGTERM', async () => {
  await ingress.close({ timeoutMs: 10_000 })
  await bot.stop({ drain: true })
  await tgBot.stop({ drain: true })
  server.close()
})
```

`createNodeHandler(ingress, options)` responde `404` a las rutas que no
sirve; pasa `onNotFound: (req, res) => ...` para encadenar otro handler.

## Express

```ts
import express from 'express'
import { expressIngress } from '@bot-wa/server/express'

const app = express()
app.use(expressIngress(ingress)) // BEFORE express.json()
app.use(express.json())          // the rest of your routes
```

Las rutas que no sirve el ingress pasan a `next()`. Las rutas se comparan
con `req.url`, así que son relativas a donde montes el middleware. Si un
parser ya consumió el body (`express.json()` montado antes), el ingress
responde `500` en lugar de re-serializar. Detrás de `express.raw()`
reutiliza ese `Buffer` (y sigue aplicando `maxBodyBytes`).

## Fastify

```ts
import Fastify from 'fastify'
import { fastifyIngress } from '@bot-wa/server/fastify'

const app = Fastify()
app.register(fastifyIngress(ingress), { prefix: '/hooks' }) // /hooks/webhook/whatsapp, /hooks/healthz...
```

Es un plugin encapsulado: su parser comodín deja el stream intacto solo para
sus propias rutas; el resto de tus rutas conserva el parser JSON de Fastify.

## Hono y runtimes fetch

```ts
import { Hono } from 'hono'
import { honoIngress } from '@bot-wa/server/hono'
import { createFetchHandler } from '@bot-wa/server'

const app = new Hono()
app.use('*', honoIngress(ingress)) // unserved paths → next()

const handler = createFetchHandler(ingress) // (Request) => Promise<Response>, 404 when no route matches
```

`serveFetch(ingress, request)` es la variante de más bajo nivel: resuelve
`undefined` cuando ninguna ruta coincide, para que puedas seguir con otra
cosa. El adaptador de Hono necesita `Buffer` (Node, Bun, Deno, Workers con
`nodejs_compat`).

## Opciones

`createIngress(options)`:

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `routes` | — | `{ path, provider, body?: 'buffer' \| 'text', maxBodyBytes? }[]` |
| `maxBodyBytes` | `1048576` (1 MiB) | Tamaño máximo del body (`413`) |
| `bodyTimeoutMs` | `10000` | Tiempo para recibir el body completo (`408`) |
| `ingestTimeoutMs` | `10000` | Tiempo para que `ingest()` termine (`503`); el hueco de concurrencia se mantiene hasta que termine de verdad |
| `maxConcurrent` | `64` | Webhooks leyéndose o procesándose a la vez (`503` por encima) |
| `healthPath` | `'/healthz'` | Ruta de liveness; `false` la desactiva |
| `readyPath` | `'/readyz'` | Ruta de readiness; `false` la desactiva |
| `bot` | — | Cualquier objeto con `getConnectionState()` (un `Bot`): para estar listo exige `'ready'` |
| `readiness` | — | Check extra, `() => boolean \| Promise<boolean>`; si lanza o da `false` → no listo |
| `logger` | silencioso | Logger compatible con pino (solo metadatos) |

Reglas de rutas: `path` debe empezar por `/`, la barra final se ignora, y las
rutas duplicadas (o una ruta de webhook igual a una de salud) lanzan un
`TypeError`. Una ruta cuyo provider no tiene método `ingest()` también lanza.

Los valores por defecto se exportan como `DEFAULT_MAX_BODY_BYTES`,
`DEFAULT_BODY_TIMEOUT_MS`, `DEFAULT_INGEST_TIMEOUT_MS` y
`DEFAULT_MAX_CONCURRENT`.

### `body: 'buffer'` o `'text'`

`ingest()` recibe el body crudo como `Buffer` (por defecto) o como string
UTF-8 con `body: 'text'`. Usa `'text'` para `TelegramProvider`, cuyo
`ingest()` parsea strings u objetos, pero no buffers.

### Límite de tamaño por ruta

Sube `maxBodyBytes` en las rutas que lo necesiten, por ejemplo el MIME crudo
para `EmailProvider.ingest()`:

```ts
createIngress({
  routes: [
    { path: '/webhook/whatsapp', provider: whatsapp },
    { path: '/inbound-email', provider: email, maxBodyBytes: 40 * 1024 * 1024 },
  ],
})
```

## Respuestas

| Situación | Status |
| --- | --- |
| `ingest()` devuelve (o resuelve) un entero 100-599 | ese status |
| `ingest()` devuelve `{ status, body?, headers? }` | ese status; un `body` string se envía como texto, un objeto como JSON |
| `ingest()` devuelve otra cosa / nada | `200` |
| `ingest()` lanza un `SyntaxError` / otro error | `400` / `500` |
| `GET`/`HEAD` con `verifyChallenge()` → string / `null` | `200` con el challenge / `403` |
| `GET` sin `verifyChallenge()`, u otro método | `405` (con `Allow`) |
| Body demasiado grande / demasiado lento | `413` / `408` (con `Connection: close`) |
| Body ya consumido por un parser | `500` |
| El cliente abortó el body | `400` |
| Saturado, `ingest()` agotó el tiempo o cerrando | `503` + `Retry-After: 1` |

`EmailProvider.ingest()` resuelve `{ status, accepted, reason? }`, así que
se usa su `status` (`200`, `400` o `413`) tal cual.

Con `node:http`, Express y Fastify, antes de responder con
`Connection: close` (413, 503...) se descarta el resto del body sin leer para
que el cliente reciba la respuesta en lugar de un `ECONNRESET`. El drenado
está acotado (8 MiB y 5 s por defecto;
`createNodeHandler(ingress, { drain: { maxBytes, timeoutMs } })`); al
superarlo se responde igualmente y se corta el socket. Un `408` no espera al
body.

## Endpoints de salud

Ambos aceptan solo `GET` y `HEAD` (`405` en otro caso):

- **`/healthz`**: siempre `200` `{"status":"ok"}` mientras el proceso sirve.
- **`/readyz`**: `200` cuando está listo, `503` si no. El body JSON es
  `{ status: 'ready' | 'not_ready', connection?, draining? }`: `connection`
  es el estado de conexión del bot (si pasaste `bot`) y `draining` aparece
  después de `close()`.

Listo significa: no se llamó a `close()`, el `bot` (si lo hay) está en
`'ready'` y `readiness()` (si lo hay) resolvió `true`.

## El objeto `Ingress`

```ts
const ingress = createIngress({ routes, bot })

ingress.paths        // every served path (webhooks + enabled health paths)
ingress.matches(p)   // whether a path is served
ingress.inflight     // webhook requests being read or ingested
ingress.closing      // true after close()
await ingress.isReady()
await ingress.close({ timeoutMs: 10_000 }) // 503 for new webhooks, wait for in-flight ones
await ingress.handle(request)              // framework-neutral entry point used by the adapters
```

`close()` sin `timeoutMs` espera hasta que terminen todas las peticiones en
curso.

## Notas por provider

El ingress llama a `provider.ingest(rawBody, headers)`: no le pasa la URL de
la petición. Para la mayoría de providers no importa, con estos detalles:

| Provider | Configuración de la ruta |
| --- | --- |
| `CloudAPIProvider`, `MessengerProvider`, `InstagramProvider` | Por defecto (`buffer`). El handshake `GET` va a `verifyChallenge()` |
| `TelegramProvider` (`polling: false`) | `body: 'text'` |
| `EvolutionProvider`, `GoHighLevelProvider`, `TikTokProvider` | Por defecto (`buffer`) |
| `TwilioProvider` | Por defecto. Configura `webhookUrl` (la URL pública exacta que firma Twilio), o `webhookPath` detrás de un proxy propio |
| `WPPConnectProvider` | El token del webhook tiene que llegar en una cabecera (`x-webhook-token` o `Authorization: Bearer`): el token en la query string necesita `ingest(body, headers, url)`, que el ingress no llama |
| `GupshupProvider` | Igual: `ingest()` solo lee la cabecera (`x-webhook-token`); el token en la query string necesita `ingestRequest()` |
| `EmailProvider` | Por defecto, con un `maxBodyBytes` mayor |

Para WPPConnect y Gupshup con el token en la query string, monta una ruta en
tu framework y llama tú a `provider.ingest(body, headers, req.originalUrl)` /
`provider.ingestRequest({ url, body, headers })` (ver
[Canales](/es/guide/canales)).

## Exports de más bajo nivel

- `serveNode(ingress, req, res, options)`: sirve una petición de Node (lo
  usan los adaptadores).
- `serveFetch(ingress, request)`: sirve un `Request` WHATWG.
- `readNodeBody(req, limit, timeoutMs)` / `readWebBody(request, limit, timeoutMs)`:
  leen un body crudo con límite de bytes y timeout.
- `BodyTooLargeError`, `BodyTimeoutError`, `BodyUnavailableError`,
  `BodyAbortedError`: los errores con los que rechazan esos lectores.
- `normalizePath(path)`, `splitUrl(url)`: helpers de rutas.

## Ver también

- [Canales](/es/guide/canales): qué providers funcionan por webhook.
- [Despliegue](/es/guide/deploy)
- [README de `@bot-wa/server`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/server)
