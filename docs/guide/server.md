# Webhook server (`@bot-wa/server`)

Webhook providers (WhatsApp Cloud API, Messenger, Instagram, Telegram in
webhook mode, Evolution, Twilio, TikTok...) do not open a connection: the
channel POSTs events to **your** HTTP server, and you hand each request to
`provider.ingest()`. `@bot-wa/server` is that HTTP layer, done right:

- **Raw body bytes**: `ingest()` gets the exact `Buffer` that arrived.
  Signatures such as Meta's `X-Hub-Signature-256` are computed over those
  bytes, never over re-serialized JSON.
- **Size limit** (`413`), 1 MiB by default, checked against
  `Content-Length` and while the stream arrives.
- **Timeouts** for reading the body (`408`) and for `ingest()` (`503`).
- **Concurrency limit** (`503` + `Retry-After: 1` when saturated).
- **Routing**: `GET` → `verifyChallenge()` (Meta's handshake), `POST` →
  `ingest(raw, headers)`. The value `ingest()` returns is the HTTP status.
- **Health endpoints**: `/healthz` (liveness) and `/readyz` (readiness).
- **No sensitive logs**: only method, path, status, sizes and the error
  class name; never bodies, headers, query strings or error messages.
- **No framework dependencies**: adapters for `node:http`, Express, Fastify,
  Hono and fetch-style runtimes, typed structurally.

> `@bot-wa/server` is **experimental**: the package is `private`, not
> published to npm. Use it from this monorepo (`"workspace:*"`).

Socket providers (Baileys, Discord, Telegram in polling mode, Email over
IMAP) need no ingress.

## With `node:http`

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

`createNodeHandler(ingress, options)` answers `404` for paths it does not
serve; pass `onNotFound: (req, res) => ...` to chain another handler
instead.

## Express

```ts
import express from 'express'
import { expressIngress } from '@bot-wa/server/express'

const app = express()
app.use(expressIngress(ingress)) // BEFORE express.json()
app.use(express.json())          // the rest of your routes
```

Paths not served by the ingress fall through to `next()`. Paths are matched
against `req.url`, so they are relative to where the middleware is mounted.
If a body parser already consumed the body (`express.json()` mounted
earlier), the ingress answers `500` instead of re-serializing. Behind
`express.raw()` it reuses that `Buffer` (and still applies `maxBodyBytes`).

## Fastify

```ts
import Fastify from 'fastify'
import { fastifyIngress } from '@bot-wa/server/fastify'

const app = Fastify()
app.register(fastifyIngress(ingress), { prefix: '/hooks' }) // /hooks/webhook/whatsapp, /hooks/healthz...
```

It is an encapsulated plugin: its catch-all content-type parser leaves the
stream untouched only for its own routes; your other routes keep Fastify's
JSON parser.

## Hono and fetch runtimes

```ts
import { Hono } from 'hono'
import { honoIngress } from '@bot-wa/server/hono'
import { createFetchHandler } from '@bot-wa/server'

const app = new Hono()
app.use('*', honoIngress(ingress)) // unserved paths → next()

const handler = createFetchHandler(ingress) // (Request) => Promise<Response>, 404 when no route matches
```

`serveFetch(ingress, request)` is the lower-level variant: it resolves
`undefined` when no route matches, so you can fall through. The Hono adapter
needs `Buffer` (Node, Bun, Deno, Workers with `nodejs_compat`).

## Options

`createIngress(options)`:

| Option | Default | Description |
| --- | --- | --- |
| `routes` | — | `{ path, provider, body?: 'buffer' \| 'text', maxBodyBytes? }[]` |
| `maxBodyBytes` | `1048576` (1 MiB) | Max request body (`413`) |
| `bodyTimeoutMs` | `10000` | Time to receive the whole body (`408`) |
| `ingestTimeoutMs` | `10000` | Time for `ingest()` to settle (`503`); the concurrency slot is held until it really settles |
| `maxConcurrent` | `64` | Webhook requests being read or ingested at once (`503` beyond it) |
| `healthPath` | `'/healthz'` | Liveness path; `false` disables it |
| `readyPath` | `'/readyz'` | Readiness path; `false` disables it |
| `bot` | — | Any object with `getConnectionState()` (a `Bot`): readiness requires `'ready'` |
| `readiness` | — | Extra check, `() => boolean \| Promise<boolean>`; throwing or `false` → not ready |
| `logger` | silent | pino-compatible logger (metadata only) |

Route rules: `path` must start with `/`, a trailing slash is ignored, and
duplicate paths (or a webhook path equal to a health path) throw a
`TypeError`. A route whose provider has no `ingest()` method also throws.

The defaults are exported as `DEFAULT_MAX_BODY_BYTES`,
`DEFAULT_BODY_TIMEOUT_MS`, `DEFAULT_INGEST_TIMEOUT_MS` and
`DEFAULT_MAX_CONCURRENT`.

### `body: 'buffer'` or `'text'`

`ingest()` receives the raw body as a `Buffer` (default) or as a UTF-8
string with `body: 'text'`. Use `'text'` for `TelegramProvider`, whose
`ingest()` parses strings or objects but not buffers.

### Per-route size limit

Raise `maxBodyBytes` on the routes that need it, for example raw MIME for
`EmailProvider.ingest()`:

```ts
createIngress({
  routes: [
    { path: '/webhook/whatsapp', provider: whatsapp },
    { path: '/inbound-email', provider: email, maxBodyBytes: 40 * 1024 * 1024 },
  ],
})
```

## Responses

| Situation | Status |
| --- | --- |
| `ingest()` returns (or resolves to) an integer 100-599 | that status |
| `ingest()` returns `{ status, body?, headers? }` | that status; a string `body` is sent as text, an object as JSON |
| `ingest()` returns anything else / nothing | `200` |
| `ingest()` throws a `SyntaxError` / another error | `400` / `500` |
| `GET`/`HEAD` with `verifyChallenge()` → string / `null` | `200` with the challenge / `403` |
| `GET` without `verifyChallenge()`, or another method | `405` (with `Allow`) |
| Body too large / too slow | `413` / `408` (with `Connection: close`) |
| Body already consumed by a parser | `500` |
| Client aborted the body | `400` |
| Saturated, `ingest()` timed out, or shutting down | `503` + `Retry-After: 1` |

`EmailProvider.ingest()` resolves `{ status, accepted, reason? }`, so its
`status` (`200`, `400` or `413`) is used as is.

With `node:http`, Express and Fastify, before answering with
`Connection: close` (413, 503...) the rest of the unread body is discarded so
the client gets the response instead of an `ECONNRESET`. Draining is bounded
(8 MiB and 5 s by default;
`createNodeHandler(ingress, { drain: { maxBytes, timeoutMs } })`); past the
bounds the response is still written and the socket is reset. A `408` does
not wait for the body.

## Health endpoints

Both accept `GET` and `HEAD` only (`405` otherwise):

- **`/healthz`**: always `200` `{"status":"ok"}` while the process serves.
- **`/readyz`**: `200` when ready, `503` otherwise. The JSON body is
  `{ status: 'ready' | 'not_ready', connection?, draining? }`: `connection`
  is the bot's connection state (when `bot` is set) and `draining` appears
  after `close()`.

Ready means: `close()` has not been called, the `bot` (if any) is
`'ready'`, and `readiness()` (if any) resolved `true`.

## The `Ingress` object

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

`close()` without `timeoutMs` waits until every in-flight request settles.

## Provider notes

The ingress calls `provider.ingest(rawBody, headers)`: it does not pass the
request URL. That is fine for most providers, with these details:

| Provider | Route setup |
| --- | --- |
| `CloudAPIProvider`, `MessengerProvider`, `InstagramProvider` | Default (`buffer`). The `GET` handshake goes to `verifyChallenge()` |
| `TelegramProvider` (`polling: false`) | `body: 'text'` |
| `EvolutionProvider`, `GoHighLevelProvider`, `TikTokProvider` | Default (`buffer`) |
| `TwilioProvider` | Default. Configure `webhookUrl` (the exact public URL Twilio signs), or `webhookPath` behind a proxy you control |
| `WPPConnectProvider` | The webhook token must arrive in a header (`x-webhook-token` or `Authorization: Bearer`): the query-string token needs `ingest(body, headers, url)`, which the ingress does not call |
| `GupshupProvider` | Same: `ingest()` only reads the header (`x-webhook-token`); the query-string token needs `ingestRequest()` |
| `EmailProvider` | Default, with a larger `maxBodyBytes` |

For WPPConnect and Gupshup with a query-string token, mount a route in your
framework and call `provider.ingest(body, headers, req.originalUrl)` /
`provider.ingestRequest({ url, body, headers })` yourself (see
[Channels](/guide/channels)).

## Lower-level exports

- `serveNode(ingress, req, res, options)`: serve one Node request (used by
  the adapters).
- `serveFetch(ingress, request)`: serve a WHATWG `Request`.
- `readNodeBody(req, limit, timeoutMs)` / `readWebBody(request, limit, timeoutMs)`:
  read a raw body with a byte limit and a timeout.
- `BodyTooLargeError`, `BodyTimeoutError`, `BodyUnavailableError`,
  `BodyAbortedError`: the errors those readers reject with.
- `normalizePath(path)`, `splitUrl(url)`: path helpers.

## See also

- [Channels](/guide/channels): which providers are webhook-based.
- [Deployment](/guide/deploy)
- [`@bot-wa/server` README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/server)
