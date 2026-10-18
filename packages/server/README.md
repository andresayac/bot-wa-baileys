# @bot-wa/server

> **Experimental — aún no publicado en npm.** El paquete es `private`: úsalo desde este monorepo (`workspace:*`). Su API puede cambiar.

Ingress HTTP para los canales por webhook de `@bot-wa` (WhatsApp Cloud API, Messenger, Instagram, Telegram en modo webhook). Resuelve lo que todo host de webhooks tiene que hacer bien y que es fácil hacer mal:

- **Bytes crudos del body**: `provider.ingest()` recibe el `Buffer` exacto que llegó (la firma `X-Hub-Signature-256` de Meta se calcula sobre esos bytes, nunca sobre JSON re-serializado).
- **Límite de tamaño** (`413`), por defecto 1 MiB, comprobado contra `Content-Length` y mientras llega el stream.
- **Timeouts**: lectura del body (`408`) e `ingest` (`503`).
- **Límite de concurrencia** (`503` + `Retry-After: 1` cuando está saturado).
- **Enrutado por método y ruta**: `GET` → `verifyChallenge` (handshake de Meta), `POST` → `ingest(raw, headers)`; el valor que devuelve `ingest` es el status HTTP.
- **Health**: `/healthz` (liveness, siempre 200) y `/readyz` (200 solo cuando el bot está `ready` y no se está cerrando).
- **Sin logs sensibles**: solo se registran método, ruta, status, tamaños y el *nombre* de la clase de error; nunca bodies, cabeceras, query strings ni mensajes de error.
- **Sin dependencias de frameworks**: adaptadores para `node:http`, Express, Fastify y Hono tipados estructuralmente, en subpaths separados.

## Uso con `node:http`

```ts
import { createServer } from 'node:http'
import { Bot } from '@bot-wa/core'
import { CloudAPIProvider } from '@bot-wa/meta'
import { TelegramProvider } from '@bot-wa/telegram'
import { createIngress, createNodeHandler } from '@bot-wa/server'

const whatsapp = new CloudAPIProvider({ /* ... */ appSecret: process.env.META_APP_SECRET! })
const bot = new Bot({ provider: whatsapp })

const ingress = createIngress({
  routes: [
    { path: '/webhook/whatsapp', provider: whatsapp },
    // TelegramProvider.ingest() parsea strings: pídele el body como texto.
    // { path: '/webhook/telegram', provider: telegram, body: 'text' },
  ],
  bot,                    // /readyz = 200 solo con bot.getConnectionState() === 'ready'
  maxBodyBytes: 512 * 1024,
  maxConcurrent: 32,
})

const server = createServer(createNodeHandler(ingress))
await bot.start()
server.listen(3000)

// Apagado ordenado: deja de aceptar webhooks, drena los que están en curso.
process.on('SIGTERM', async () => {
  await ingress.close({ timeoutMs: 10_000 })
  await bot.stop({ drain: true })
  server.close()
})
```

## Express

```ts
import express from 'express'
import { expressIngress } from '@bot-wa/server/express'

const app = express()
app.use(expressIngress(ingress)) // ANTES de express.json()
app.use(express.json())          // el resto de tus rutas
```

Si un parser ya consumió el body (`express.json()` montado antes), el ingress responde `500` en lugar de re-serializar. Detrás de `express.raw()` reutiliza su `Buffer` (y sigue aplicando `maxBodyBytes`).

## Fastify

```ts
import Fastify from 'fastify'
import { fastifyIngress } from '@bot-wa/server/fastify'

const app = Fastify()
app.register(fastifyIngress(ingress), { prefix: '/hooks' }) // /hooks/webhook/whatsapp, /hooks/healthz...
```

Es un plugin encapsulado: su parser comodín deja el stream intacto solo para sus rutas; las demás rutas conservan el parser JSON de Fastify.

## Hono / fetch

```ts
import { Hono } from 'hono'
import { honoIngress } from '@bot-wa/server/hono'
import { createFetchHandler } from '@bot-wa/server'

const app = new Hono()
app.use('*', honoIngress(ingress))       // rutas no servidas → next()

const handler = createFetchHandler(ingress) // (Request) => Promise<Response>, 404 si no hay ruta
```

## Opciones

| Opción | Por defecto | Descripción |
| --- | --- | --- |
| `routes` | — | `{ path, provider, body?: 'buffer' \| 'text', maxBodyBytes? }[]` |
| `maxBodyBytes` | `1048576` | Tamaño máximo del body (`413`) |
| `bodyTimeoutMs` | `10000` | Tiempo para recibir el body (`408`) |
| `ingestTimeoutMs` | `10000` | Tiempo para que `ingest` resuelva (`503`); el hueco de concurrencia se mantiene hasta que de verdad termine |
| `maxConcurrent` | `64` | Webhooks leyéndose/procesándose a la vez (`503` al saturar) |
| `healthPath` / `readyPath` | `'/healthz'` / `'/readyz'` | `false` los desactiva |
| `bot` | — | Cualquier objeto con `getConnectionState()` (un `Bot`) |
| `readiness` | — | Check extra (`() => boolean \| Promise<boolean>`); si lanza o da `false` → no listo |
| `logger` | silencioso | Logger compatible con pino |

## Respuestas

| Situación | Status |
| --- | --- |
| `ingest` devuelve un número 100–599 | ese número |
| `ingest` devuelve `{ status, body, headers }` | ese status; `body` string → texto, objeto → JSON |
| `ingest` devuelve otra cosa / nada | `200` |
| `ingest` lanza `SyntaxError` / otro error | `400` / `500` |
| GET con `verifyChallenge` → string / `null` | `200` con el challenge / `403` |
| GET sin `verifyChallenge`, u otro método | `405` (+ `Allow`) |
| Body demasiado grande / lento | `413` / `408` (con `Connection: close`) |
| Saturado, `ingest` lento o cerrando | `503` + `Retry-After: 1` |

Con `node:http`, Express y Fastify, antes de responder con `Connection: close` (413, 503...) se descarta el resto del body sin leer, para que el cliente reciba la respuesta en vez de un `ECONNRESET`. El drenado está acotado (por defecto 8 MiB y 5 s; `createNodeHandler(ingress, { drain: { maxBytes, timeoutMs } })`); al superarlo se responde igualmente y se corta el socket. Un `408` no espera al body.
