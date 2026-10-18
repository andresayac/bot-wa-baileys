# 24-hour window and pricing (Cloud API)

On the WhatsApp Cloud API (`@bot-wa/meta`) a business can send **free-form**
messages (text, media, buttons...) only within **24 hours** of the user's
last message: the customer-service window. Outside it only approved
**templates** go through; Meta rejects anything else with Graph error
`131047`, which the provider maps to `OutsideSessionWindowError`.

`@bot-wa/meta` ships two optional helpers for this:

- **`sessionWindow`**: tracks each chat's window, reopens closed chats with a
  template and retries the original message when the user replies.
- **`usage`**: counts the billing info Meta attaches to status webhooks, per
  chat and per pricing category.

Both live only in `@bot-wa/meta`. Other providers with a similar window
(Twilio error `63016`, Gupshup, TikTok) reject with
`OutsideSessionWindowError` but have no manager.

## Without the manager

By default nothing is tracked. A free-form send outside the window rejects,
and you decide what to do:

```ts
import { OutsideSessionWindowError } from '@bot-wa/core'

try {
  await bot.sendTo(chatId, 'Your order shipped')
} catch (err) {
  if (!(err instanceof OutsideSessionWindowError)) throw err
  await bot.sendTo(chatId, {
    kind: 'template',
    name: 'order_update',
    language: 'en',
    components: [/* template parameters, Graph format */],
  })
}
```

Templates are always allowed: they are the way back into the window.

## Enabling the manager

```ts
import { CloudAPIProvider } from '@bot-wa/meta'

const provider = new CloudAPIProvider({
  accessToken: process.env.META_TOKEN!,
  phoneNumberId: process.env.META_PHONE_ID!,
  verifyToken: process.env.META_VERIFY_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  sessionWindow: {
    reopenTemplate: { kind: 'template', name: 'resume_conversation', language: 'en' },
    reopenTemplateByKind: {
      document: { kind: 'template', name: 'document_ready', language: 'en' },
    },
    onReport: (r) => logger.info({ chatId: r.chatId, outcome: r.outcome }, 'session window'),
  },
})
```

With `sessionWindow` set, `provider.send()` (and so `ctx.reply`,
`bot.sendTo`...) goes through a `SessionWindowManager`:

1. Every inbound **message** or **interaction** (button or list tap) records
   the chat's last inbound time. Reactions and statuses do not open the
   window.
2. A free-form send to a chat whose window is **known closed** (last inbound
   older than 24 h, or Meta reported `131047` since) skips the doomed request
   and goes straight to step 4 (`proactive`, on by default). A chat never
   seen is not treated as closed: the send is attempted.
3. If a free-form send fails with `OutsideSessionWindowError`, the window is
   marked closed.
4. The manager sends the **reopen template**, queues the original content
   and rejects (or resolves, see `onReopened`).
5. When the user replies, the queued content is sent automatically, in
   order, before any new send to that chat. Your handlers also run on that
   reply as usual.

A `failed` status webhook with code `131047` for a free-form message the
manager sent (Meta can report it asynchronously) triggers the same reopen and
queue, reported through `onReport` since `send()` already resolved.

Templates (`kind: 'template'`) bypass the manager and are always sent
directly.

### What `send()` does after reopening

- **`onReopened: 'reject'`** (default): `send()` rejects with
  `SessionWindowReopenedError`, a subclass of `OutsideSessionWindowError`
  with `template`, `queued` and `templateResult`. Code that already handles
  `OutsideSessionWindowError` keeps working.
- **`onReopened: 'resolve'`**: `send()` resolves with the template's send
  result, and `raw` is `{ queued, template, result }`. Use it when callers
  should not see an error (for example, `ctx.reply` inside handlers).

```ts
import { SessionWindowReopenedError } from '@bot-wa/meta'

try {
  await bot.sendTo(chatId, 'Your invoice is attached')
} catch (err) {
  if (err instanceof SessionWindowReopenedError) {
    // err.template went out; err.queued === true → delivered when the user replies
  } else throw err
}
```

If the reopen template itself fails, `send()` rejects (with the original
`131047` error when there was one), the outcome is `reopen-failed` and the
content is **not** queued. When no template resolves for the content, the
outcome is `no-template` and the original error is thrown.

### Choosing the template

- `reopenTemplate`: one template for any content, or a resolver
  `(ctx) => SessionTemplate | undefined` (sync or async). `ctx` has
  `chatId`, `content`, `reason` (`'error'`, `'proactive'` or `'status'`) and
  `lastInboundAt`. Return `undefined` to not reopen.
- `reopenTemplateByKind`: a template per content kind (`text`, `image`,
  `document`...); it takes precedence over `reopenTemplate`.

```ts
sessionWindow: {
  reopenTemplate: async ({ chatId }) => {
    const lang = await users.language(chatId)
    return { kind: 'template', name: 'resume_conversation', language: lang }
  },
}
```

Concurrent sends to the same closed chat share **one** template send, and
while a reopened chat waits for the reply, further sends are queued without
sending another template.

### Reports

`onReport(report)` receives every outcome (errors thrown inside it are
swallowed). `report` has `chatId`, `outcome` and, depending on the case,
`reason`, `content`, `template`, `result` and `error`.

| `outcome` | Meaning |
| --- | --- |
| `queued` | Content queued; the reopen template was sent (or already pending) |
| `reopened` | Template sent; content not queued (`retryOnReply: false`) |
| `sent` | Queued content delivered after the user replied |
| `failed` | Queued content failed again on retry |
| `expired` | Queued content older than `pendingTtlMs` when the user replied |
| `dropped` | Content discarded: the chat's queue or the chat table was full, or `clearPending()` |
| `no-template` | No template configured or resolved: nothing reopened |
| `reopen-failed` | The reopen template itself failed |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `reopenTemplate` | — | Template, or `(ctx) => template \| undefined` |
| `reopenTemplateByKind` | — | Template per content kind (wins over `reopenTemplate`) |
| `proactive` | `true` | Skip the free-form send when the window is known closed (only when a template resolves) |
| `retryOnReply` | `true` | Queue the content and retry it when the user replies |
| `onReopened` | `'reject'` | `'reject'` (throw `SessionWindowReopenedError`) or `'resolve'` |
| `onReport` | — | Outcome callback |
| `store` | `MemorySessionWindowStore` | Where window state lives |
| `windowMs` | 24 h | Window length |
| `maxPendingPerChat` | `20` | Queued sends per chat (oldest dropped) |
| `maxPendingChats` | `1000` | Chats with queued sends (oldest chat's queue dropped) |
| `pendingTtlMs` | 24 h | Queued sends older than this are discarded on reply |
| `maxTrackedSends` | `500` | Free-form sends remembered to react to async `131047` statuses (`0` disables) |
| `scope` | — | Business number of the manager; `CloudAPIProvider` sets its `phoneNumberId` |
| `now` | `Date.now` | Clock (tests) |

## Persisting the window state

Only the **window state** goes through the store: per chat,
`{ lastInboundAt?, closedAt? }` (epoch ms). The default
`MemorySessionWindowStore` is bounded (`maxChats`, default 10 000) and is
lost on restart. Implement `SessionWindowStore` over Redis or SQL to keep it
across restarts and processes; methods may be sync or async:

```ts
import type { SessionWindowStore } from '@bot-wa/meta'

const store: SessionWindowStore = {
  async get(key) {
    const raw = await redis.hGet('wa:window', key)
    return raw ? JSON.parse(raw) : undefined
  },
  async set(key, state) { await redis.hSet('wa:window', key, JSON.stringify(state)) },
  async delete(key) { await redis.hDel('wa:window', key) },
}

new CloudAPIProvider({ /* ... */ sessionWindow: { store, reopenTemplate } })
```

The **retry queue** and the tracked sends hold `OutboundContent`, so they
always stay in memory (bounded) and are lost on restart. Before handing
media to the manager, the provider uploads it once (Buffer, path or
`{ stream }`) and the queue only keeps the media id: retries never re-read a
drained stream or hold media bytes.

## Several numbers: `forScope`

The window belongs to a **business number + user** pair. The provider scopes
its manager by `phoneNumberId`, and store keys become
`<phoneNumberId>:<chatId>`, so one store can serve several numbers.

To share one manager (same options and store) between providers, pass the
instance; each provider gets its own view with `forScope(phoneNumberId)`,
with its own window keys, queue and tracked sends:

```ts
import { SessionWindowManager } from '@bot-wa/meta'

const windows = new SessionWindowManager({ store, reopenTemplate })

const sales = new CloudAPIProvider({ /* ... */ phoneNumberId: 'SALES_ID', sessionWindow: windows })
const support = new CloudAPIProvider({ /* ... */ phoneNumberId: 'SUPPORT_ID', sessionWindow: windows })

sales.sessionWindow === windows.forScope('SALES_ID') // true (memoised)
```

## Querying a chat

`provider.sessionWindow` is the manager (or `undefined` when `sessionWindow`
is not configured):

```ts
const sw = provider.sessionWindow!
await sw.state(chatId)     // 'open' | 'closed' | 'unknown'
await sw.isOpen(chatId)    // true only when known open
await sw.expiresAt(chatId) // epoch ms when the window closes, or undefined
sw.pending(chatId)         // sends queued for the chat
sw.clearPending(chatId)    // drop them (each reported as 'dropped')
```

`SESSION_WINDOW_MS` (24 h) and `SESSION_WINDOW_ERROR_CODE` (`131047`) are
exported too.

## Pricing and usage

Every Cloud API `status` event carries Meta's billing info normalized in
`DeliveryStatus.platformData`:

- `platformData.pricing`: `{ billable, pricingModel?, category?, type? }`.
  `pricingModel` is `PMP` (per-message pricing, since 2025-07-01) or `CBP`
  (legacy conversation-based); `type` (PMP) is `regular`,
  `free_customer_service` or `free_entry_point`.
- `platformData.conversation` (when Meta sends it):
  `{ id?, originType?, expiresAt? }` (`expiresAt` in epoch ms).

```ts
import { pricingOf } from '@bot-wa/meta'

bot.on('status', (status) => {
  const pricing = pricingOf(status.platformData)
  if (pricing?.billable) metrics.increment(`wa.billable.${pricing.category ?? 'unknown'}`)
})
```

`provider.usage` (a `UsageTracker`, on by default) aggregates that pricing
per chat and per category. Meta repeats the pricing on `sent`, `delivered`
and `read`; each message id is counted once.

```ts
const provider = new CloudAPIProvider({
  /* ... */
  usage: { rates: { marketing: 0.0625, utility: 0.008 } }, // price per billable message
})

provider.usage!.forChat(chatId) // { messages, billable, free, estimatedCost, byCategory } | undefined
provider.usage!.totals()        // the same, across every chat
provider.usage!.chats()         // chats with counters, least recently updated first
provider.usage!.reset(chatId)   // clear one chat (totals kept); reset() clears everything
```

| `usage` option | Default | Description |
| --- | --- | --- |
| `rates` | — | Price per billable message by category, or `(entry) => number \| undefined` (rates vary by country). Unknown → 0 |
| `maxChats` | `10000` | Chats with per-chat counters (least recently updated evicted; totals survive) |
| `maxTrackedMessages` | `10000` | Message ids remembered to count each message once |

`usage: false` disables counting (pricing still reaches `platformData`). You
can also pass your own `UsageTracker` instance, for example to share it
between providers. `estimatedCost` is only the sum of your configured
rates: Meta's invoice is the source of truth.

## See also

- [Channels](/guide/channels): all providers and their capabilities.
- [`@bot-wa/meta` README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/meta-provider)
