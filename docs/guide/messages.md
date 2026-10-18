# Messages & Media

Everything you can send and receive.

## Reply helpers (inside a handler)

All of these target `ctx.from` and return `Promise<SentMessage>`. `reply`,
`say`, `answer` and `text` are all equivalent aliases:

```ts
await ctx.reply('👋 Hello!')
await ctx.say('How are you?')          // alias
await ctx.answer('👍')                  // alias
await ctx.text('plain text')            // alias
await ctx.quote('replying to your message')     // quotes the inbound message
await ctx.replyWithTyping('typing this out...') // shows "typing…" before sending
```

## Send photo

```ts
await ctx.photo('https://picsum.photos/400/300', '📸 caption')
await ctx.photo('./photo.jpg', 'caption')  // local file
await ctx.photo(buffer, 'caption')          // Buffer
```

## Send video

```ts
await ctx.video(url, 'caption')
await ctx.video(url, 'caption', { gifPlayback: true })  // GIF
await ctx.video(url, 'caption', { ptv: true })           // circular video
```

## Send audio & voice

```ts
await ctx.audio(url)   // audio
await ctx.voice(url)   // voice note (PTT)
```

## Send file

```ts
await ctx.file(url, 'document.pdf', 'caption')
```

## Send sticker

```ts
await ctx.sticker(url, { pack: 'My Pack', author: 'me' })
```

## Send location

```ts
await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
```

## Send contact

```ts
await ctx.contact('573001234567', 'Support Bot')
```

## Buttons: normalized, degraded per transport

`ctx.buttons(text, buttons)` sends normalized button content. How it lands
depends on the provider:

- **`@bot-wa/baileys`** — native interactive buttons are dead in the
  current WhatsApp Web protocol, so buttons degrade to a **numbered text
  menu**. A numbered menu (`.choose()` in a flow, or `c.choose()` in a
  conversation — see [Flows](./flows)) or a real poll usually reads better.
- **`@bot-wa/meta`** (Cloud API) — native interactive buttons/lists/templates.
- **`@bot-wa/telegram`** — native inline keyboards.

```ts
await ctx.buttons('Choose one', [
  { id: 'a', title: 'Option A' },
  { id: 'b', title: 'Option B' },
])

// Polls are native on Baileys and Telegram. The Cloud API has no polls:
// there, ctx.poll() rejects with UnsupportedContentError — use buttons.
await ctx.poll('What do you prefer?', ['Option A', 'Option B'])

// Multi select
await ctx.poll('What do you like?', ['🍕 Pizza', '🍔 Burger'], true)
```

If a provider cannot honor a content kind at all, `send` rejects with a
typed `UnsupportedContentError` from `@bot-wa/core`.

## Typing indicator and reply delays

`BotConfig.typing` shows "typing…" before every text reply sent through `ctx`
(`reply`/`say`/`answer`/`text`/`quote` and flow `.say`). The indicator lasts
`text length / charsPerSecond`, clamped to `[minMs, maxMs]`. It is off by default.

```ts
const bot = new Bot({ provider, typing: true }) // defaults: { minMs: 800, maxMs: 3000, charsPerSecond: 20 }
const tuned = new Bot({ provider, typing: { enabled: true, minMs: 500, maxMs: 2000 } })

// Per reply: override typing and/or wait first
await ctx.reply('One moment…', { typing: false })
await ctx.reply('Here it is', { delay: '1.5s', typing: { maxMs: 1000 } })
```

- A failing indicator never fails the send; it is cosmetic and best effort.
- On providers without `capabilities.typing` there is no indicator **and no wait**. `delay` is honored everywhere.
- A paced reply is dropped (it resolves `{ skipped: true }`) if the bot stops, the chat is handed off or the flow is aborted during the wait. `stop({ drain: true })` waits for paced replies.

## Edit a message

```ts
const msg = await ctx.reply('Processing…')
await ctx.edit('Done ✅')                       // edits this context's own last reply
await ctx.edit(msg.ref, 'Done ✅')              // edits a given message
await ctx.edit('Done ✅', { fallback: 'skip' }) // never sends a new message
```

`ctx.edit(content)` only targets the last reply sent by **this same context**
(this handler run, or this flow) and only when it has the same content kind.
It never edits replies to an earlier message, replies of another participant's
flow in a group, or a reply followed by a `bot.send`/`bot.sendTo` to the chat.
The result has `edited: true` when the provider edited in place.

When the provider cannot edit (no `capabilities.edit`, a content kind it cannot
edit, or nothing to edit), `ctx.edit` sends the content as a **new message** in
the chat of the edited message (`ref.chatId`), or sends nothing with
`{ fallback: 'skip' }`. Edits run the `before`/`after('send')` hooks (the payload
carries `edit: ref`) and update the outbound ledger.

## React

```ts
await ctx.react('👍')
await ctx.react('❤️')
await ctx.react('🔥', msg.ref) // react to another message
await ctx.react('')            // remove the reaction, where the transport allows it
```

On providers that cannot send reactions, `ctx.react` resolves `{ skipped: true }`
instead of rejecting.

## Support per transport

`ctx.supports(feature)` returns `'native'`, `'degraded'` or `'unsupported'` for
`'typing'`, `'delay'`, `'edit'` and `'react'`:

| Transport | typing | delay | edit | react |
| --- | --- | --- | --- | --- |
| WhatsApp (Baileys) | native | native | degraded (new message) | native |
| WhatsApp Cloud API | unsupported | native | degraded (new message) | native |
| Messenger | native | native | degraded (new message) | unsupported (skipped) |
| Instagram | native | native | degraded (new message) | unsupported (skipped) |
| Telegram | native | native | native | native |
| Discord | native | native | native | native |

## Other actions

```ts
await ctx.markRead()   // mark the inbound message as read
await ctx.typing()     // show "typing…"
await ctx.recording()  // show "recording audio…"
await ctx.delete()     // delete the inbound message (if allowed)
```

Actions degrade to a no-op on providers that lack the capability.

## Receive media

```ts
bot.onImage(async (ctx) => { await ctx.reply('📸 Got your image!') })
bot.onAudio(async (ctx) => { await ctx.reply('🎵 Got your audio') })
bot.onVideo(async (ctx) => { await ctx.reply('🎬 Got your video') })
bot.onSticker(async (ctx) => { await ctx.reply('🎨 Got your sticker!') })
bot.onDocument(async (ctx) => { await ctx.reply('📄 Got your file') })
bot.onLocation(async (ctx) => { await ctx.reply('📍 Got your location') })
bot.onContact(async (ctx) => { await ctx.reply('👤 Got your contact') })
bot.onPoll(async (ctx) => { await ctx.reply('📊 Got your poll') })
```

`onImage`/`onAudio`/etc. are low-specificity matchers: a more specific
`bot.when(...)` that also matches wins first, unless it calls `ctx.pass()`.
The same tier is available as trigger constants (`IMAGE`, `VOICE_NOTE`,
`MEDIA`, `LOCATION`, `CALL`...): see [Special triggers](./triggers).

## Poll votes

`ctx.poll(question, options, multiSelect?)` sends a native poll. Votes
arrive on the `poll` event with the full, current tally:

```ts
await ctx.poll('Pizza or sushi?', ['Pizza', 'Sushi'])

bot.on('poll', (vote) => {
  // vote.ref.id      → the poll's message id
  // vote.ref.chatId  → the chat where it was voted (same chatId its messages use)
  // vote.senderId    → who just voted, with the canonical id of their messages
  // vote.options     → current tally: [{ name, votes, voters }]
  const picked = vote.options.filter((o) => o.voters?.includes(vote.senderId)).map((o) => o.name)
  console.log(picked.length ? `Picked: ${picked.join(', ')}` : 'Vote withdrawn')
})
```

On **Baileys**, WhatsApp encrypts every vote end to end; the provider
decrypts it itself. It remembers the 500 most recent polls it saw (the
bot's own and the ones others create in chats it listens to), only accepts
a vote that arrives in the poll's own chat and names its creator, keeps
each person's latest vote, and counts each vote message once (Baileys'
offline redelivery is not re-emitted). Limits: only polls seen by **this
process** can be decrypted (after a restart, votes on older polls are
dropped with a `debug` log), and the bot cannot vote. A poll someone else
creates still arrives as a `poll` message (`bot.onPoll`, the
[`POLL` trigger](./triggers#message-type-triggers)); the encrypted vote no
longer does. Details in the `@bot-wa/baileys` README.

## Access media content

`ctx.media` is a plain field (not a promise) present whenever the inbound
message carries media:

```ts
bot.onImage(async (ctx) => {
  if (ctx.media) {
    console.log(ctx.media.mimetype)  // 'image/jpeg'
    console.log(ctx.media.buffer)    // Buffer
    console.log(ctx.media.size)      // bytes
  }
})
```

## The full `MessageContext`

Besides the reply helpers, every handler receives data fields on `ctx`:
`ctx.body`, `ctx.from` (chat id), `ctx.sender` (user id; = `from` in DMs,
participant in groups), `ctx.senderInfo`, `ctx.pushName`, `ctx.chat`
(`{ id, kind, name?, isGroup, isBroadcast, participants? }`), `ctx.type`,
`ctx.isGroup` / `ctx.isPrivate` / `ctx.isFromMe`, `ctx.mentions`,
`ctx.quoted?`, `ctx.media?`, `ctx.timestamp`, `ctx.tools` (DI registry),
`ctx.raw` (provider-native payload), `ctx.ref` (the message reference —
`{ id, chatId, native? }`, replaces v1's `ctx.key`), `ctx.user` (the
sender's [persistent profile](./user-data)), `ctx.handoff()` (pass the chat
to a [human](./handoff)) and `ctx.call` (the `CallEvent`, on
[`CALL`](./triggers#call) contexts only).

## Identity per transport

Every provider resolves aliases before emitting, so `ctx.sender` is the
same for the same person (the identity contract):

- **Baileys:** LID and PN (phone) forms of a user are merged into one
  canonical id (the PN when known). Messages, reactions, poll votes, calls,
  group and presence events, `ctx.mentions` and the bot's own `selfId` all
  use it, so `groupMode: 'mentions'` works whether the mention used the LID
  or the PN.
- **Cloud API (`@bot-wa/meta`):** users who turned on a WhatsApp
  **username** may arrive without a phone number, only with a
  business-scoped user id (**BSUID**, e.g. `US.13491208655302741918`). The
  provider keeps one stable id per person (the phone when known, otherwise
  the BSUID), learns phone ↔ BSUID pairs (persist them with an
  `identityMap`), and sends to a BSUID through the `recipient` field
  automatically. `senderInfo.username` and
  `senderInfo.platformData.bsuid` expose the details. Authentication
  templates require a phone: sending one to a BSUID fails with Graph error
  `131062`, mapped to `UnsupportedContentError`. See the `@bot-wa/meta`
  README.

## Sending outside a handler

To message someone without waiting for them to write first — e.g. from a
[scheduled task](./scheduler) — use the bot instance directly. Content is
the transport-neutral tagged union (`{ kind, ... }`):

```ts
await bot.sendText('573001234567@s.whatsapp.net', '🌅 Good morning!')
await bot.send('573001234567@s.whatsapp.net', {
  kind: 'image',
  media: { url },
  caption: 'hi',
})
await bot.sendTo(chatId, 'Hi, I am Ana from support')  // same path; a string is sent as text
```

## Broadcasts

`bot.broadcast(chatIds, content, options?)` sends one content (a string is sent as
text) to many chats, in batches, without blocking the per-chat inbound queues:

```ts
const ac = new AbortController()
const res = await bot.broadcast(chatIds, '🎉 New promo!', {
  batchSize: 10,          // chats per batch (default 10)
  delayBetween: '2s',     // pause between batches (ms or '2s', '1m'; default 0)
  concurrency: 1,         // parallel sends per batch (default 1)
  maxRetries: 3,          // retries per chat after a RateLimitedError (default 3)
  onProgress: (done, total) => bot.logger.info(`${done}/${total}`),
  onFail: (chatId, error) => bot.logger.warn({ chatId, err: error }, 'broadcast failed'),
  signal: ac.signal,      // abort to stop early
})
// → { total, sent, failed, skipped, errors: [{ chatId, error }], messages, cancelled, pending }
```

- A `RateLimitedError` pauses **every** worker for its `retryAfterMs` and retries that chat.
- Other errors are recorded in `errors` and the broadcast goes on; it never rejects for a per-chat failure.
- Aborting `signal` or calling `bot.stop()` starts no new send; chats never attempted come back in `pending` (`cancelled: true`).
- Duplicate ids are sent once; sends skipped by a `before('send')` hook count as `skipped`.

::: warning Breaking change
`sent` and `failed` are now **counts**. The accepted sends moved to `messages` and the failures to `errors`.
:::

From inside a handler, launch it with `void bot.broadcast(...)` so that chat's queue is not held while it runs.

## Starting a flow programmatically

`bot.trigger(name, { chatId, userId?, isGroup?, data?, ifActive? })` starts a
registered flow or `bot.conversation` for someone who has not written: reminders,
webhooks, admin panels. `data` seeds `c.state`:

```ts
bot.schedule('0 9 * * *', async () => {
  for (const appt of await db.appointmentsToday()) {
    await bot.trigger('reminder', { chatId: appt.chatId, data: { time: appt.time } })
  }
})
```

It goes through the access lists, the human handoff gate and the chat's FIFO queue.
It resolves `{ started, name, chatId, userId, reason? }` as soon as the conversation is
**entered**, not when it ends. `reason` is `'stopped' | 'blocked' | 'handoff' | 'busy'`.
A subject with a live or dormant conversation is left alone unless `ifActive: 'replace'`.
It is safe to `await bot.trigger(...)` from a handler or command of the same chat: it runs in that message's queue slot.

## Runtime metrics

`bot.metrics()` returns an in-process snapshot: conversations (started, completed,
cancelled, timed out, retries exceeded, errored, active, mean duration) overall and
per flow, messages in/out, inbound drops (duplicate, blocked, handoff), triggers,
errors and uptime. `bot.resetMetrics()` zeroes the counters. `toPrometheus(snapshot, { prefix?, labels? })`
renders it in the Prometheus text format, with no dependencies:

```ts
import { toPrometheus } from '@bot-wa/core'

app.get('/metrics', (_req, res) => res.type('text/plain').send(toPrometheus(bot.metrics())))

bot.on('conversation:started', ({ id, name, chatId }) => { /* ... */ })
bot.on('conversation:ended', ({ id, name, chatId, outcome, durationMs }) => { /* ... */ })
```

`id` is unique per conversation instance, so you can pair an `ended` with its `started`.
When a conversation is replaced, its `ended` (`outcome: 'cancelled'`) is emitted before the new one's `started`.

## Next steps

- [Conversation flows](./flows) — multi-step conversations
- [Examples](/examples/media) — full media recipes
