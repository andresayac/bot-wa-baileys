# @botmesh/server

> **Experimental — not yet published on npm.** The package is `private`: use it from this monorepo (`workspace:*`). Its API may change.

HTTP ingress for the `@botmesh` webhook channels (WhatsApp Cloud API, Messenger, Instagram, Telegram in webhook mode, Evolution, Twilio, HighLevel, TikTok, inbound email...). The ingress calls `ingest(raw, headers)` without the URL: with WPPConnect and Gupshup the webhook token must arrive in a header, not in the query string. It solves what every webhook host has to get right and is easy to get wrong:

- **Raw body bytes**: `provider.ingest()` receives the exact `Buffer` that arrived (Meta's `X-Hub-Signature-256` signature is computed over those bytes, never over re-serialized JSON).
- **Size limit** (`413`), 1 MiB by default, checked against `Content-Length` and while the stream arrives.
- **Timeouts**: body read (`408`) and `ingest` (`503`).
- **Concurrency limit** (`503` + `Retry-After: 1` when saturated).
- **Method and path routing**: `GET` → `verifyChallenge` (Meta handshake), `POST` → `ingest(raw, headers)`; the value returned by `ingest` is the HTTP status.
- **Health**: `/healthz` (liveness, always 200) and `/readyz` (200 only when the bot is `ready`, the optional `readiness` check returns `true` and it is not shutting down).
- **No sensitive logs**: only method, path, status, sizes and the error class *name* are logged; never bodies, headers, query strings or error messages.
- **No framework dependencies**: adapters for `node:http`, Express, Fastify and Hono structurally typed, in separate subpaths.

## Usage with `node:http`

```ts
import { createServer } from 'node:http'
import { Bot } from '@botmesh/core'
import { CloudAPIProvider } from '@botmesh/meta'
import { TelegramProvider } from '@botmesh/telegram'
import { createIngress, createNodeHandler } from '@botmesh/server'

const whatsapp = new CloudAPIProvider({ /* ... */ appSecret: process.env.META_APP_SECRET! })
const bot = new Bot({ provider: whatsapp })

const ingress = createIngress({
  routes: [
    { path: '/webhook/whatsapp', provider: whatsapp },
    // TelegramProvider.ingest() parses strings: ask it for the body as text.
    // { path: '/webhook/telegram', provider: telegram, body: 'text' },
  ],
  bot,                    // /readyz = 200 only when bot.getConnectionState() === 'ready'
  maxBodyBytes: 512 * 1024,
  maxConcurrent: 32,
})

const server = createServer(createNodeHandler(ingress))
await bot.start()
server.listen(3000)

// Graceful shutdown: stop accepting webhooks, drain in-flight ones.
process.on('SIGTERM', async () => {
  await ingress.close({ timeoutMs: 10_000 })
  await bot.stop({ drain: true })
  server.close()
})
```

## Express

```ts
import express from 'express'
import { expressIngress } from '@botmesh/server/express'

const app = express()
app.use(expressIngress(ingress)) // BEFORE express.json()
app.use(express.json())          // the rest of your routes
```

If a parser already consumed the body (`express.json()` mounted first), the ingress responds `500` instead of re-serializing. Behind `express.raw()` it reuses its `Buffer` (and still applies `maxBodyBytes`).

## Fastify

```ts
import Fastify from 'fastify'
import { fastifyIngress } from '@botmesh/server/fastify'

const app = Fastify()
app.register(fastifyIngress(ingress), { prefix: '/hooks' }) // /hooks/webhook/whatsapp, /hooks/healthz...
```

It is an encapsulated plugin: its wildcard parser leaves the stream untouched only for its routes; the other routes keep Fastify's JSON parser.

## Hono / fetch

```ts
import { Hono } from 'hono'
import { honoIngress } from '@botmesh/server/hono'
import { createFetchHandler } from '@botmesh/server'

const app = new Hono()
app.use('*', honoIngress(ingress))       // routes not served → next()

const handler = createFetchHandler(ingress) // (Request) => Promise<Response>, 404 when no route
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `routes` | — | `{ path, provider, body?: 'buffer' \| 'text', maxBodyBytes? }[]` |
| `maxBodyBytes` | `1048576` | Maximum body size (`413`) |
| `bodyTimeoutMs` | `10000` | Time to receive the body (`408`) |
| `ingestTimeoutMs` | `10000` | Time for `ingest` to resolve (`503`); the concurrency slot is held until it really finishes |
| `maxConcurrent` | `64` | Webhooks being read/processed at once (`503` when saturated) |
| `healthPath` / `readyPath` | `'/healthz'` / `'/readyz'` | `false` disables them |
| `bot` | — | Any object with `getConnectionState()` (a `Bot`) |
| `readiness` | — | Extra check (`() => boolean \| Promise<boolean>`); if it throws or returns `false` → not ready |
| `logger` | silent | pino-compatible logger |

## Responses

| Situation | Status |
| --- | --- |
| `ingest` returns a number 100–599 | that number |
| `ingest` returns `{ status, body, headers }` | that status; `body` string → text, object → JSON |
| `ingest` returns anything else / nothing | `200` |
| `ingest` throws `SyntaxError` / another error | `400` / `500` |
| GET with `verifyChallenge` → string / `null` | `200` with the challenge / `403` |
| GET without `verifyChallenge`, or another method | `405` (+ `Allow`) |
| Body too large / too slow | `413` / `408` (with `Connection: close`) |
| Saturated, slow `ingest` or shutting down | `503` + `Retry-After: 1` |

With `node:http`, Express and Fastify, before responding with `Connection: close` (413, 503...) the rest of the body is discarded unread, so the client receives the response instead of an `ECONNRESET`. Draining is bounded (8 MiB and 5 s by default; `createNodeHandler(ingress, { drain: { maxBytes, timeoutMs } })`); past that it responds anyway and cuts the socket. A `408` does not wait for the body.
