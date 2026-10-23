# @botmesh/gupshup

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: its API may change. Use it from this monorepo (`workspace:*`).

**Gupshup WhatsApp API** transport for [`@botmesh/core`](../core): sending through `POST /wa/api/v1/msg` (and `/wa/api/v1/template/msg`) and receiving through callbacks in **v2 format**. No SDK: everything goes through [`@botmesh/http`](../http)'s `secureFetch`.

## Requirements

1. A WhatsApp app in Gupshup: **API key**, **app name** (`src.name`) and the app **number**.
2. A callback URL configured in the console with **v2 payload**, including a secret token in the query: `https://bot.example.com/gupshup?token=<secret>`.

Gupshup does **not sign** its callbacks: the provider authenticates them with that token (constant-time comparison). Gupshup also recommends restricting by IP; do both in production.

## Usage

```ts
import express from 'express'
import { Bot } from '@botmesh/core'
import { GupshupProvider } from '@botmesh/gupshup'

const provider = new GupshupProvider({
  apiKey: process.env.GUPSHUP_API_KEY!,
  appName: 'MyBotApp',
  source: '917834811114',
  webhookToken: process.env.GUPSHUP_WEBHOOK_TOKEN!,
})

const bot = new Bot({ provider })
bot.when('hello', (ctx) => ctx.buttons('What do you need?', [
  { id: 'balance', title: 'Balance' },
  { id: 'agent', title: 'Agent' },
]))
bot.when('balance', (ctx) => ctx.reply('Your balance is…'))
await bot.start()

const app = express()
app.post('/gupshup', express.raw({ type: '*/*' }), (req, res) => {
  res.sendStatus(provider.ingestRequest({ url: req.originalUrl, body: req.body, headers: req.headers }))
})
app.listen(3000)
```

- `ingestRequest` reads the token from the query (`webhookTokenParam`, `token` by default) or from the header; `ingest(body, headers)` only from the header (`webhookTokenHeader`, `x-webhook-token` by default).
- Responses: `200` accepted (also the empty validation ping), `400` invalid JSON, `401` missing or wrong token.
- `allowUnsignedWebhooks: true` disables the token (isolated local development only).

## Identity

`chatId` = `senderId` = `sender.phone` (digits with country code, no `+`), which is exactly the `destination` the send API expects. Inbound messages carry the WhatsApp id; outbound ones the Gupshup `messageId` (= `gsId` in callbacks), so statuses, reactions and quotes of bot messages link through `gsId`.

## Content

| Kind | Gupshup |
| --- | --- |
| `text` | `{ type: 'text' }` |
| `image` / `video` / `audio` / `voice` / `document` / `sticker` | `image` (`originalUrl`/`previewUrl`), `video`, `audio`, `file`, `sticker` (**public URL**) |
| `location` / `contact` | `location` / `contact` |
| `buttons` | `quick_reply` (≤ 3, `postbackText` = button `id`) → `list` (≤ 10) → numbered text |
| `list` | interactive `list` (`postbackText` = row `id`; > 10 rows → numbered text) |
| `template` | `/template/msg` with `{ id: name, params: components }` (`components` = array of strings or `{ params }`) |
| `native` (`provider: 'gupshup'`) | `message` object as-is |

`platformData` in the send options overrides form fields (e.g. `{ source: '…' }` for another number).

Inbound: text, media (`ctx.media`, expiring URL `urlExpiry`), location, contact, quotes (`quoted`), `quick_reply`/`button_reply`/`list_reply` and template buttons → interactions (the `postbackText` arrives as `ctx.body`), reactions → `reaction` event, `message-event` → `status` (`enqueued`/`deleted` are discarded; `failed` carries `code` and `reason`).

## Errors

`429` → `RateLimitedError` · "not opted in / inactive / invalid destination" → `RecipientUnreachableError` · "24 hours" → `OutsideSessionWindowError` · size → `PayloadTooLargeError` · the rest → `GupshupApiError` (`status`). A `200` response with `status: 'error'` also rejects.
