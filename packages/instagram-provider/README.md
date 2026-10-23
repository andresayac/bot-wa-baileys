# @botmesh/instagram

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: it is not part of the first alpha and its API may change. Use it from this monorepo (`workspace:*`); the `pnpm add` below will work once it is published.

**Instagram DM (Messenger API for Instagram, Meta's official API)** transport for [`@botmesh/core`](../core). It is webhook-based (it opens no socket): messages arrive at the `page` object webhook of the connected Facebook Page and sends use the Graph Send API (`me/messages`).

## Install

```bash
pnpm add @botmesh/core @botmesh/instagram
```

**No extra dependencies** — it uses Node ≥ 22 native `fetch` and `crypto`.

## Requirements (Meta)

1. A **professional Instagram account** (business or creator) **connected to a Facebook Page** — DMs are routed through that Page.
2. An app at [developers.facebook.com](https://developers.facebook.com) with the **Messenger** product, the Instagram account connected (Messenger API for Instagram) and the `instagram_basic`, `instagram_manage_messages` and `pages_manage_metadata` permissions.
3. A **Page access token** for the connected Page.
4. Configure a **webhook** on the `page` object with the `messages`, `messaging_postback`, `message_reactions` and `message_echoes` fields, pointing at your server (with a `verify_token` you choose and, recommended, the app's `app_secret`).

## Usage

```ts
import { Bot } from '@botmesh/core'
import { InstagramProvider } from '@botmesh/instagram'
import express from 'express'

const provider = new InstagramProvider({
  accessToken: process.env.META_PAGE_TOKEN!,      // token of the connected Page
  verifyToken: 'my-verify-secret',                // the one you set in Meta
  appSecret: process.env.META_APP_SECRET!,        // required: verifies X-Hub-Signature-256
  selfId: process.env.IG_ACCOUNT_ID,              // optional: IGSID of the IG account
})

const bot = new Bot({ provider })
bot.when('hello', (ctx) => ctx.reply('👋 Hello from Instagram!'))
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

## What it supports

| Feature | Instagram DM |
|---|---|
| Text | ✅ |
| Image, video, audio, document | ✅ **public URL only** (the IG Send API does not accept buffers/paths) |
| **Buttons** (`ctx.buttons`) | ✅ as **quick replies** (title ≤20) |
| Quick reply / postback click → interaction (`kind: 'button'`) | ✅ |
| Lists | ⚠️ degraded to numbered text (IG has no lists) |
| **Inbound** reactions (IG DM reactions) | ✅ (`kind: 'reaction'`) |
| Typing (`ctx.typing`) and read receipts (`mark_seen`) | ✅ (sender_action) |
| Card (`card`) | ✅ as text (its buttons, as quick replies) |
| Sending reactions / polls / location / contact / sticker / templates | ❌ (`UnsupportedContentError`) |
| Groups, presence, editing/deleting messages | ❌ (does not exist in the API) |

## Identity

`chatId`/`senderId` are the sender's **IGSID** (Instagram-Scoped User ID) — stable and opaque. The bot's own messages arrive as `message.is_echo` and are discarded (they are not emitted as events).

## Notes

- **Media by URL only:** upload files to public hosting and pass the URL (`ctx.photo('https://…/photo.jpg')`). A `Buffer`, path or stream throws `UnsupportedContentError`.
- `ctx.buttons` is sent as quick replies: tappable chips below the message; the tap arrives as an interaction with `data` = the button `id`.
- Outside the messaging window, Meta may require the user to interact first (IG platform policy); Graph errors are translated to `@botmesh/core` typed errors (`RateLimitedError` on codes 4/613; `OutsideSessionWindowError` outside the window, subcode 2534022; `RecipientUnreachableError` when the user does not exist or is unavailable, code 551 or subcodes 2018001/2534014).
- A message the user unsends (`is_deleted`) is not emitted as a new message.
