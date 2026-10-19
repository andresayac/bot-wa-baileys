# ESLint plugin

::: warning Experimental — not published yet
`eslint-plugin-bot-wa` is private: it is not on npm and its rules may change.
Use it from the monorepo (`"eslint-plugin-bot-wa": "workspace:*"` in your
`devDependencies`).
:::

`eslint-plugin-bot-wa` catches in source code the mistakes no generic linter
knows about: v1 API that no longer exists, a blocking `runtime.enter()`, an
async plugin `install()`, empty triggers, waits without a timeout and per-user
state in module variables. It complements the runtime
[`bot.lint()` / `lintFlows()`](/guide/flow-tools), which inspect the
registered flows (broken gotos, unreachable steps, duplicate triggers).

It needs **ESLint 9 or later** (flat config) and Node >= 22. The `src/bot.js`
of every [`create-bot-wa`](/guide/getting-started#scaffold-a-project-with-create-bot-wa)
template passes the `strict` preset with no findings (the plugin's tests
check it).

## Usage

```js
// eslint.config.js
import botWa from 'eslint-plugin-bot-wa'

export default [
  botWa.configs.recommended,
]
```

Or rule by rule:

```js
import botWa from 'eslint-plugin-bot-wa'

export default [
  {
    plugins: { 'bot-wa': botWa },
    rules: {
      'bot-wa/no-v1-api': 'error',
      'bot-wa/require-timeout-on-ask': ['error', { methods: ['ask', 'choose'], allowFlowTimeout: true }],
    },
  },
]
```

The rules are syntactic and need no type information. For TypeScript files,
combine the plugin with `typescript-eslint` (its parser).

## Presets

| Preset | Rules |
| --- | --- |
| `configs.recommended` | Errors: `no-v1-api`, `no-await-runtime-enter`, `no-async-plugin-install`, `no-empty-trigger`. Warnings: `require-timeout-on-ask`, `prefer-ctx-user-over-global-state`. |
| `configs.strict` | Every rule as an error; `require-timeout-on-ask` also checks `waitText`, `waitMedia`, `choose` and `waitAny`. |

## Rules

### `bot-wa/no-v1-api`

Flags the v1 / builderbot API that does not exist in v2, and names the
replacement in the message:

| v1 | Use instead |
| --- | --- |
| `.addAnswer()` | `flow(...).say(text)` / `.ask(text, 'stateKey')` |
| `.addAction()` | `.do(async (ctx, c) => { ... })` |
| `{ capture: true }` | `.ask(text, 'stateKey')` in a flow or `await c.ask(text)` in a conversation |
| `flowDynamic()` | `ctx.reply(...)` or a `.say((ctx, c) => ...)` step |
| `gotoFlow()` | `.goto('flowName')` or `c.goto('flowName')` |
| `endFlow()` | return from the step, or `c.end(message)` |

```js
addKeyword('hola').addAnswer('Your name?', { capture: true })   // reported
flow('hola').ask('Your name?', 'name', { timeout: '5m' })        // ok
```

No options.

### `bot-wa/no-await-runtime-enter`

`ConversationRuntime.enter()` resolves when the conversation **ends**.
Awaiting it in a handler blocks the chat's FIFO queue, so the message the
conversation is waiting for is never dispatched. The rule reports
`await runtime.enter(...)`, `return runtime.enter(...)` (the dispatcher awaits
the returned promise), an arrow function whose body is `runtime.enter(...)`,
and `await runtime.enter(...).catch(...)` (also `.then` / `.finally`).

```js
await runtime.enter(handle, msg)                                     // reported
void runtime.enter(handle, msg).catch((err) => log.error({ err }))   // ok
```

Option: `{ receiverPattern: string }`, a regex source the receiver name must
match (default `runtime$`, case-insensitive).

### `bot-wa/no-async-plugin-install`

`Plugin.install()` must be synchronous: `bot.plug()` does not await it, so
the bot runs before an async `install` has finished, and its rejection only
reaches the `'error'` event (older core versions crashed the process with an
unhandled rejection). The rule checks the object passed to `definePlugin(...)`, any object
literal with both `name` and `install`, and classes with an `install` method
that declare a `name` field or `implements Plugin`. For async setup use the
lazy pattern (resolve on first use, report configuration errors from a
non-fatal warmup), like `LazyProvider` in `@bot-wa/ai`.

No options.

### `bot-wa/no-empty-trigger`

An empty trigger (`''`, `'   '`, an empty template literal, `[]`, `['']`,
`{ pattern: '' }`) never matches a real message, or, with `contains`, matches
every message. Checked in `flow(...)` / `addKeyword(...)`, `bot.when(...)` and
the `trigger` option of `bot.conversation(name, fn, { trigger })`.

No options.

### `bot-wa/require-timeout-on-ask`

Every wait for user input should have a timeout, so an abandoned conversation
does not stay open (capturing that user's messages) forever.

- Flow DSL: `.ask(text, key, { timeout })`, or a `.timeout(...)` anywhere on
  the same `flow(...)` chain (unless `allowFlowTimeout: false`). A flow's
  `.choose(...)` has no per-step options, so it needs the chain `.timeout()`.
- Conversations: `c.ask(text, { timeout })` and, when listed in `methods`,
  `c.waitText({ timeout })`, `c.waitMedia(types, { timeout })`,
  `c.choose(prompt, options, { timeout })` and `c.waitAny({ timeout })`.
- When the options argument is not an object literal (a variable, a call) or
  contains a spread, the rule cannot see inside it and stays quiet.

Options: `{ methods?: ('ask' | 'waitText' | 'waitMedia' | 'choose' | 'waitAny')[], allowFlowTimeout?: boolean }`
(defaults `['ask']` and `true`).

### `bot-wa/prefer-ctx-user-over-global-state`

Flags the v1 `globalState` and module-level `Map`s or objects keyed by
`ctx.from`, `ctx.sender` or `ctx.senderId` (`users.get/set/has/delete(ctx.from)`,
`scores[ctx.sender]`). That state is lost on restart, grows forever and is not
shared between replicas. Use [`ctx.user`](/guide/user-data)
(`await ctx.user.ns('feature').set(key, value)`) for per-user data and
`c.state` for per-conversation data.

Option: `{ contextNames: string[] }`, the names of the handler context
parameter (default `['ctx']`).

## API

```ts
import botWa, { rules, configs, PLUGIN_NAMESPACE } from 'eslint-plugin-bot-wa'

botWa.meta      // { name: 'eslint-plugin-bot-wa', version, namespace: 'bot-wa' }
botWa.rules     // the six rules, by name without the 'bot-wa/' prefix
botWa.configs   // { recommended, strict } (flat configs)
```

The rule modules are also named exports: `noV1Api`, `noAwaitRuntimeEnter`,
`noAsyncPluginInstall`, `noEmptyTrigger`, `requireTimeoutOnAsk` and
`preferCtxUser`.

## See also

- [Inspect & lint flows](/guide/flow-tools)
- [Testing](/guide/testing)
- [`eslint-plugin-bot-wa` README](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/eslint-plugin)
