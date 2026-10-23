# @botmesh/twilio

> **Experimental — not yet published on npm.** Real, tested implementation, but the package is `private`: its API may change. Use it from this monorepo (`workspace:*`).

**Twilio Programmable Messaging** transport for [`@botmesh/core`](../core): **WhatsApp and SMS/MMS** with the same class. Inbound webhook verified with **`X-Twilio-Signature`** (HMAC-SHA1 over the exact URL + the sorted POST parameters) and sending through the REST API (`POST /2010-04-01/Accounts/{sid}/Messages.json`). It opens no socket.

No Twilio SDK: every request goes through [`@botmesh/http`](../http)'s `secureFetch` (timeouts, size limits, anti-SSRF).

## Usage

```ts
import express from 'express'
import { Bot } from '@botmesh/core'
import { TwilioProvider } from '@botmesh/twilio'

const provider = new TwilioProvider({
  accountSid: process.env.TWILIO_SID!,
  authToken: process.env.TWILIO_TOKEN!,            // signs webhooks and authenticates the REST API
  whatsappFrom: 'whatsapp:+14155238886',           // sender for whatsapp:+… chats
  smsFrom: '+15017122661',                         // sender for SMS (+…) chats
  webhookUrl: 'https://bot.example.com/twilio/webhook', // EXACT, as configured in the console
  statusCallback: 'https://bot.example.com/twilio/webhook', // optional: delivery receipts
})

const bot = new Bot({ provider })
bot.when('hello', (ctx) => ctx.reply('Hello from Twilio!'))
await bot.start()

const app = express()
// RAW body: the signature covers the parameters exactly as Twilio sent them.
app.post('/twilio/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const status = provider.ingest(req.body, req.headers)
  res.status(status).type('text/xml').send('<Response/>')
})
app.listen(3000)
```

- **Signature URL:** `webhookUrl` is used. If the URL changes per request (multi-tenant), use `provider.ingestRequest({ url, body, headers })` with the full URL Twilio called. Alternative: `webhookPath` + the `X-Forwarded-Proto/Host` headers (only behind your own proxy). Variants with and without the default port are accepted, as the SDKs do.
- **JSON webhooks** (`bodySHA256` in the query) are verified too.
- `allowUnsignedWebhooks: true` disables verification (isolated local development only).

## Identity

`chatId` = `senderId` = Twilio's `From` as-is: `whatsapp:+573001112233` on WhatsApp, `+573001112233` on SMS. The same person on WhatsApp and SMS is **two different chats** (different channels). The reply goes out from the number that received the message (accounts with several numbers), otherwise from `whatsappFrom`/`smsFrom`, and otherwise from `messagingServiceSid`.

## Content

| Kind | Twilio |
| --- | --- |
| `text` | `Body` (max 1600 characters → local `PayloadTooLargeError`) |
| `image` / `video` / `document` / `audio` / `voice` / `sticker` | `MediaUrl` (**public URL**; Buffer/path → `UnsupportedContentError`) |
| `location` | `PersistentAction: geo:lat,lng\|label` |
| `buttons` / `list` | numbered text menu (Twilio's interactive ones require Content Templates) |
| `template` | `ContentSid` (= `name`) + `ContentVariables` (= `components`) |
| `native` (`provider: 'twilio'`) | Messages API parameters as-is |

Inbound: text, media (`ctx.media` through `downloadMedia`, with Basic auth only towards `api.twilio.com`; a message with several attachments arrives as one message per attachment, see below), location, quoted replies (`quoted`), quick replies (`ButtonPayload` → `button` interaction) and list pickers (`ListId` → `list`). Status callbacks arrive as `status` events (`undelivered` → `failed` with `error.code`).

**Several attachments.** Twilio sends all attachments of a message in a single webhook (`NumMedia` > 1, `MediaUrl0..N-1`, at most 10). The provider emits **one `InboundMessage` per attachment**, in order, so each has its own `ctx.media`:

- the first keeps `ref.id` = `MessageSid` and the text (`Body`);
- attachment `i` carries `ref.id` = `` `${MessageSid}:${i}` `` and an empty body;
- all share chat, sender and `raw` (the webhook parameters).

Ids are unique per attachment and repeat on a webhook retry, so the core dedupe discards retries without losing attachments. Note: each attachment goes through the dispatcher as its own message, so an `ask()` waiting for an image consumes only the first one.

`ctx.typing()` uses the WhatsApp typing indicator (`POST /v3/Indicators/Typing.json` with `{ "channel": "WHATSAPP", "messageId": "SM…" }`, in public beta; it also marks the message as read and is removed on reply or after 25 s). It is only sent in WhatsApp chats with an inbound message (`SM…`/`MM…`) from the last 24 h; on SMS it is a no-op. It is *best-effort*: it never rejects. If Twilio responds 4xx (e.g. a sender or account without support), it is logged at `debug` and the chat stops trying for 30 min; 429/5xx/network errors are only logged.

WhatsApp users identified by a business-scoped user ID (BSUID, e.g. `From=whatsapp:CO.2132056440717202`, `WaId=CO.2132056440717202`) work like number-based ones: that `From` is the stable `chatId`/`senderId` and is used as-is for `To` when replying.

## Errors

`429`/`20429`/`63018` → `RateLimitedError` · `21211`/`21610`/`21614`… → `RecipientUnreachableError` · `63016` → `OutsideSessionWindowError` · `21617`/`11751` → `PayloadTooLargeError` · the rest → `TwilioApiError` (`status`, `code`, `moreInfo`).
