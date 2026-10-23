# @botmesh/messenger

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`); the `pnpm add` below will work once it is published.

**Facebook Messenger (Meta's official Send API)** transport for [`@botmesh/core`](../core). Sibling of `@botmesh/meta` (WhatsApp Cloud API): same Graph family — **webhook with the `hub.challenge` handshake + `X-Hub-Signature-256` signature** and an **HTTP Send API** (`POST /{page-id}/messages`). It opens no socket.

## Install

```bash
pnpm add @botmesh/core @botmesh/messenger
```

**No extra dependencies** — it uses Node ≥ 22 native `fetch` and `crypto`.

## Requirements (Meta)

1. An app at [developers.facebook.com](https://developers.facebook.com) with the **Messenger** product and a connected Facebook Page.
2. A **Page Access Token** with `pages_messaging` (generated in the app's Messenger section).
3. Configure the Page **webhook** pointing at your server: subscribe the `messages` field with a `verify_token` you choose and, recommended, the app's `app_secret`.

## Usage

```ts
import { Bot } from '@botmesh/core'
import { MessengerProvider } from '@botmesh/messenger'
import express from 'express'

const provider = new MessengerProvider({
  accessToken: process.env.MESSENGER_TOKEN!,
  verifyToken: 'my-verify-secret',               // the one you set in Meta
  appSecret: process.env.META_APP_SECRET!,       // required: verifies X-Hub-Signature-256
  pageId: 'me',                                  // or the Page's numeric id
})

const bot = new Bot({ provider })
bot.when('hello', (ctx) => ctx.reply('👋 Hello from Messenger!'))
await bot.start()

// ——— YOUR server serves the webhook ———
const app = express()
app.get('/webhook', (req, res) => {
  const challenge = provider.verifyChallenge(req.query as never)
  challenge ? res.send(challenge) : res.sendStatus(403)
})
app.post('/webhook', express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }), (req, res) => {
  res.sendStatus(provider.ingest((req as any).rawBody ?? req.body, req.headers))
})
app.listen(3000)
```

> **Webhook signature:** `appSecret` is mandatory in production; `ingest` validates `X-Hub-Signature-256`
> (constant-time HMAC-SHA256) and rejects forged bodies with `403`.
> Pass it the **raw body** (not the already parsed one) so the signature computes the same.
> For local development only, `allowUnsignedWebhooks: true` can be used explicitly.

## Configuration

| Field | Default | Description |
|---|---|---|
| `accessToken` | — | Page Access Token (`pages_messaging`). |
| `verifyToken` | — | Webhook GET handshake secret. |
| `appSecret` | Yes | Verifies `X-Hub-Signature-256` on every POST. |
| `apiVersion` | `v21.0` | Graph API version. |
| `graphUrl` | `https://graph.facebook.com` | Graph base URL. |
| `pageId` | `me` | Page id (or `me`). |
| `selfId` | — | The bot's PSID (for `fromMe`). |

## What it supports

| Feature | Messenger |
|---|---|
| Text, image, video, audio, document (by public URL) | ✅ |
| **Postback buttons** (`ctx.buttons`, `button` template, max 3; a button with `url` is `web_url`) | ✅ native |
| **Cards** (`card` with image or buttons → `generic` template; without them, text) | ✅ native |
| **Lists** (`generic` template, one element per row) | ✅ native |
| Inbound quick replies / postbacks → interactions (`kind: 'button'`) | ✅ |
| Inbound location (`type: 'location'`) and quoted replies (`quoted`) | ✅ |
| Inbound reactions (`message.reaction` → `reaction` event) | ✅ |
| Typing (`typing_on`/`typing_off`) and read receipt (`mark_seen`) | ✅ |
| Inbound media download (`MediaRef.token` is the attachment URL) | ✅ |
| Polls, stickers, location, contact, templates, sending reactions | ❌ (`UnsupportedContentError` — no Send API endpoint) |
| Groups, presence, editing/deleting messages | ❌ (does not exist in the API) |

## Documented limitations

- **Media by public URL only.** The Send API refers to attachments by URL (`is_reusable: true`); this provider does **not** implement chunked upload. Pass `MediaSource` as a URL (`'https://…'` or `{ url }`) — a `Buffer`/path/stream throws `UnsupportedContentError` with the note.
- **Quotes/replies (`quoted`) are ignored:** the Send API has no first-class reply context.
- **Outbound reactions:** there is no public endpoint — `kind: 'reaction'` throws `UnsupportedContentError`. Inbound ones are normalized.
- `acknowledgeInteraction` is a no-op: Messenger postbacks need no ack.
- **Identity:** `chatId`/`senderId` are the PSID (`sender.id`) — stable per page↔user pair.

## Errors

Graph errors (`res.error`) map to `@botmesh/core` types: rate-limit codes **4/613** → `RateLimitedError` (honouring `Retry-After`); outside the 24 h window (code 10, subcode 2018278) → `OutsideSessionWindowError`; recipient unavailable or nonexistent (code 551, subcodes 1545041/2018001) → `RecipientUnreachableError`, both with the `chatId`; the rest → `ProviderError`.
