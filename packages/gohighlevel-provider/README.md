# @botmesh/gohighlevel

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: its API may change. Use it from this monorepo (`workspace:*`).

**HighLevel (GoHighLevel / LeadConnector) Conversations API** transport for [`@botmesh/core`](../core). A bot that answers CRM contacts on the channel they used: **SMS, WhatsApp, Email, Facebook, Instagram, Live chat, GMB or a Custom provider**. Inbound through the `InboundMessage` webhook (signed with **Ed25519, `X-GHL-Signature`**), outbound through `POST /conversations/messages`.

## Requirements

1. A **Private Integration Token** (or a location OAuth token) with `conversations` and `conversations/message` (write) permissions.
2. The sub-account `locationId`.
3. A Marketplace app (or integration) subscribed to the **`InboundMessage`** webhook pointing at your server.

## Usage

```ts
import express from 'express'
import { Bot } from '@botmesh/core'
import { GoHighLevelProvider } from '@botmesh/gohighlevel'

const provider = new GoHighLevelProvider({
  accessToken: process.env.GHL_TOKEN!,
  locationId: process.env.GHL_LOCATION_ID!,
  // apiVersion: '2021-04-15',   // Version header (default)
  // defaultChannel: 'SMS',      // channel when the contact has not written yet
})

const bot = new Bot({ provider })
bot.when('hello', (ctx) => ctx.reply('Hi! Writing to you from the CRM'))
await bot.start()

const app = express()
// RAW body: the Ed25519 signature is computed over the exact bytes.
app.post('/ghl/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  res.sendStatus(provider.ingest(req.body, req.headers))
})
app.listen(3000)
```

- HighLevel's Ed25519 public key ships built in (`GHL_WEBHOOK_PUBLIC_KEY`); `publicKey` overrides it if they rotate it. The legacy RSA signature (`X-WH-Signature`, retired on 2026-09-01) is only accepted when you pass `legacyPublicKey`.
- `ingest` responses: `200` accepted (also ignored events or events from another location), `400` unreadable or already parsed body, `401` missing or invalid signature.
- `allowUnsignedWebhooks: true` disables verification (isolated local development only).

## Identity

`chatId` = `senderId` = HighLevel **`contactId`**. HighLevel already merges phone, email and social profiles into one contact, so the same person is the same chat on any channel; each message's channel is in `ctx.chat.platformData.channel` and the bot replies on the last channel used. To force another: `provider.send(contactId, content, { platformData: { type: 'Email', subject: 'Your order' } })` (the other `platformData` fields are passed as-is into the API body).

## Content

| Kind | HighLevel |
| --- | --- |
| `text` | `message` (on `Email` also escaped `html`) |
| `image` / `video` / `document` / `audio` / `voice` | `attachments: [url]` (**public URL**) + caption in `message` |
| `buttons` / `list` | numbered text menu |
| `template` | `templateId` (= `name`) |
| `native` (`provider: 'gohighlevel'`) | body fields as-is |

Inbound: messages (with attachments as `ctx.media`), `CALL` calls → `call` event. `OutboundMessage` echoes and the rest of the CRM events are ignored. `ctx.markRead()` sets `unreadCount: 0` on the conversation. `options.quoted` → `replyMessageId`.

## Errors

`429` → `RateLimitedError` · `404` or 400/422 for DND/opt-out/nonexistent contact → `RecipientUnreachableError` · `413` → `PayloadTooLargeError` · the rest → `GoHighLevelApiError` (`status`).
