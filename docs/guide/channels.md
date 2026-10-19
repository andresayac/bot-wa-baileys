# Channels (providers)

The bot engine (`@bot-wa/core`) does not know about any transport. A
**provider** connects it to one channel: it receives the channel's events,
turns them into neutral `InboundEvent`s and sends `OutboundContent` back. The
same flows, triggers and plugins run on every channel; only the constructor
changes.

```ts
import { Bot } from '@bot-wa/core'

const bot = new Bot({ provider }) // any provider below
```

This page lists every provider in the repository, how each one receives
events, and what it can and cannot do.

## Status: public vs experimental

| Package | Directory | Status | Transport |
| --- | --- | --- | --- |
| `@bot-wa/baileys` | `baileys-provider` | Public | WhatsApp Web (Baileys socket) |
| `@bot-wa/meta` | `meta-provider` | Public | WhatsApp Cloud API (official) |
| `@bot-wa/telegram` | `telegram-provider` | Public | Telegram Bot API |
| `@bot-wa/messenger` | `messenger-provider` | Experimental | Facebook Messenger (Send API) |
| `@bot-wa/instagram` | `instagram-provider` | Experimental | Instagram DMs (Messenger API for Instagram) |
| `@bot-wa/discord` | `discord-provider` | Experimental | Discord (gateway + REST) |
| `@bot-wa/evolution` | `evolution-provider` | Experimental | Evolution API v2 (self-hosted WhatsApp gateway) |
| `@bot-wa/wppconnect` | `wppconnect-provider` | Experimental | WPPConnect Server (self-hosted WhatsApp gateway) |
| `@bot-wa/twilio` | `twilio-provider` | Experimental | Twilio Programmable Messaging (WhatsApp + SMS/MMS) |
| `@bot-wa/gohighlevel` | `gohighlevel-provider` | Experimental | HighLevel (LeadConnector) Conversations API |
| `@bot-wa/gupshup` | `gupshup-provider` | Experimental | Gupshup WhatsApp API |
| `@bot-wa/email` | `email-provider` | Experimental | Email (IMAP IDLE + SMTP) |
| `@bot-wa/tiktok` | `tiktok-provider` | Experimental | TikTok API for Business (comments + Business Messaging) |

**Public** packages are installed with `pnpm add`. **Experimental** packages
have `"private": true` in their `package.json`: they are implemented and
tested, but they are **not published to npm** and their API may change. Use
them from this monorepo (`"workspace:*"`).

## Choosing a channel

**WhatsApp** has several options:

- **`@bot-wa/baileys`**: links the bot as a WhatsApp Web device (QR or
  pairing code) and opens its own socket. No public server or webhook,
  groups and polls work, no per-message cost. It is an **unofficial**
  client: automating an account can break WhatsApp's terms and get the
  number banned. Keep the [rate limiter](/guide/rate-limiting) on.
- **`@bot-wa/meta`**: the official WhatsApp Cloud API. Native buttons,
  lists, templates and [WhatsApp Flows forms](/guide/forms), no ban risk.
  Needs a public HTTPS webhook, has no groups, and free-form messages only
  work inside the [24-hour customer-service window](/guide/session-window).
- **`@bot-wa/evolution`** / **`@bot-wa/wppconnect`**: you already run an
  Evolution API or WPPConnect Server. The bot talks to that gateway over
  REST and receives its webhooks. Both gateways drive WhatsApp Web, so the
  same caveats as Baileys apply (unofficial, no reliable native buttons).
- **`@bot-wa/twilio`** / **`@bot-wa/gupshup`**: you send WhatsApp through
  that provider's account. Templates are supported; Twilio also covers
  SMS/MMS with the same class.
- **`@bot-wa/gohighlevel`**: the bot answers HighLevel CRM contacts on the
  channel they used (SMS, WhatsApp, Email, Facebook, Instagram, Live chat...).

**Other channels:** `@bot-wa/telegram` (long polling by default, webhook
optional), `@bot-wa/discord` (gateway socket), `@bot-wa/messenger` and
`@bot-wa/instagram` (Meta webhooks), `@bot-wa/email` (each email thread is a
chat) and `@bot-wa/tiktok` (comments on your own videos and DMs).

### Socket, polling or webhook

- **Socket / polling** (the provider opens the connection): Baileys,
  Discord, Telegram in polling mode, Email (IMAP IDLE). Nothing to expose to
  the internet.
- **Webhook** (`capabilities.pushIngress: true`): Cloud API, Messenger,
  Instagram, Telegram in webhook mode, Evolution, WPPConnect, Twilio,
  HighLevel, Gupshup, TikTok. **Your** HTTP server receives the POST and
  hands the **raw body** plus the headers to `provider.ingest()`, which
  verifies the signature or token and returns the HTTP status to answer.
  [`@bot-wa/server`](/guide/server) does that wiring (raw body, size limits,
  timeouts, health endpoints) for `node:http`, Express, Fastify and Hono.

The constructor of every webhook provider (Telegram only in webhook mode)
**throws** when its webhook credential (app secret, auth token or shared
token) is missing, unless you pass `allowUnsignedWebhooks: true`, which is
meant only for isolated local development. HighLevel is the exception: its
signing public key is bundled.

## Capability matrix

Values come from each provider's `capabilities` declaration. A feature
marked "no" is **degraded, not broken**: buttons and lists become a numbered
text menu, `ctx.edit` sends a new message, `ctx.react` resolves
`{ skipped: true }`, `ctx.typing` is a no-op (see
[Messages & media](/guide/messages#support-per-transport)).

| Provider | Ingress | Buttons | Lists | Polls | Send reactions | Edit | Typing | Read receipts | Groups | Templates | `ctx.stream` | Forms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baileys | socket | no | no | yes | yes | no | yes | yes | yes | no | chunks | field by field |
| Cloud API (`meta`) | webhook | yes | yes | no | yes | no | no | yes | no | yes | chunks | native (WhatsApp Flows) |
| Telegram | polling or webhook | yes | no (inline keyboard) | yes | yes | yes | yes | no | yes | no | draft | field by field |
| Messenger | webhook | yes | yes | no | no | no | yes | yes | no | no | chunks | field by field |
| Instagram | webhook | yes (quick replies) | no | no | no | no | yes | yes | no | no | chunks | field by field |
| Discord | socket | yes | yes | yes | yes | yes | yes | no | yes | no | edit | field by field |
| Evolution | webhook | no | no | yes | yes | yes | yes | yes | yes | no | chunks | field by field |
| WPPConnect | webhook | no | no | yes | yes | yes | yes | yes | yes | no | chunks | field by field |
| Twilio | webhook | no | no | no | no | no | yes (WhatsApp only) | no | no | yes | chunks | field by field |
| HighLevel | webhook | no | no | no | no | no | no | yes | no | yes | chunks | field by field |
| Gupshup | webhook | yes | yes | no | no | no | no | no | no | yes | chunks | field by field |
| Email | IMAP IDLE (or `ingest()`) | no | no | no | no | no | no | no | no | no | chunks | field by field |
| TikTok | webhook | yes (1 to 3, DMs; more → numbered text) | yes (up to 3 rows, DMs; more → numbered text) | no | no | no | yes (DMs) | yes (DMs) | no | no | chunks | field by field |

- **Send reactions** only describes sending. Several providers still
  receive reactions as `reaction` events (Messenger, Instagram, Gupshup,
  TikTok...).
- **`ctx.stream`**: `draft` = native draft previews then one final message
  (Telegram private chats; edits elsewhere), `edit` = one message edited as
  the text grows, `chunks` = no live preview, sentence-sized messages with
  typing (`streaming: 'none'`). See [Streaming replies](/guide/streaming).
- **Forms**: `native` sends `flow().form()` as a WhatsApp Flow;
  `field by field` asks each field with text messages.
- **`textFormat`** (not a column): the text markup the channel renders, so
  Markdown producers such as `@bot-wa/ai` can convert it. `'whatsapp'`
  (`*bold*`, `_italic_`, `~strike~`): Baileys, Cloud API, Evolution,
  WPPConnect, Gupshup. `'plain'` (no markup): Telegram (sent without
  `parse_mode`), Messenger, Instagram, TikTok. `'markdown'`: Discord. Not
  declared: Email. Providers that serve several channels decide per chat with
  the optional `textFormatFor(chatId)`, which wins over `capabilities.textFormat`
  and reaches handlers as `ctx.textFormat`: Twilio returns `'whatsapp'` for
  `whatsapp:` chats and `'plain'` for SMS; HighLevel follows the contact's
  reply channel (`'whatsapp'` for WhatsApp, `'plain'` for SMS, Email, FB, IG,
  Live chat, GMB and custom).
- **Templates** is the `template` content kind: Cloud API templates, Twilio
  Content Templates (`ContentSid`), HighLevel `templateId`, Gupshup templates.
  Other providers reject it with `UnsupportedContentError`.
- Every provider except Baileys accepts the `native` content kind
  (`ctx.sendNative('<provider id>', payload)`) as an escape hatch to the
  channel's own API, with a provider-specific payload. Baileys rejects it
  with `UnsupportedContentError`.

## Providers

### `@bot-wa/baileys`

WhatsApp Web through [Baileys](https://github.com/WhiskeySockets/Baileys).
Links with a QR code (or `pairingCode`) and keeps the session in
`sessionsDir`.

```ts
import { BaileysProvider } from '@bot-wa/baileys'

const provider = new BaileysProvider({ session: 'my-bot' })
```

- Socket owned by the provider, with reconnection and backoff.
- LID and phone-number forms of a user are merged into one stable
  `senderId`.
- No native buttons or lists (WhatsApp Web dropped them): use `choose()`
  menus or `ctx.poll()`.
- Anti-ban send rate limiting is on by default (`rateLimit`).

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/baileys-provider)

### `@bot-wa/meta` (WhatsApp Cloud API)

The official API. Webhook-based: GET handshake with `verifyChallenge()`,
POST events with `ingest()`.

```ts
import { CloudAPIProvider } from '@bot-wa/meta'

const provider = new CloudAPIProvider({
  accessToken: process.env.META_TOKEN!,        // system-user token
  phoneNumberId: process.env.META_PHONE_ID!,
  verifyToken: process.env.META_VERIFY_TOKEN!, // the one you set in Meta
  appSecret: process.env.META_APP_SECRET!,     // verifies X-Hub-Signature-256
})
```

- Native reply buttons (max 3), lists, templates and WhatsApp Flows forms.
- Users with a WhatsApp username may arrive with a BSUID instead of a phone
  number; the provider keeps one stable id per person (`identityMap`).
- Outside the 24 h window free-form sends reject with
  `OutsideSessionWindowError`. The optional `sessionWindow` manager reopens
  the chat with a template and retries: see
  [24-hour window and pricing](/guide/session-window).
- No groups, typing or polls in the API; `deleteMessage` is a no-op.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/meta-provider)

### `@bot-wa/telegram`

Telegram Bot API. Long polling by default; `polling: false` switches to
webhook mode, where `webhookSecret` is required.

```ts
import { TelegramProvider } from '@bot-wa/telegram'

const provider = new TelegramProvider({ token: process.env.TELEGRAM_TOKEN! })

// Webhook mode: the same secret goes to setWebhook (secret_token)
const hooked = new TelegramProvider({
  token: process.env.TELEGRAM_TOKEN!,
  polling: false,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
})
```

- Inline keyboards, native polls, reactions, message edits.
- `ctx.stream()` uses native drafts in private chats and edits elsewhere.
- In webhook mode `ingest()` parses a JSON **string** (or an object): with
  `@bot-wa/server` mount it with `body: 'text'`.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/telegram-provider)

### `@bot-wa/messenger` (experimental)

Facebook Messenger through the Graph Send API, with the same webhook
verification as the Cloud API.

```ts
import { MessengerProvider } from '@bot-wa/messenger'

const provider = new MessengerProvider({
  accessToken: process.env.FB_PAGE_TOKEN!, // Page access token (pages_messaging)
  verifyToken: process.env.META_VERIFY_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
})
```

- Buttons and lists are native; reactions arrive but cannot be sent.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/messenger-provider)

### `@bot-wa/instagram` (experimental)

Instagram DMs of a professional account connected to a Facebook Page
(Messenger API for Instagram).

```ts
import { InstagramProvider } from '@bot-wa/instagram'

const provider = new InstagramProvider({
  accessToken: process.env.FB_PAGE_TOKEN!, // token of the connected Page
  verifyToken: process.env.META_VERIFY_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
})
```

- Buttons go out as quick replies; lists degrade to numbered text.
- DMs only (no groups); reactions arrive but cannot be sent.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/instagram-provider)

### `@bot-wa/discord` (experimental)

Discord gateway (WebSocket) for events plus REST for sending.

```ts
import { DiscordProvider, GatewayIntents } from '@bot-wa/discord'

const provider = new DiscordProvider({ token: process.env.DISCORD_TOKEN! })
// Default intents: Guilds | GuildMessages | MessageContent.
// Add GatewayIntents.DirectMessages to the `intents` bitmask to receive DMs.
```

- Buttons, select menus, polls, reactions and edits are native;
  `ctx.stream()` edits one message as the text grows.
- Interactions have a hard acknowledgement deadline
  (`interactionsRequireAck`).

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/discord-provider)

### `@bot-wa/evolution` (experimental)

[Evolution API](https://github.com/EvolutionAPI/evolution-api) v2, a
self-hosted WhatsApp REST gateway built on Baileys. Outbound: REST with the
`apikey` header. Inbound: the instance webhook, authenticated with a shared
secret header or Evolution's `jwt_key` (HS256 JWT).

```ts
import { EvolutionProvider } from '@bot-wa/evolution'

const provider = new EvolutionProvider({
  baseUrl: 'http://localhost:8080',
  apiKey: process.env.EVOLUTION_API_KEY!,
  instance: 'my-instance',
  webhookSecret: process.env.EVOLUTION_WEBHOOK_SECRET!, // or webhookJwtKey
})
// POST /webhook/evolution → res.sendStatus(provider.ingest(body, headers))
```

- `start()` checks the instance; when it is not paired, the QR or pairing
  code arrives in the `connection` update (`authPayload`).
- LID/PN twins sent by Evolution are reconciled before emitting; pass
  `identityPersistence` to keep ids stable across restarts.
- Polls, reactions, edits (text), typing and read receipts; buttons, lists
  and cards degrade to numbered text; `template` is rejected.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/evolution-provider)

### `@bot-wa/wppconnect` (experimental)

[WPPConnect Server](https://github.com/wppconnect-team/wppconnect-server),
a self-hosted gateway on WhatsApp Web (WA-JS). REST with a Bearer token;
webhooks authenticated with a token in the webhook URL.

```ts
import { WPPConnectProvider } from '@bot-wa/wppconnect'

const provider = new WPPConnectProvider({
  baseUrl: 'http://localhost:21465',
  session: 'my-bot',
  secretKey: process.env.WPP_SECRET_KEY!,       // or token: '<generated bearer>'
  webhookToken: process.env.WPP_WEBHOOK_TOKEN!, // webhook URL: …/webhooks/wpp?token=<it>
})
// POST /webhooks/wpp → res.sendStatus(await provider.ingest(body, headers, req.originalUrl))
```

- `ingest()` is **async** and takes the request URL as third argument,
  because wppconnect-server cannot add headers: the token travels in the
  query string.
- Unknown LIDs are resolved to phone numbers (`contact/pn-lid`) before
  emitting.
- `markRead` marks the whole chat as seen; buttons and lists degrade to
  numbered text.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/wppconnect-provider)

### `@bot-wa/twilio` (experimental)

Twilio Programmable Messaging: **WhatsApp and SMS/MMS** with one class.
Webhooks verified with `X-Twilio-Signature`, which covers the exact public
URL.

```ts
import { TwilioProvider } from '@bot-wa/twilio'

const provider = new TwilioProvider({
  accountSid: process.env.TWILIO_SID!,
  authToken: process.env.TWILIO_TOKEN!,           // signs webhooks + REST auth
  whatsappFrom: 'whatsapp:+14155238886',
  smsFrom: '+15017122661',
  webhookUrl: 'https://bot.example.com/twilio/webhook', // EXACT URL set in Twilio
})
```

- `chatId` is Twilio's `From` as is (`whatsapp:+57…` or `+57…`): the same
  person on WhatsApp and SMS is two chats.
- Text up to 1600 characters; media only from public URLs; buttons and
  lists become numbered text; `template` maps to `ContentSid` +
  `ContentVariables`.
- `ingestRequest({ url, body, headers })` for per-request URLs
  (multi-tenant).
- Error 63016 maps to `OutsideSessionWindowError`.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/twilio-provider)

### `@bot-wa/gohighlevel` (experimental)

HighLevel (GoHighLevel / LeadConnector) Conversations API. Inbound through
the `InboundMessage` webhook (Ed25519 `X-GHL-Signature`), outbound with
`POST /conversations/messages` on the channel the contact last used.

```ts
import { GoHighLevelProvider } from '@bot-wa/gohighlevel'

const provider = new GoHighLevelProvider({
  accessToken: process.env.GHL_TOKEN!,         // Private Integration Token
  locationId: process.env.GHL_LOCATION_ID!,
  // defaultChannel: 'SMS',                    // until the contact writes
})
```

- `chatId` = HighLevel `contactId`: one chat per contact across channels;
  the channel of each message is in `ctx.chat.platformData.channel`.
- HighLevel's public key is bundled (`GHL_WEBHOOK_PUBLIC_KEY`), so no
  webhook secret is needed. `ingest()` needs the **raw** body.
- Media only from public URLs; `template` maps to `templateId`.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/gohighlevel-provider)

### `@bot-wa/gupshup` (experimental)

Gupshup WhatsApp API: v1 send endpoints, v2 callbacks. Gupshup does not sign
callbacks, so they are authenticated with a shared token in the callback URL
(or a header).

```ts
import { GupshupProvider } from '@bot-wa/gupshup'

const provider = new GupshupProvider({
  apiKey: process.env.GUPSHUP_API_KEY!,
  appName: 'MyBotApp',
  source: '917834811114',                          // the app's number
  webhookToken: process.env.GUPSHUP_WEBHOOK_TOKEN!, // callback: …/gupshup?token=<it>
})
// POST /gupshup → res.sendStatus(provider.ingestRequest({ url: req.originalUrl, body, headers }))
```

- Buttons go out as quick replies (up to 3), then as a list (up to 10),
  then as numbered text; lists are native up to 10 rows.
- `chatId` = the sender's phone digits (no `+`), exactly what the send API
  expects.
- Media only from public URLs. Gupshup also documents IP allow-listing: do
  both in production.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/gupshup-provider)

### `@bot-wa/email` (experimental)

Email: **IMAP IDLE** to receive and **SMTP** to reply. Each email thread is
a chat, so `ask()` flows continue when the customer replies to the email.
`imapflow` and `nodemailer` are optional peer dependencies loaded lazily.

```ts
import { EmailProvider } from '@bot-wa/email'

const provider = new EmailProvider({
  address: 'support@acme.com',
  imap: { host: 'imap.example.com', user: 'support@acme.com', pass: process.env.IMAP_PASS! },
  smtp: { host: 'smtp.example.com', user: 'support@acme.com', pass: process.env.SMTP_PASS! },
})
```

- `threading: 'thread'` (default, one chat per thread) or `'sender'` (one
  chat per address); persist threads with `threadStore: cursorThreadStore(store)`.
  That store also keeps the mailbox UID cursor, so after a restart the bot
  resumes after the last message it processed and never redelivers mail
  (even with `markSeen: false`).
- Loop protection against auto-replies and mailing lists, bounce handling
  (`status: 'failed'` events, suppression of hard-bounced addresses).
- `From` is not authenticated by email itself: use
  `requireAuthentication: { authservId }` to accept only mail your MTA
  authenticated.
- Without IMAP, `ingest(rawMime)` accepts raw MIME from an inbound-mail
  webhook and resolves `{ status, accepted, reason? }`.

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/email-provider)

### `@bot-wa/tiktok` (experimental)

TikTok API for Business (v1.3): **comments** on the account's own videos and
**direct messages** (Business Messaging API, approval required). Webhooks
verified with `TikTok-Signature`.

```ts
import { TikTokProvider } from '@bot-wa/tiktok'

const provider = new TikTokProvider({
  accessToken: process.env.TIKTOK_TOKEN!,             // or an async refresh function
  businessId: process.env.TIKTOK_BUSINESS_ID!,        // open_id of the account
  appSecret: process.env.TIKTOK_APP_SECRET!,          // verifies TikTok-Signature
  selfUniqueIdentifier: process.env.TIKTOK_SELF_UID!, // required to receive comments
})
```

- Chats: `dm:<conversation_id>` (DM), `comment:<video_id>:<comment_id>`
  (comment thread, a group chat) and `hic:<comment_id>` (high-intent
  comment). `ctx.chat.platformData.surface` tells them apart.
- DMs: text (up to 6000 characters), images, Q&A cards for buttons (1 to
  3); comments: text replies up to 150 characters. Buttons or lists a Q&A
  card cannot hold (more than 3 options, URL buttons, titles over 40
  characters) and menus sent to a comment thread degrade to a numbered text
  menu, as on Baileys.
- The bot cannot start a conversation, and TikTok limits messages per 48 h
  window (`OutsideSessionWindowError`).

[README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/tiktok-provider)

## Next steps

- [Webhook server](/guide/server): mount webhook providers with
  `@bot-wa/server`.
- [24-hour window and pricing](/guide/session-window): Cloud API session
  window and usage tracking.
- [Messages & media](/guide/messages): what each helper does on each
  transport.
