# @botmesh/evolution

[Evolution API](https://github.com/EvolutionAPI/evolution-api) v2 transport
([`IProvider` v2](../core/src/core/provider.ts)) for [@botmesh/core](../core).
Evolution is a self-hosted WhatsApp REST gateway built on Baileys:
the bot does not open the socket, it talks to your Evolution server over HTTP.

> **Private package** (alpha): not published to npm.

- **Outbound:** `POST {baseUrl}/message/<endpoint>/{instance}` with the `apikey`
  header, always through `@botmesh/http`'s `secureFetch` (no redirect following).
- **Inbound:** Evolution webhooks → `provider.ingest(body, headers)`, with
  mandatory authentication (shared secret in a header or Evolution's HS256 `jwt_key`).
- **Stable identity:** the LID/PN twins Evolution attaches
  (`remoteJidAlt`, `senderPn`, `participantAlt`, `participantPn`, `senderLid`)
  are linked inside the provider; the same person always produces the same
  `senderId`, even when a later message arrives with the LID only.
- **Content:** text, image, video, audio, voice note, document, sticker,
  location, contact, poll, reaction; `buttons`/`list`/`card` degrade to
  numbered text; `native` for any `/message/*` endpoint.
- **Actions:** media download, mark as read, typing/recording,
  delete for everyone, edit text.
- **Typed errors:** `RecipientUnreachableError` (number without WhatsApp),
  `RateLimitedError` (429 + `Retry-After`), `PayloadTooLargeError` (413),
  `UnsupportedContentError` (`template`), `ProviderError` for the rest.

## Usage

```ts
import express from 'express'
import { Bot } from '@botmesh/core'
import { EvolutionProvider } from '@botmesh/evolution'

const provider = new EvolutionProvider({
  baseUrl: 'http://localhost:8080',
  apiKey: process.env.EVOLUTION_API_KEY!,
  instance: 'my-instance',
  webhookSecret: process.env.EVOLUTION_WEBHOOK_SECRET!,
})

const bot = new Bot({ provider })
bot.when('hello', (ctx) => ctx.reply('Hello! 👋'))

const app = express()
// Raw body or JSON: ingest() accepts a string, Buffer or object.
app.post('/webhook/evolution', express.json({ limit: '25mb' }), (req, res) => {
  res.sendStatus(provider.ingest(req.body, req.headers))
})
app.listen(3000)
await bot.start() // connectionState → ready, or QR in `connection.update.authPayload`
```

Point the instance webhook at your route, with the secret in a header:

```bash
curl -X POST http://localhost:8080/webhook/set/my-instance \
  -H "apikey: $EVOLUTION_API_KEY" -H 'content-type: application/json' \
  -d '{"webhook":{"enabled":true,"url":"https://bot.example.com/webhook/evolution",
       "headers":{"x-webhook-secret":"<EVOLUTION_WEBHOOK_SECRET>"},
       "events":["MESSAGES_UPSERT","MESSAGES_UPDATE","CONNECTION_UPDATE","QRCODE_UPDATED","CALL","GROUP_PARTICIPANTS_UPDATE"]}}'
```

Alternative: put `"headers": { "jwt_key": "<key>" }` in the webhook and
`webhookJwtKey: '<key>'` in the provider; Evolution then sends
`Authorization: Bearer <JWT>` (HS256, expires after 10 min) and `ingest()` verifies
the signature, expiry and the `app: 'evolution'` / `action: 'webhook'` claims.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | — | Evolution server URL. |
| `apiKey` | — | Global key or instance token (`apikey` header). |
| `instance` | — | Instance name. |
| `webhookSecret` | — | Shared secret (`x-webhook-secret` header or `Authorization: Bearer`). |
| `webhookSecretHeader` | `x-webhook-secret` | Header carrying the secret. |
| `webhookJwtKey` | — | Evolution webhook `jwt_key`. |
| `allowUnsignedWebhooks` | `false` | Isolated local development only. Without a secret or JWT, the constructor fails. |
| `selfId` | — | Own JID; when missing, it is read from `/instance/fetchInstances` or from `connection.update`. |
| `http` | — | `allowHttp` (by default yes when `baseUrl` is `http://`), `allowPrivateHosts` (default `true`: the gateway is usually local), `timeoutMs` (30 s), `maxBytes` (64 MiB), `resolver`, `fetch`. |
| `identityCacheSize` | `10000` | Maximum size of the LID↔PN map (LRU). |
| `identityPersistence` | — | Durable LID↔PN map (synchronous `get`/`set`). Without it, the canonical id of a contact first seen with the LID only may change after a restart. |
| `convertAudioToMp4` | `false` | Ask Evolution for audio as MP4 when downloading. |

`ingest()` returns the HTTP code: `200` (accepted; also for another instance or
unknown events, so Evolution does not retry), `401` (invalid credential) or `400` (not an Evolution webhook).

## Supported events

| Webhook | Normalized event |
| --- | --- |
| `messages.upsert` | `message` (or `reaction` when it is a `reactionMessage`) |
| `messages.update` | `status` (`SERVER_ACK`→`sent`, `DELIVERY_ACK`→`delivered`, `READ`/`PLAYED`→`read`, `ERROR`→`failed`) |
| `connection.update` | `connection` (`open`→`ready`, `close` 401→`sessionInvalid`, 440→`sessionTakenOver`) |
| `qrcode.updated` | `connection` `authenticating` with the QR in `authPayload` |
| `call` | `call` |
| `group-participants.update` | `group` |

Names are accepted in any form (`MESSAGES_UPSERT`, `messages-upsert`,
`messages.upsert`, useful with `webhookByEvents`).

## Media

`ctx.media` / `provider.downloadMedia(ref)` uses the webhook base64 when the
instance has `webhookBase64: true`; otherwise it calls
`/chat/getBase64FromMediaMessage/{instance}`. It never downloads arbitrary URLs from the
payload. To send, a URL (`http(s)://` or `{ url }`) is passed to Evolution as-is
and any other `MediaSource` (Buffer, path, stream) travels as base64.

## Limitations

- Native buttons and lists are unreliable on WhatsApp Web: they are sent as numbered
text. For Evolution's own, use
`ctx.sendNative('evolution', { endpoint: 'sendButtons', body: {...} })`.
- Poll votes (`pollUpdates`) are not emitted as `poll-vote` yet.
- If a person's first message arrives with the LID only and without a twin, that LID
  stays as their canonical id for the session (the map lives in memory).
