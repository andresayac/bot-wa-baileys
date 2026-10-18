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
chat.replies()        // every text/caption sent to this chat so far
provider.outbox       // every outbound message, any chat
```

`createTestBot(config?)` builds a started `Bot` on a `MockProvider`. You can
also drive the mock directly: `provider.incoming(text, { from, sender, ... })`,
`provider.interaction(data, opts)` (button and list taps) and
`provider.call({ id, from, status })` (for [`CALL` triggers](./triggers#call)).

`editMessage`, `deleteMessage` and `sendDraft` are real methods (recorded in
`edits`, `deleted` and `drafts`) that you can override in a subclass. They are
exposed according to `new MockProvider({ streaming, supports })`: `edit` and
`delete` when `streaming` is not `'none'`, `drafts` with `'draft'`. A disabled
one reads `undefined`, so the bot treats it as unsupported; pass
`supports: { edit: true }` to enable one, or `supports: { edit: false }` to
simulate a transport without it (this also hides a subclass override).

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

## Next steps

- [Terminal simulator](./dev-simulator): try the bot by hand
- [Inspect & lint flows](./flow-tools)
