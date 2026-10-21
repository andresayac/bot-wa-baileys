# @bot-wa/meta

The **official WhatsApp Cloud API (Meta)** transport for [`@bot-wa/core`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/core). Unlike Baileys (WhatsApp Web, unofficial), the Cloud API is **official: no ban risk**, with **native buttons, lists and templates**. It is webhook-based (it opens no socket).

## Installation

```bash
pnpm add @bot-wa/core @bot-wa/meta
```

**No extra dependencies** — it uses Node ≥ 22's native `fetch` and `crypto`.

## Requirements (Meta)

1. An app on [developers.facebook.com](https://developers.facebook.com) with the **WhatsApp** product.
2. A **permanent access token** (system user) with `whatsapp_business_messaging`.
3. The **phone number id** of your sender number.
4. A **webhook** pointing at your server (with a `verify_token` you choose and, recommended, the app's `app_secret`).

## Usage

```ts
import { Bot } from '@bot-wa/core'
import { CloudAPIProvider } from '@bot-wa/meta'
import express from 'express'

const provider = new CloudAPIProvider({
  accessToken: process.env.META_TOKEN!,
  phoneNumberId: process.env.META_PHONE_ID!,
  verifyToken: 'my-verify-secret',                 // the one you set in Meta
  appSecret: process.env.META_APP_SECRET!,         // required: verifies X-Hub-Signature-256
})

const bot = new Bot({ provider })
bot.when('hola', (ctx) => ctx.reply('👋 Hello from the official API!'))
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

> **Webhook signature:** `appSecret` is required in production; `ingest` validates `X-Hub-Signature-256`
> (constant-time HMAC-SHA256) and rejects forged bodies with `403`.
> Pass it the **raw body** (not the parsed one) so the signature matches.
> Only for local development can you opt in explicitly with `allowUnsignedWebhooks: true`.
> A body that is not a JSON object is answered with `400` (it never throws).

## What it supports

| Feature | Cloud API |
|---|---|
| Text, image, video, audio, document, sticker, location, contact | ✅ (when you upload a `Buffer`, the MIME type comes from the document's `mimetype`, the extension, the bytes or the content type; never `application/octet-stream` for image, audio, video or sticker) |
| **Reply buttons** (`ctx.buttons`, max 3) | ✅ native |
| **Lists** (list `OutboundContent`) | ✅ native |
| **Templates** (kind `template`, e.g. outside the 24h window) | ✅ |
| Reactions, read receipts | ✅ |
| Users with a WhatsApp **username** (BSUID): receive and send | ✅ (see [Usernames and BSUID](#usernames-and-bsuid)) |
| Button/list clicks → interactions (`type: 'buttons'` + `ctx.acknowledge`) | ✅ |
| Quick-reply buttons of **templates** (`type: 'button'`) → interaction with the `payload` | ✅ |
| Replies quoting a message → `ctx.quoted.ref.id` (the quoted `wamid`) | ✅ |
| **Forms** (`flow().form()` → static WhatsApp Flows) | ✅ native (see [WhatsApp Flows](#whatsapp-flows-forms)) |
| Polls | ❌ (Graph 131051 — use buttons or WhatsApp Flows) |
| Groups, typing/presence, editing/deleting messages | ❌ (does not exist in the API) |

## WhatsApp Flows (forms)

The core's `flow().form(definition)` is sent here as a native **WhatsApp Flow** (`capabilities.forms === 'native'`). The provider compiles the definition into a static single-screen Flow JSON (`navigate`, no endpoint, no encryption) and the answer (`nfm_reply`) comes back as a `'form'` message that the step stores, validated, in `c.state`.

A Flow must exist in Meta before it can be sent:

```ts
const provider = new CloudAPIProvider({ ...cfg, wabaId: process.env.WABA_ID, flows: { signup: '1234567890' } })
// or create it once from the bot (Flows API, token with whatsapp_business_management):
const { flowId } = await provider.publishForm(signup, { categories: ['SIGN_UP'] })   // keep flowId for config.flows
// or export the JSON to paste it into WhatsApp Manager:
writeFileSync('signup.flow.json', JSON.stringify(toFlowJson(signup), null, 2))
```

If a form has no associated Flow (neither `config.flows` nor `.form(def, { nativeId })`), the step asks field by field like on any other channel. `flowJsonWarnings(def)` warns about labels WhatsApp will truncate. The button (`cta`) and the message body follow the user's `ctx.lang` (`core.form.*` catalogue); the submit label stays fixed in the published Flow, so pick its language with `toFlowJson(def, { lang: 'en' })` / `publishForm(def, { flowJson: { lang: 'en' } })` (default `'es'`) or define `submitLabel`. Flows with an endpoint (`data_exchange`, encrypted dynamic screens) are not supported yet.

## 24-hour window

Outside the 24 hours since the user's last message, Meta only allows **templates**. A free-form send throws `OutsideSessionWindowError` (code 131047) — answer with a `kind: 'template'`.

With `sessionWindow` the provider handles it on its own: it stores the time of the last inbound message of each chat, and when a free-form send fails with 131047 (or the window is already known to be closed) it sends an approved template to reopen the conversation, queues the original message and retries it when the user replies.

```ts
const provider = new CloudAPIProvider({
  /* ... */
  sessionWindow: {
    reopenTemplate: { kind: 'template', name: 'reopen_conversation', language: 'en' },
    reopenTemplateByKind: { document: { kind: 'template', name: 'document_ready', language: 'en' } },
    onReport: (r) => logger.info({ chatId: r.chatId, outcome: r.outcome }, 'session window'),
    // store: myRedisStore,          // SessionWindowStore (in memory and bounded by default)
    // onReopened: 'resolve',        // 'reject' by default → SessionWindowReopenedError
  },
})
await provider.sessionWindow!.isOpen('573001112233')
```

`send()` rejects with `SessionWindowReopenedError` (a subclass of `OutsideSessionWindowError`) when it reopens and queues; with `onReopened: 'resolve'` it returns the template send's result. The retry queue lives in memory and is bounded (`maxPendingPerChat`, `maxPendingChats`, `pendingTtlMs`); before handing it the content, the provider uploads the media once (buffer, path or `{ stream }`) and the queue only keeps the media id, so retries neither re-read an already-consumed stream nor retain bytes. The window is per business number + user: store keys carry the `phoneNumberId` as a prefix (`<phoneNumberId>:<chatId>`) and a `SessionWindowManager` shared by several providers gives each number its own view (`manager.forScope(phoneNumberId)`), with its own window, queue and sends. If the template itself fails (`reopen-failed`), `send()` rejects and the message is **not** queued. Concurrent sends to a closed chat share a single template, and a late 131047 for a message sent before the user's last reply does not close the window (the message is forwarded right away).

## Pricing

Every `status` event carries the normalized webhook `pricing` object in `platformData.pricing` (`billable`, `pricingModel` `PMP`/`CBP`, `category`, `type` — `regular`, `free_customer_service`, `free_entry_point`) and, when present, `platformData.conversation`. `provider.usage` aggregates per chat and per category (each message counts once):

```ts
const provider = new CloudAPIProvider({ /* ... */, usage: { rates: { marketing: 0.0125, utility: 0.0008 } } })
provider.usage!.forChat('573001112233') // { messages, billable, free, estimatedCost, byCategory }
provider.usage!.totals()
```

## Identity

`chatId`/`senderId` are the `wa_id` (E.164 phone without `+`) when known and, otherwise, the user's **BSUID** (see below). There is no LID/PN duality as in Baileys, but the phone can be missing: the provider resolves it before emitting the event so the same person always keeps the same id.

## Usernames and BSUID

Since April 2026 the Cloud API also identifies every user with a **BSUID** (*business-scoped user ID*): an id of your business portfolio shaped `US.13491208655302741918` (ISO country code + `.` + up to 128 alphanumerics). Linked portfolios also get a **parent BSUID** (`US.ENT.11815799212886844830`).

If a user enables a WhatsApp **username**, Meta **omits their phone** (`messages[].from`, `contacts[].wa_id`, `statuses[].recipient_id`) unless you wrote to or called them in the last 30 days or have them in your *contact book*. In that case the webhook only carries the BSUID (`from_user_id`, `contacts[].user_id`, `recipient_user_id`).

### How the id is chosen

For every message, interaction, reaction or delivery status:

1. If this session (the process lifetime) already emitted an id for that BSUID, parent BSUID or phone, it is **reused**.
2. Otherwise the **phone** when the webhook brings it.
3. Otherwise the phone **learned earlier** for that BSUID (via `identityMap`).
4. Otherwise the **BSUID**.

The provider learns the phone ↔ BSUID pair from any webhook that carries both (messages + `contacts`, delivery statuses). Consequences:

- A user first seen with a phone and later only with a BSUID **keeps the phone-based id**.
- A user first seen only with a BSUID who later shares their phone **keeps the BSUID for the session** (the ongoing conversation is not broken); the pair is stored, so the next session uses the phone.
- Delivery statuses (`sent`/`delivered`/`read`/`failed`) are resolved with the same rules, so they arrive with the same `chatId` as the conversation.
- If Meta changes the BSUID (`user_id_update` webhook) or the user changes number (`user_changed_number` / `user_changed_user_id` system message), the new ids are linked to the session id.
- An item with no usable id (or with malformed ids) is **dropped and logged** with `logger.warn` (no personal data); an event with an empty id is never emitted.

`senderInfo` keeps the available identity data:

| Field | Content |
|---|---|
| `senderInfo.username` | WhatsApp username, if the user enabled one |
| `senderInfo.platformData.phoneNumber` | phone (from the webhook or learned), if known |
| `senderInfo.platformData.bsuid` | BSUID |
| `senderInfo.platformData.parentBsuid` | parent BSUID, if any |
| `senderInfo.platformData.username` | username (same as above) |

### Sending to a BSUID

Nothing special to do: if the `chatId` is a BSUID (or a parent BSUID), the provider sends with the `recipient` field instead of `to`; if it is a phone, it keeps using `to`. `ctx.reply()` works the same with username users. You can check it with `isBsuid(chatId)`.

> *One-tap*, *zero-tap* and *copy code* authentication templates require a phone; sending them to a BSUID fails with Graph error `131062`.

### Persisting the phone ↔ BSUID pairs (`identityMap`)

By default the pairs are kept in an in-memory `MemoryIdentityMap` (LRU of 10,000 entries) and **are lost on restart**: after a restart, a user arriving only with a BSUID would get an id different from the phone they used before. To avoid it, pass your own `identityMap`. The interface is minimal and accepts synchronous or asynchronous methods:

```ts
interface IdentityMap {
  get(bsuid: string): string | undefined | Promise<string | undefined>  // → phone (wa_id)
  set(bsuid: string, phone: string): void | Promise<void>
}
```

With Redis (asynchronous):

```ts
import { CloudAPIProvider } from '@bot-wa/meta'

const provider = new CloudAPIProvider({
  // ...accessToken, phoneNumberId, verifyToken, appSecret
  identityMap: {
    get: async (bsuid) => (await redis.hGet('wa:bsuid', bsuid)) ?? undefined,
    set: async (bsuid, phone) => { await redis.hSet('wa:bsuid', bsuid, phone) },
  },
})
```

Or synchronous, preloading from your database and writing in the background:

```ts
import { CloudAPIProvider, MemoryIdentityMap } from '@bot-wa/meta'

const memory = new MemoryIdentityMap({ maxEntries: 100_000, entries: await db.loadBsuidPairs() })
const provider = new CloudAPIProvider({
  // ...
  identityMap: {
    get: (bsuid) => memory.get(bsuid),
    set: (bsuid, phone) => { memory.set(bsuid, phone); void db.saveBsuidPair(bsuid, phone) },
  },
})
```

Details:

- With a synchronous map, `ingest()` emits the events right away. With an asynchronous one, `ingest()` still returns `200` immediately and the events are emitted when the lookup finishes, **always in webhook order**. `stop()` waits for that queue to drain.
- `get` is only queried for users that arrive without a phone and that the session does not know yet; `set` is called once per pair and session (make it idempotent).
- If `get` fails, the event is emitted with the BSUID and the error is logged; if `set` fails, it is only logged.
- `parseInbound(body)` (exported) is **stateless**: it resolves the identity inside that body. Continuity between webhooks is provided by `provider.ingest()`.
