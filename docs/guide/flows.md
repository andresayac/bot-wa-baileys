# Conversation Flows

Flows are multi-step conversations. `flow(trigger)` gives you a chainable
DSL that compiles to a real async conversation under the hood: the bot
asks, the user answers, the bot stores the answer in `c.state` and
continues.

## Basic flow

```ts
import { flow } from '@bot-wa/core'

const greet = flow('hola')
  .ask('👋 Hello! What is your name?', 'name')
  .say((_ctx, c) => `Nice to meet you, ${c.state.name}!`)

bot.use(greet)
```

## DSL methods

### say — send a message

```ts
flow('x').say('text')                                // fixed text
flow('x').say((_ctx, c) => `Hi ${c.state.name}`)      // dynamic, reads c.state
```

### ask — send a message and wait for the reply

```ts
flow('x').ask('What is your name?', 'name')  // stores the reply in c.state.name

flow('x').ask('Email?', 'email', {
  validate: (body) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Invalid email, try again',
  retries: 2,
  timeout: '2m',
})
```

If `validate` returns an error string, the bot sends it back and re-asks
(up to `retries`, default 3, before throwing `RetriesExceeded`).

### do — run an action, no message

```ts
flow('x').do((ctx, c) => {
  c.state.registeredAt = Date.now()
})
```

### media — send media

```ts
flow('x').media('https://picsum.photos/400/300', 'caption')
```

### choose — branching (numbered menu)

```ts
flow('confirmar')
  .choose('Confirm your order?', { si: 'Yes', no: 'No' })
  .say((_ctx, c) => c.state.choice === 'si' ? '✅ Confirmed' : '❌ Cancelled')
```

`choose` sends a numbered menu built from `options` (`Record<string,
string>`, key → label) and stores the chosen **key** in `c.state.choice` —
or in whatever key you pass as the 3rd argument:
`.choose(prompt, options, 'answer')`.

Each option can instead carry a `then` sub-flow that runs right after it's
picked; control returns to the parent flow afterwards:

```ts
flow('menu')
  .choose('What are you interested in?', {
    ofertas: { label: 'Offers 🏷️', then: (_ctx, c) => { c.state.interest = 'ofertas' } },
    soporte: { label: 'Support 🛠️', then: (_ctx, c) => { c.state.interest = 'soporte' } },
  })
  .say((_ctx, c) => `Got it: ${c.state.interest}`)
```

### timeout — inactivity expiration

```ts
flow('soporte')
  .timeout('60s')
  .ask('Describe your issue', 'issue')
```

`.timeout()` only sets the wait duration — it takes no message argument.
The text sent when it expires is configured once, globally, on the bot:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  conversation: { timeoutMessage: '⏰ Session expired due to inactivity.' },
})
```

A `then:` sub-flow uses its own `.timeout()`; it does **not** inherit the
parent flow's. Without one, the bot-wide `conversation.timeout` (or the
built-in 5-minute fallback) applies.

### goto — jump to another flow

```ts
flow('a').say('Redirecting you...').goto('b')
```

The target must be registered too (`bot.use(flow('b')...)` or
`bot.conversation('b', ...)`); `bot.lint()` reports a `goto` to a missing
flow as `goto-target-missing`.

### persistent — survive restarts

```ts
flow('registrar').persistent().ask('Name?', 'name').say('Done')
```

`.persistent()` checkpoints after every step, but that only survives a
**process restart** if the store is backed by a file:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  storeConfig: { file: './store.json' }, // or a real store — see the Store guide
})
```

A flow needs a stable id to be checkpointed. A string trigger already
provides one; if you built the flow with a regex/predicate trigger, give it
an explicit id with `.id('registrar')`.

### scope — restrict to dm / group / all

```ts
flow('soporte').scope('dm').ask('Describe your issue', 'issue')
```

## `c.state` — memory between steps

`c.state` is a plain, mutable object scoped to the running flow. `.ask` and
`.choose` write to it automatically; `.do` and the function form of `.say`
read and write it directly:

```ts
flow('x')
  .ask('Name?', 'name')
  .do((_ctx, c) => { c.state.name = c.state.name.trim() })
  .say((_ctx, c) => `Hi ${c.state.name}`)
```

## Complete example: registration

```ts
const register = flow('registrar')
  .say('📝 *Let us register you*')
  .ask('Name?', 'name')
  .ask('Email?', 'email', {
    validate: (body) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Invalid email',
  })
  .say((_ctx, c) => `✅ ${c.state.name} <${c.state.email}>`)

bot.use(register)
```

## Beyond the DSL

For arbitrary control flow — loops, custom branching, calling an external
API mid-conversation — skip the DSL and write the conversation directly
with `bot.conversation(name, async (c, ctx) => {...})`, using
`c.ask`/`c.waitText`/`c.waitMedia`/`c.choose`/`c.goto`/`c.end`. Flows built
with `flow()` compile down to exactly this runtime.

## `ctx` in `bot.conversation()` is a full `MessageContext`

The second argument of a `bot.conversation()` handler is the full
`MessageContext`, typed through `DefaultTools`: `ctx.tools` (including
augmentations such as `ctx.tools.ai` or `ctx.tools.nlu`), `ctx.user`,
`ctx.handoff()`, `ctx.photo`, `ctx.poll`, `ctx.react`, `ctx.quote`,
`ctx.senderInfo`... No casts needed.

```ts
bot.conversation('photo', async (c, ctx) => {
  const img = await c.waitMedia(['image'], { timeout: '2m' })
  await ctx.react('📸')
  await ctx.reply(`Received (${img.type})`)
})
```

The public type is `ConversationHandler<TTools = DefaultTools>`; handlers
typed with the older `ConversationFn<ConversationControls>` still compile.
In the DSL (`flow().do((ctx, c) => ...)`) `ctx` is still a `RuntimeMessage`;
use `userOf(ctx)` and `bot.handoff(ctx.from)` there.

## `c.retry()`: repeat the last wait

`c.retry(message?)` repeats the most recent wait (`ask`, `waitText`,
`waitMedia`, `choose`, `waitAny`) with the same options (`validate`,
`filter`, `timeout`, `otherwise`, `retries`). Before waiting it re-sends the
`ask` question or the `choose` menu, or `message` instead. For `choose`,
`message` only replaces the header; the numbered options stay.
`waitText`/`waitMedia`/`waitAny` have no prompt, so they only send
`message` if you pass one. `c.retry('')` waits again silently.

In an async conversation it returns the new value:

```ts
bot.conversation('hangman', async (c, ctx) => {
  let letter = await c.ask('Type a letter')
  while (letter.length !== 1) letter = await c.retry('❌ Just one letter')
  await ctx.reply(`✅ ${letter}`)
})
```

For `waitMedia`/`waitAny`, type it: `await c.retry<RuntimeMessage>('Send another photo')`.

In a **flow step** (`.do()` or a `.choose()` `then` action) whose last wait
belongs to an earlier step, `c.retry()` rewinds the flow to that step: it is
asked again (with `message` instead of the question, if given), its state
key gets the new answer, and the following steps run again, including the
`.do()` that called it. It throws a control signal synchronously, so code
after it in the step does not run (like `c.end()`):

```ts
flow('game')
  .ask('Type a letter', 'letter')
  .do((_ctx, c) => {
    if (String(c.state.letter).length !== 1) c.retry('❌ Just one letter')
  })
  .say((_ctx, c) => `✅ ${c.state.letter}`)
```

- It works in sub-flows (`then: subFlow`) and in `.persistent()` flows
  resumed after a restart. If the wait was made in the same `.do()`
  (`await c.waitText()`), it retries in place.
- **Budget:** each `c.retry()` counts as one invalid attempt of that wait,
  shared with `validate` rejections. Reaching `retries` (default 3) throws
  `RetriesExceeded` and the conversation ends with `retriesMessage`. Each
  new wait starts at zero. For unlimited retries use `retries: Infinity`.
- With no previous wait it fails with `RetryUnavailableError` (sent to the
  `'error'` event, and `errorMessage` is sent).
- Always `await` (or `return`) it. A conversation has one pending-wait
  slot: a new wait started while an un-awaited retry is still waiting fails
  with `ConcurrentWaitError`.
- Do not call it inside `validate` (return an error string there). If you
  wrap a step in `try/catch`, rethrow `ConversationError`
  (`if (e instanceof ConversationError) throw e`).

## `c.idle()`: inactivity inside a conversation

```ts
bot.conversation('game', async (c, ctx) => {
  c.idle('2m', async () => {
    await ctx.reply('⏰ Disconnected for inactivity')
    c.end('👋 See you!')               // ends the conversation (sends the farewell)
  })
  await ctx.reply('Type a letter')
  const letter = await c.waitText({ timeout: '10m' })
  c.idleClear()                         // disarm it once they answered
})
```

- The callback runs once when `duration` (`'30s'`, `'2m'`, `'1h'`, `'1d'`,
  `'10 minutes'` or ms, up to about 24.8 days) passes with no message from
  the conversation's user. Every inbound message reschedules it, even one
  the pending wait filters out; after it fires, the next message re-arms it.
- Calling `c.idle()` again replaces the previous watchdog. It is disarmed
  when the conversation ends, on `/reset` or `bot.abortConversation`, on
  `goto` and on `bot.stop()`, so no timers are left behind.
- Inside the callback: `c.end(farewell?)` or `c.goto('menu')` finish or
  redirect the conversation at the pending wait. `c.retry(msg?)` re-sends
  the pending question as a reminder and keeps waiting for the same answer
  (it counts towards `retries`; for a reminder that does not count, use
  `ctx.reply`). If no wait is pending it does nothing. The callback cannot
  start new waits. Other errors go to the `'error'` event and the
  conversation goes on.
- It is independent from the wait `timeout`, which ends the conversation
  with `timeoutMessage`. It works in flow `.do()` steps and stays active
  between steps. Commands handled by the dispatcher do not count as
  activity. It is not persisted (it does not survive a restart or a
  `goto`).

## `bot.onIdle()`: inactivity per chat

```ts
bot.onIdle('10m', async (ctx, { chatId, idleMs, lastActivityAt }) => {
  await ctx.reply('Still there? 👀')        // ctx = the chat's last processed message
})
const off = bot.onIdle('1h', (ctx) => bot.sendText(ctx.from, 'Closing your session for inactivity'))
off()                                        // stop watching and cancel its timers
bot.clearIdle(chatId)                        // cancel a chat's pending timers (all chats without an argument)
```

- Per chat (`ctx.from`); in a group, any participant counts.
- It fires once per period, counted from the last inbound message the bot
  finished processing. Each new message reschedules and re-arms it.
- Messages dropped before the end of the pipeline (a `before('message')`
  hook that aborts, the `groupMode` filter) do not count as activity.
- `bot.stop()` cancels everything; registrations survive stop/start.
- [Human handoff](./handoff): a handed-off chat's timers are cancelled and
  suspended (its messages do not re-arm them) until it is resumed, also for
  handoffs restored from the store at start.
- Handler errors (sync or async) go to the `'error'` event with the `ctx`.
- Uses the bot's `Scheduler`. An invalid duration (≤ 0, not finite, above
  2^31 − 1 ms) throws `RangeError`. Inside a plugin, pass the returned
  unsubscribe to `ctx.onDispose`.

## Checking your flows

`bot.describe()` draws your flows as a Mermaid diagram and `bot.lint()`
reports broken `goto`s, unreachable steps, duplicate triggers and more. See
[Inspect & lint flows](./flow-tools).

## Next steps

- [Flow examples](/examples/registration-flow) — full recipes
- [Special triggers](./triggers) — WELCOME, message types and CALL
- [Hooks](./hooks) — intercept messages
- [Plugins](./plugins) — package functionality
