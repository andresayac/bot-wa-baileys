# Conversation Flows

Flows are multi-step conversations. `flow(trigger)` gives you a chainable
DSL that compiles to a real async conversation under the hood: the bot
asks, the user answers, the bot stores the answer in `c.state` and
continues.

## Basic flow

```ts
import { flow } from '@bot-wa/bot-wa-baileys'

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
  conversation: { timeoutMessage: '⏰ Session expired due to inactivity.' },
})
```

### goto — jump to another flow

```ts
flow('a').say('Redirecting you...').goto('b')
```

### persistent — survive restarts

```ts
flow('registrar').persistent().ask('Name?', 'name').say('Done')
```

`.persistent()` checkpoints after every step, but that only survives a
**process restart** if the store is backed by a file:

```ts
const bot = new Bot({ storeConfig: { file: './store.json' } })
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

## Next steps

- [Flow examples](/examples/registration-flow) — full recipes
- [Hooks](./hooks) — intercept messages
- [Plugins](./plugins) — package functionality
