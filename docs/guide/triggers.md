# Special triggers: WELCOME, message types and CALL

Besides text, regex and predicate triggers, `@bot-wa/core` exports trigger
constants for a subject's **first contact**, for **message types** (images,
voice notes, locations...) and for **incoming calls**. They work everywhere
a trigger is accepted: `bot.when()`, `flow()` / `addKeyword()` (including
`.scope()`), `bot.conversation(name, fn, { trigger })` and `bot.use()`.

```ts
import {
  Bot, flow, addKeyword, typeTrigger,
  WELCOME, MEDIA, IMAGE, VIDEO, AUDIO, VOICE_NOTE, DOCUMENT, STICKER,
  LOCATION, CONTACT, POLL, CALL,
} from '@bot-wa/core'
```

## WELCOME

`WELCOME` fires on a subject's **first interaction** with the bot:

```ts
bot.when(WELCOME, async (ctx) => {
  await ctx.reply('🙌 Welcome! Type "menu" to see the options.')
})

// As an onboarding flow (add .id('onboarding') if you make it .persistent())
bot.use(addKeyword(WELCOME).ask('What is your name?', 'name').say((_, c) => `Hi ${c.state.name}!`))

// Greet AND let the same message continue to the other triggers
bot.when(WELCOME, async (ctx) => { await ctx.reply('Hi! 👋'); ctx.pass() })
```

- **Scope:** per chat in a DM and per participant in a group (each member
  gets their own welcome), regardless of `conversationScope`. A DM and a
  group count as separate first contacts. Limit it to DMs with
  `flow(WELCOME).scope('dm')` or `{ ...WELCOME, scope: 'dm' }`.
- **What counts as first contact:** the first message that reaches the
  matcher stage. A command (`/help`), an active conversation, a dormant
  checkpoint resume, a `before` hook that aborts or the `groupMode` filter
  do not spend the welcome.
- **Precedence:** `WELCOME` runs before every other matcher, text triggers
  included. If the first message is "menu", `WELCOME` handles it; call
  `ctx.pass()` so `bot.when('menu')` also gets it.
- **Persistence:** stored through the store's cursor key/value (every
  bundled store supports it), so it survives restarts with a persistent
  store (`MemoryStore` with `file`, SQLite, Redis, Postgres, MySQL or
  Mongo). Keys are hashes (`welcome:<sha256>`), with no ids or phone
  numbers in clear text. A custom `IStore` without cursors falls back to an
  in-process cache that does not survive restarts.
- **Concurrency:** decided inside the per-chat FIFO queue, so two
  simultaneous first messages never get two welcomes. Across processes
  sharing one store it is check-then-set: route each chat to one process,
  as conversations already require.
- **Cost:** with no `WELCOME` handler, zero extra store reads. With one, at
  most one read (two in groups) plus one write per user and process; after
  that an in-memory cache answers.
- If the store read fails, the bot does not greet (fails closed), the error
  goes to `bot.on('error')` and the message continues normally.

### Re-arming the welcome

```ts
await bot.resetWelcome(dmChatId)          // the user of that DM
await bot.resetWelcome(groupId, userId)   // one group participant
await bot.resetWelcome(groupId)           // every participant of the group
```

`slashCommandsPlugin` calls `resetWelcome` on `/reset` (for the DM, or for
the participant who sent it). `/cancel` only cancels the conversation; the
welcome stays spent. `bot.deleteSubject(userId)` also re-arms the deleted
user's welcome. `exportSubject` does not include this flag.

## Message type triggers

```ts
bot.when(MEDIA, (ctx) => ctx.reply('Got your file'))       // image, video, audio, voice, document, sticker
bot.when(IMAGE, (ctx) => ctx.reply('Nice photo'))           // always beats MEDIA
bot.when(VOICE_NOTE, (ctx) => ctx.reply('Got your voice note'))
bot.when(LOCATION, (ctx) => ctx.reply('Got your location'))
bot.use(flow(DOCUMENT).ask('What is this document for?', 'reason'))
bot.when(typeTrigger('image', 'video'), (ctx) => ctx.reply('Great shot!'))  // your own combination
bot.when({ ...IMAGE, scope: 'dm' }, (ctx) => ctx.reply('DM only'))
```

| Constant | `ctx.type` |
| --- | --- |
| `MEDIA` | `image`, `video`, `audio`, `voice`, `document`, `sticker` |
| `IMAGE` / `VIDEO` / `DOCUMENT` / `STICKER` | the matching type |
| `AUDIO` | `audio` only (an audio file, like `bot.onAudio`) |
| `VOICE_NOTE` | `voice` (push-to-talk); use `typeTrigger('audio', 'voice')` for both |
| `LOCATION` / `CONTACT` | `location` / `contact` |
| `POLL` | `poll`: someone **created** a poll. Votes arrive on `bot.on('poll')` |
| `CALL` | `call`, see [below](#call) |

### Precedence

Matchers run by specificity (highest first; ties go to the one registered
first):

`WELCOME` (100) > equals / plain string (40) > `startsWith` (30) >
`endsWith` (25) > RegExp (20) > `contains` (10) > predicate function (5) >
single type (`IMAGE`..., `bot.onType`, `bot.onImage`) (2) > multi-type
(`MEDIA`, `typeTrigger(a, b)`) (1) > catch-all (`bot.onMessage`).

A text trigger is never shadowed by a type trigger: an image with the
caption "hola" goes to `bot.when('hola')`. `bot.onImage()` and
`bot.when(IMAGE)` share the same tier.

## CALL

`CALL` reacts to an incoming voice or video call:

```ts
bot.when(CALL, (ctx) => ctx.reply('📵 I cannot take calls, please write here.'))
bot.use(flow(CALL).ask('I saw your call, how can I help?', 'need'))  // the conversation continues in the chat
bot.when(CALL, (ctx) => { ctx.call?.status; ctx.call?.isVideo })      // typed CallEvent
```

- It fires **once per call id** (WhatsApp emits offer, then ringing,
  reject, timeout or terminate). To see every update, listen to
  `bot.on('call', (ev) => ...)`.
- The context has `type === 'call'`, `body === ''` and `ctx.call` (the
  `CallEvent`: `id`, `from`, `status`, plus optional `chatId`, `isGroup`,
  `isVideo` and `offline`). `ctx.reply()` answers the caller.
  `react`/`quote`/`markRead`/`delete` make no sense here.
- A 1:1 call is handled as the caller's DM. A **group call** is projected
  into the group: replies go to the group, `ctx.sender` is the caller, the
  conversation is per participant, and `scope` and `groupMode` apply.
- It runs after the `before`/`after('call')` hooks and the `'call'` event. A
  `before('call', (ev) => ev.abort())` suppresses it (and the `after('call')`
  hooks and the `'call'` event). The blacklist,
  whitelist and handoff gates also apply.
- Calls never reach commands, text or function triggers, `onMessage` or the
  `'message'` event, and are not stored as messages. They are ignored while
  the bot is stopped.
- A `CALL` trigger that **starts a conversation** never replaces one in
  progress: if the caller already has an active conversation or a dormant
  checkpoint, the next `CALL` handler runs instead. Plain
  `bot.when(CALL, fn)` handlers still run mid-flow.
- `bot.onType('call', handler)` is the same as `bot.when(CALL, handler)`.
- Testing: `provider.call({ id: 'c1', from: 'user-1', status: 'offer' })` on
  `MockProvider` (`@bot-wa/core/testing`).

Flows built with `flow(WELCOME)` or a type trigger get an anonymous id, so
`.persistent()` needs an explicit `.id('...')`.

## Next steps

- [Core concepts](./concepts#the-inbound-pipeline): where each trigger runs
- [Handoff & access lists](./handoff)
- [Persistent user data](./user-data)
- [Starting a flow programmatically](./messages#starting-a-flow-programmatically): `bot.trigger()` without an inbound message
