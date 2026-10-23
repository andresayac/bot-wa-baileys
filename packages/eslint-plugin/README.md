# eslint-plugin-botmesh

> **Private (not published to npm yet).** It lives in the `@botmesh` monorepo.

`@botmesh`-specific ESLint rules: they catch in source code the mistakes no generic linter knows about
(v1 API that no longer exists, blocking `runtime.enter()`, async `install()`, empty triggers, waits without a
timeout and per-user state in global variables). They complement the core's `bot.lint()` / `lintFlows()`,
which check flows at runtime (broken gotos, unreachable steps, duplicate triggers…).

Requires ESLint 9 or later (flat config) and Node >= 22.

## Usage

```js
// eslint.config.js
import botWa from 'eslint-plugin-botmesh'

export default [
  botWa.configs.recommended,
]
```

Or rule by rule:

```js
import botWa from 'eslint-plugin-botmesh'

export default [
  {
    plugins: { 'botmesh': botWa },
    rules: {
      'botmesh/no-v1-api': 'error',
      'botmesh/require-timeout-on-ask': ['error', { methods: ['ask', 'choose'], allowFlowTimeout: true }],
    },
  },
]
```

For TypeScript, combine it with `typescript-eslint` (the rules are syntactic: they need no type information).

## Presets

| Preset | Contents |
| --- | --- |
| `configs.recommended` | Errors: `no-v1-api`, `no-await-runtime-enter`, `no-async-plugin-install`, `no-empty-trigger`. Warnings: `require-timeout-on-ask`, `prefer-ctx-user-over-global-state`. |
| `configs.strict` | Everything as an error; `require-timeout-on-ask` also checks `waitText`, `waitMedia`, `choose` and `waitAny`. |

## Rules

### `botmesh/no-v1-api`

Flags the v1 / builderbot API that does not exist in v2: `.addAnswer()`, `.addAction()`, `{ capture: true }`,
`flowDynamic()`, `gotoFlow()` and `endFlow()`. The message points to the replacement (`flow().say/.ask/.do`, `ctx.reply`,
`.goto`, `c.end`).

```js
addKeyword('hello').addAnswer('Name?', { capture: true })   // ❌
flow('hello').ask('Name?', 'name', { timeout: '5m' })         // ✅
```

### `botmesh/no-await-runtime-enter`

`ConversationRuntime.enter()` resolves when the conversation **ends**: awaiting it (or returning its promise from
the handler, or `await runtime.enter().catch()`) blocks the chat FIFO queue and the message the conversation waits for
never arrives. Start it without waiting.

```js
await runtime.enter(handle, msg)                               // ❌
void runtime.enter(handle, msg).catch((err) => log.error({ err }))   // ✅
```

Option: `{ receiverPattern: string }` (regex for the receiver name; default `runtime$`, case-insensitive).

### `botmesh/no-async-plugin-install`

`Plugin.install()` must be synchronous: `bot.plug()` does not await it, the bot keeps going before it finishes and its
rejection only reaches the `'error'` event. TypeScript already rejects it at compile time (`PluginSpec.install` returns
`void | SyncInstallError`); the rule covers JavaScript and `as any` escapes. It checks the `definePlugin({...})` object, any literal
object with `name` + `install`, and classes with `install` that declare `name` or `implements Plugin`. For async initialization use the
lazy pattern (such as `LazyProvider` in `@botmesh/ai`).

### `botmesh/no-empty-trigger`

An empty trigger (`''`, `'   '`, `[]`, `['']`, `{ pattern: '' }`) matches nothing (or, with `contains`, everything).
It is checked in `flow()` / `addKeyword()`, `bot.when()` and the `trigger` of `bot.conversation(name, fn, { trigger })`.

### `botmesh/require-timeout-on-ask`

Every answer wait must have a timeout so an abandoned conversation ends.

- In flows: `.ask(text, key, { timeout })` or a `.timeout(...)` in the same chain.
- In conversations: `c.ask(text, { timeout })` (and, when configured, `c.waitText`, `c.waitMedia`, `c.choose`, `c.waitAny`).
- If the options are not a literal object (a variable, a spread), the rule cannot see them and does not warn.

Options: `{ methods?: ('ask' | 'waitText' | 'waitMedia' | 'choose' | 'waitAny')[], allowFlowTimeout?: boolean }`
(default `['ask']` and `true`).

### `botmesh/prefer-ctx-user-over-global-state`

Flags `globalState` (v1) and **module-level** `Map`s/objects indexed by `ctx.from`, `ctx.sender` or `ctx.senderId`
(`users.set(ctx.from, …)`, `scores[ctx.sender]`): they are lost on restart and are not shared across replicas. Use
`ctx.user` (`await ctx.user.ns('feature').set(key, value)`).

Option: `{ contextNames: string[] }` (context parameter names; default `['ctx']`).

## API

```ts
import botWa, { rules, configs, PLUGIN_NAMESPACE } from 'eslint-plugin-botmesh'
botWa.meta     // { name: 'eslint-plugin-botmesh', version, namespace: 'botmesh' }
botWa.rules    // the six rules
botWa.configs  // { recommended, strict } (flat config)
```

## Development

```bash
pnpm --filter eslint-plugin-botmesh build
pnpm --filter eslint-plugin-botmesh test       # RuleTester sobre vitest
pnpm --filter eslint-plugin-botmesh typecheck
```
