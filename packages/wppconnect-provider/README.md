# @botmesh/wppconnect

[WPPConnect Server](https://github.com/wppconnect-team/wppconnect-server) transport
([`IProvider` v2](../core/src/core/provider.ts)) for [@botmesh/core](../core).
`wppconnect-server` exposes WhatsApp Web (WA-JS) as a REST API; the bot talks to
it over HTTP and receives events through webhooks.

> **Private package** (alpha): not published to npm.

- **Outbound:** `POST {baseUrl}/api/{session}/<endpoint>` with
  `Authorization: Bearer <token>`, through `@botmesh/http`'s `secureFetch` (no
  redirect following). With `secretKey`, the token is generated on `start()` and
  regenerated once after a 401 (the `secretKey` never appears in errors).
- **Inbound:** webhooks (`onmessage`, `onack`, `onreactionmessage`,
  `incomingcall`, `onparticipantschanged`, `status-find`, `qrcode`) →
  `await provider.ingest(body, headers, url)`, with a mandatory token and a
  `session` check.
- **Stable identity:** unknown LIDs are resolved to their number with
  `GET /api/{session}/contact/pn-lid/{lid}` **before** emitting (with a cache), and
  `sender.phoneNumber` also links the pair. The same person always produces the
  same `senderId`.
- **Content:** text, image, video, audio, voice note, document, sticker,
  location, contact (vCard), poll, reaction; `buttons`/`list`/`card` degrade to
  numbered text; `native` for any `/api/{session}/` endpoint.
- **Actions:** media download (`download-media`), mark chat as read
  (`send-seen`), typing/recording, delete, edit text.
- **Typed errors:** `RecipientUnreachableError`, `RateLimitedError`,
  `PayloadTooLargeError`, `UnsupportedContentError`, `ProviderError`.

## Usage

```ts
import express from 'express'
import { Bot } from '@botmesh/core'
import { WPPConnectProvider } from '@botmesh/wppconnect'

const provider = new WPPConnectProvider({
  baseUrl: 'http://localhost:21465',
  session: 'my-bot',
  secretKey: process.env.WPP_SECRET_KEY!,     // or token: '<already generated bearer>'
  webhookToken: process.env.WPP_WEBHOOK_TOKEN!,
})

const bot = new Bot({ provider })
bot.when('hello', (ctx) => ctx.reply('Hello! 👋'))

const app = express()
app.post('/webhooks/wpp', express.json({ limit: '25mb' }), async (req, res) => {
  res.sendStatus(await provider.ingest(req.body, req.headers, req.originalUrl))
})
app.listen(3000)
await bot.start() // start-session + status-session → ready, or QR in authPayload
```

`wppconnect-server` neither signs webhooks nor allows custom headers, so
the token goes in the webhook URL (server configuration):

```json
{ "webhook": { "url": "https://bot.example.com/webhooks/wpp?token=<WPP_WEBHOOK_TOKEN>" } }
```

Pass the request URL (`req.originalUrl` is enough) as the third argument of
`ingest()`. If a proxy in front rewrites it, the token is also accepted in the
`x-webhook-token` header or as `Authorization: Bearer <token>`.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `http://localhost:21465` | wppconnect-server URL. |
| `session` | — | Session name. |
| `token` / `secretKey` | — | One of the two is required. |
| `webhookToken` | — | Webhook token (`token` query, header or Bearer). |
| `webhookTokenHeader` | `x-webhook-token` | Alternative header. |
| `webhookTokenParam` | `token` | Query parameter. |
| `allowUnsignedWebhooks` | `false` | Isolated local development only. |
| `startSession` | `true` | Calls `start-session` on `start()`. |
| `webhookUrl` | — | Per-session webhook sent in `start-session` (must be in the server's `allowedUrls`). |
| `resolveLid` | `true` | Resolve LIDs with `contact/pn-lid`. |
| `maxLidLookups` | `5` | Maximum `pn-lid` lookups per webhook (in parallel). |
| `lidLookupTimeoutMs` | `5000` | Timeout of each `pn-lid` lookup. |
| `lidRetryMs` | `300000` | Wait before retrying a LID whose lookup failed. |
| `selfId` | — | Own number (`573…@c.us`); when missing it is learned from the `to` of an inbound DM. |
| `http` | — | `allowHttp`, `allowPrivateHosts` (default `true`), `timeoutMs` (30 s), `maxBytes` (64 MiB), `resolver`, `fetch`. |
| `identityCacheSize` | `10000` | Maximum size of the LID↔PN map (LRU). |
| `identityPersistence` | — | Durable LID↔PN map (synchronous `get`/`set`). Without it, the canonical id of a contact first seen with the LID only may change after a restart. |

`ingest()` resolves to the HTTP code: `200` (accepted; also for another session or
unknown events), `401` (invalid token) or `400` (not a valid webhook).

## Notes

- Message ids are the WA-JS serialized ones
  (`false_573…@c.us_3EB0…`): they are the ones accepted by `send-reply`, `react-message`,
  `delete-message` and `download-media`.
- `markRead` marks the **whole chat** (`send-seen`); WhatsApp Web has no
  per-message read receipts.
- For WPPConnect buttons/lists use
  `ctx.sendNative('wppconnect', { endpoint: 'send-list-message', body: {...} })`.
