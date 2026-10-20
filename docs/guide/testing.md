# Testing

`@bot-wa/core/testing` lets you test a bot without WhatsApp, a phone or the
network. It works with any test runner (the repo uses Vitest).

```ts
import { createTestBot, MockProvider } from '@bot-wa/core/testing'
```

## `createTestBot` and `MockProvider`

```ts
import { flow } from '@bot-wa/core'
import { createTestBot } from '@bot-wa/core/testing'

const { bot, provider, chat } = await createTestBot()
bot.use(flow('hola').ask('Your name?', 'name').say((_ctx, c) => `Hi ${c.state.name}`))

await chat.send('hola')
await chat.expectReply('Your name?')
await chat.send('Ana')
await chat.expectReply(/Hi Ana/)
await chat.expectNoReply()   // nothing else within 300 ms
chat.replies()        // every text/caption sent to this chat so far
provider.outbox       // every outbound message, any chat
```

`createTestBot(config?)` builds a started `Bot` on a `MockProvider`. `chat` is one
DM (`user@s.whatsapp.net`): its helpers simulate what the user does and assert on
what the bot sent back. Every `send*`/`press*` helper yields one macrotask before
resolving, so the dispatch has started.

| Helper | What it does |
| --- | --- |
| `send(text, { type? })` | an inbound message (`type` defaults to `'text'`) |
| `sendMedia(kind, bytes \| { url, bytes? }, caption? \| { caption, mimetype, filename, size })` | a media message: `ctx.body` is the caption and `loadMediaOf(ctx)` resolves with the bytes. `{ url }` alone is metadata: the download rejects with `MediaUnavailableError` (the mock never touches the network) |
| `sendLocation(location)` / `sendLocation(lat, lng, { name? })` | a shared location (`ctx.sharedLocation`, `c.waitLocation()`) |
| `sendReaction(emoji, target?)` | a reaction to the bot's last message in the chat (else the user's last one), to an explicit `MessageRef`, or `{ to?, removed: true }` to retract it; reaches `bot.on('reaction')` and the `'reaction'` hooks |
| `pressButton(id \| title \| index)` | presses a native button, list row or card button of the last interactive message the bot sent; the bot receives what a real press produces (a `'buttons'` message whose body is the id, `ctx.interaction.data`). Throws when nothing interactive was sent, the target is unknown or it is a URL button. With `new MockProvider({ buttons: false })` menus are numbered text: use `chat.send('1')` |
| `sendInteraction(data, { kind?, id? })` | a raw interaction (`ctx.interaction.data`), e.g. `{ kind: 'command' }` |
| `expectReply(text \| regexp, timeoutMs?)` | resolves with the first matching reply (already sent or arriving before the timeout, 1 s by default) |
| `expectNoReply({ timeout? } \| ms)` | resolves when no unconsumed reply exists nor arrives within the window (300 ms by default); rejects listing the unexpected replies. Consumes nothing |
| `replies()` / `sent()` / `lastReply()` | the texts of every reply; every outbound entry with its full `content` and `ref`; the last one |
| `transcript(opts?)` | the exchange as a golden transcript (see [Conversation snapshots](#conversation-snapshots)) |

The helpers throw `TestKitError` with an actionable message. `expectReply` and
`expectNoReply` poll with real timers: under `vi.useFakeTimers()` advance them
(`vi.advanceTimersByTimeAsync`) or leave `setTimeout`/`setInterval` unfaked.

You can also drive the mock directly: `provider.incoming(text, { from, sender, ... })`,
`provider.incomingMedia(kind, bytes, opts)`, `provider.interaction(data, { kind })`
(button and list taps), `provider.incomingLocation(location, opts)`,
`provider.reaction(emoji, { to })` and `provider.call({ id, from, status })` (for
[`CALL` triggers](./triggers#call)). `provider.journal` keeps inbound messages,
interactions and sends (with their `ref`) in order, bounded by `maxJournal`
(10 000 by default).

`editMessage`, `deleteMessage` and `sendDraft` are real methods (recorded in
`edits`, `deleted` and `drafts`) that you can override in a subclass. They are
exposed according to `new MockProvider({ streaming, supports })`: `edit` and
`delete` when `streaming` is not `'none'`, `drafts` with `'draft'`. A disabled
one reads `undefined`, so the bot treats it as unsupported; pass
`supports: { edit: true }` to enable one, or `supports: { edit: false }` to
simulate a transport without it (this also hides a subclass override).

### Several users and groups

```ts
const { bot, chat, dm, group } = await createTestBot()

const ana = dm('ana@s.whatsapp.net', { displayName: 'Ana' })      // another DM
const team = group('team@g.us', { as: 'ana@s.whatsapp.net' })     // a group, driven by Ana
const beto = team.as('beto@s.whatsapp.net', { displayName: 'Beto' })  // same group, another participant

await team.send('hola'); await beto.send('hola')
await team.expectReply('Your name?'); await beto.expectReply('Your name?')
```

Each view carries `chatId`, `senderId`, `isGroup` and `displayName`. Views of the
same chat share one reply cursor (group replies are not per sender), so
participants read the chat's replies in order, while conversations stay per
participant (`conversationScope: 'participant'`). On a DM, `chat.as(userId)` is
another DM. `provider.journal` holds the events every view emitted, ready for
`assertStableIdentity`.

### Conversation snapshots

```ts
expect(chat.transcript()).toMatchSnapshot()

chat.transcript({ as: 'text' })
// user@s.whatsapp.net> hola
// bot< Your name?
```

`chat.transcript({ name?, ids?, timestamps?, scope?, as? })` returns a golden
[transcript](/guide/golden-transcripts) with the shape `recordTranscript`
produces: it parses, redacts (`redactTranscript`) and replays
(`assertTranscript`) unchanged. Ids and `t` offsets are dropped by default so
snapshots stay stable; `scope: 'all'` interleaves every chat the mock saw and
`as: 'text'` renders one line per turn. Reactions are not transcript turns.

### Vitest matchers

```ts
// vitest.setup.ts (a `setupFiles` entry) or at the top of a test file
import { expect } from 'vitest'
import { botMatchers } from '@bot-wa/core/testing/vitest'
expect.extend(botMatchers)

expect(chat).toHaveReplied('Your name?')               // string includes / RegExp
expect(chat).toHaveRepliedMatching((text, content) => content.kind === 'image')
expect(provider).toHaveRepliedTimes(2)                 // also provider.outbox or a string[]
```

`@bot-wa/core/testing/vitest` exports the matchers and augments vitest's
`Matchers` type (`.not` works). `vitest` is an optional peer dependency: nothing
is imported from it at runtime. The matchers are synchronous: wait with
`expectReply`, then assert.

`MockProvider` always uses a stable `from`. To test identity changes and
hostile delivery, use the chaos kit below.

## Chaos kit: adversarial delivery

`ChaosProvider` wraps any `IProvider` (usually `MockProvider`) and delivers
its traffic adversarially: duplicates, reordering, latency, failed sends,
disconnects and identity aliases. It is deterministic for a given `seed`.

```ts
import { createTestBot } from '@bot-wa/core/testing'

const { bot, provider, chaos } = await createTestBot({}, {
  chaos: {
    seed: 7,
    duplicates: 0.3,                        // or { probability, copies, delayMs }
    reorder: 3,                             // or { window, maxHoldMs, strategy: 'shuffle' | 'reverse' }
    latency: { min: 0, max: 5 },
    sendFailures: { attempts: [2], errors: ['rate-limited'], retryAfterMs: 500 },
    disconnects: { afterInbound: [5], downtimeMs: 20, replayOnReconnect: 2 },
    aliases: { map: { '573001@s.whatsapp.net': ['999@lid'] }, strategy: 'cycle' },
  },
})
bot.when('hola', async (ctx) => await ctx.reply('👋'))
provider.incoming('hola', { from: 'u1' })   // keep driving the mock
await chaos.settle()                        // wait for pending deliveries (real timers)
```

With any provider: `const chaos = withChaos(myProvider, { seed: 1, duplicates: 1 }); new Bot({ provider: chaos })`.

| Option | What it simulates |
| --- | --- |
| `duplicates` | redelivery (webhook retries). With `delayMs: 0` (default) the copy arrives in the same tick, the worst case |
| `reorder` | shuffles events inside a window, in arrival order |
| `latency` / `sendLatency` | fixed delay or `{ min, max }` range, in ms |
| `sendFailures` | transient failures with typed errors: `'rate-limited'`, `'unreachable'`, `'payload-too-large'`, `'outside-window'`, `'unsupported'`, `'disconnected'` or your own factory. Cycled in order; pick them by `attempts` (1-based), `probability` or cap them with `maxConsecutive`. A failed send does not reach `outbox` |
| `disconnects` | automatic drops (`closed → connecting → ready`). While down, inbound is held and sends fail with `ChaosDisconnectedError`. `replayOnReconnect` redelivers the last N messages, like an offline sync |
| `aliases` | the same person under several wire ids (LID/PN). Without `resolve` it simulates a provider that leaks aliases and breaks the identity contract; with `resolve` it tests your resolver |
| `kinds` | event kinds affected. Default `['message', 'interaction']`; `connection` events always pass straight through |

Manual controls: `chaos.disconnect({ reason, downtimeMs })` (without
`downtimeMs` it stays down until `chaos.reconnect()`), `chaos.replay(n)`
(an explicit webhook retry), `chaos.flush()` and `chaos.settle()`. For
assertions: `chaos.log` (what was injected) and `chaos.delivered` (what
reached the bot). For exact timing use `vi.useFakeTimers()` and
`vi.advanceTimersByTimeAsync()`.

Since [inbound dedupe](./concepts#inbound-dedupe) is on by default, a bot
under `duplicates` and `replay` should still answer each message once.

## Identity contract for providers

Every provider must emit the same `senderId` for the same person, whatever
alias the transport uses (see the identity contract on `IProvider`). These
helpers check a list of emitted events:

```ts
import { assertStableIdentity, checkIdentityContract, recordEvents } from '@bot-wa/core/testing'

const events = [toInbound(a, identity), toInbound(b, identity), toInbound(c, identity)]
assertStableIdentity(events, { andres: { events: [0, 1, 2], senderId: PN, chatId: PN, kind: 'dm' } })

checkIdentityContract(events, { andres: [0, 1, 2] })   // → IdentityViolation[] instead of throwing

const rec = recordEvents(provider)                      // capture what a real provider emits
// ... drive the provider ...
assertStableIdentity(rec.events, { andres: [0, 1] })
rec.stop()
```

What it checks:

- ids are non-empty and do not look like `undefined`/`null`/`NaN`/`[object Object]`;
- `from`/`chatId`/`chat.id`, `sender`/`senderId`/`senderInfo.id` and
  `ref.chatId` agree;
- `ChatKind` is valid and consistent with `isGroup`/`isBroadcast`, and a
  chat never changes kind;
- per person: one `senderId`, one DM `chatId`, and the expected ids/kind;
- two different people never share a `senderId`.

Options: `requireRefChatId`, `rejectSuspiciousIds`, `distinctHumans`.
`assertStableIdentity` throws an `IdentityContractError` with
`violations`. A real example lives in
`packages/baileys-provider/tests/identity-contract.test.ts`.

## Golden transcripts

To lock down whole conversations, record one (`recordTranscript`) or read it
from the store log (`transcriptFromStore`), redact it, commit it as JSON and
replay it in a test with `assertTranscript`: any changed, missing or extra
reply fails with an expected-vs-actual diff. The same replay can gate a
deployment. See [Golden transcripts](/guide/golden-transcripts).

```ts
import { assertTranscript, parseTranscript } from '@bot-wa/core/testing'

await assertTranscript(parseTranscript(readFileSync('tests/golden/checkout.json', 'utf8')), buildBot)
```

## Static checks

[`eslint-plugin-bot-wa`](/guide/eslint) (experimental) catches v1 API
leftovers, a blocking `runtime.enter()`, async plugin `install()`, empty
triggers, waits without a timeout and per-user state in module variables
before the code runs.

## Next steps

- [Terminal simulator](./dev-simulator): try the bot by hand
- [Inspect & lint flows](./flow-tools)
