# Public API coherence review

Review of the 10 public packages (`@botmesh/core` with its `testing` and `dev`
subpaths, `@botmesh/ai`, `@botmesh/baileys`, `@botmesh/meta`, `@botmesh/telegram`,
`@botmesh/sqlite-store`, `@botmesh/redis-store`, `@botmesh/http`, `@botmesh/graph-core`
and `create-botmesh`) before the first npm release (2026-10).

**Rule for this pass:** only non-breaking changes. Types were added or widened.
Names that lose a naming decision stay available with `@deprecated`. Nothing was
removed. Breaking clean-ups were listed under [Deferred](#deferred-needs-a-maintainer-decision);
the maintainer later authorised them for the (unpublished) alpha, and they are
resolved there as [Alpha clean-ups](#alpha-clean-ups-deferred-items-2-to-5).

## How it was checked

`scripts/api-check.cjs` reads the compiled `lib/**/*.d.ts` of the public packages
with the root TypeScript (5.9, the one TypeDoc uses). Run `pnpm build` first.

```bash
node scripts/api-check.cjs missing   # types referenced by public signatures but exported from no entry,
                                     # plus DANGLING: a kept signature naming a type that stripInternal removed
node scripts/api-check.cjs any       # `any` in exported declarations (reviewed exceptions allow-listed)
node scripts/api-check.cjs internal  # exported symbols, and members of exported declarations, tagged @internal
node scripts/api-check.cjs surface   # every exported name per entry; diff it before/after a change
node scripts/api-check.cjs deprecated # exported names tagged @deprecated (listing only)
pnpm api-check                       # missing + any + internal (the gate; run after pnpm build)
```

`pnpm pack:smoke` also fails when a packed `.d.ts` contains `@internal`, and its
consumer project compiles a typed hook, an `aiPlugin({ instance })`, providers with
`logger: console` and a `// @ts-expect-error` async `install`.

Results for this pass:

| Check | Before | After |
| --- | --- | --- |
| `missing` | 39 types in 6 packages | 0 |
| `any` | 6 sites in `@botmesh/core` | 0 outside the reviewed exceptions (F13) |
| `internal` | 0 | 0 |
| `surface` | 769 exported names | 806: **37 added, 0 removed** |

A line diff of every public `.d.ts` before and after the change shows only these
kinds of change: widened parameters (`send`, `stop`, `autoSaveInterval`, `isPlugin`),
inline object types replaced by named exported types, and local aliases replaced by
exported types.

Severity: **high** means users hit wrong behaviour, a wrong unit or a type they cannot name.
**Medium** means confusing or duplicated API. **Low** means cosmetic or naming only.

## Findings

### F1. Types used in public signatures were not exported (high)

Users could not name types that appear in public signatures. They had to write
`Parameters<…>` or copy the shape.

| Package | Types now exported |
| --- | --- |
| `@botmesh/core` | `InboundListener` (new name for the `onEvent` listener), `WaitMediaType` (`c.waitMedia`), `UserDataStore` (`supportsUserData` guard), `PacerLogger` (`PacerOptions.logger`), `FormFieldBase`, `StopOptions`, `ConversationTarget`, `JsonValue` (used by `TranscriptOutbound`; it was exported only from `/testing`, which TypeDoc reported) |
| `@botmesh/core/testing` | `MockIncomingOptions` (`MockProvider.incoming/interaction`, previously the unexported `IncomingOpts`) |
| `@botmesh/ai` | `AIPluginConfig` (the parameter of `aiPlugin`), `AnthropicLike`, `OpenAILike`, `GeminiLike`, `GeminiModelLike` and the request/response/usage types they reference (needed to inject a fake client) |
| `@botmesh/baileys` | `WAMediaUpload` (`toMediaUpload`), `DisconnectAction` (`classifyDisconnect`). `ChatId`/`UserId` were redeclared in `jid.ts`; core's types are now re-exported there instead |
| `@botmesh/meta` | `GraphClientConfig` (`new GraphClient(cfg)`) |
| `@botmesh/telegram` | `TelegramMessageEntity`, `TelegramPhotoSize`, `TelegramLocation`, `TelegramContact`, `TelegramPoll` (fields of `TelegramMessage`) |
| `@botmesh/redis-store` | `RedisMulti` (`RedisLikeClient.multi()`) |

**Decision:** export all of them (done).

### F2. Two different duration grammars in core (high)

`@botmesh/core` had two `parseDuration` functions. The exported one (`utils/timers`,
used by the scheduler) accepted `'1d'`, `'1w'`, `'5 minutes'` and `'500'`. The internal
one (`utils/duration`, used by flows, `ctx.reply({ delay })`, `broadcast`, `dedupe.ttl`,
conversation timeouts and forms) accepted only `ms|s|m|h`. So
`bot.every('1d', …)` worked, but `flow().timeout('1d')` and
`ctx.reply(t, { delay: '1d' })` threw an error.

**Decision:** keep a single implementation, the superset grammar, in `utils/duration.ts`.
`timers.ts` re-exports it (done). This only widens what is accepted. The error message
now lists `'1d'`.

Follow-up: the wider grammar let timer-backed options take values a Node timer cannot hold
(2^31 − 1 ms, about 24.8 days). `setTimeout`/`setInterval` fire after 1 ms for a larger
delay, so `flow().timeout('30d')` expired the conversation at once and
`MemoryStore({ autoSaveInterval: '30d' })` saved in a tight loop. Every timer-backed
option (`flow().timeout()`, `c.ask`/wait `timeout`, `conversation.timeout`, form `timeout`,
`MemoryStore.autoSaveInterval`, `bot.stop({ timeout })`) now goes through
`parseTimerDuration`, which throws `RangeError` above `MAX_TIMER_MS`, as `onIdle()` and
reply delays already did (done, with tests).

### F3. Duration options used different units and types (high)

The convention across packages is: `fooMs: number` takes milliseconds, and `foo` takes a
duration string or milliseconds. These options broke it:

| Option | Was | Now |
| --- | --- | --- |
| `bot.stop({ timeout })` | `number` (ms) only | `string \| number`, type `StopOptions` |
| `MemoryStore({ autoSaveInterval })` | `number` (ms) only | `string \| number`. An invalid value throws at construction |
| `RedisStore({ ttl })` | `number` in **seconds** (a unit trap: the core's `ttl` options are a duration or ms) | new `sessionTtl: string \| number` (duration or ms). `ttl` is kept, `@deprecated`, and setting both throws a `RangeError` |
| `TelegramProvider({ pollTimeout })` | seconds | **kept**: it mirrors the Bot API's `getUpdates.timeout`, and the JSDoc already states seconds |

**Decision:** widen the first two, add `sessionTtl` and deprecate `ttl` (done). Keep
`pollTimeout`.

### F4. Plugin-scoped `bot.hook()` was not tracked, and `onError` dropped its priority (high, bug)

Inside `Plugin.install`, `bot.before/after/onError` registrations are removed by
`unplug()`, but `bot.hook()` registrations were not: they survived the unplug.
`onError` had no `priority` parameter, unlike `before`/`after`/`hook`.

**Decision:** wrap `hook` in the plugin scope, and add `onError(event, handler, priority = 0)`
both on `Bot` and in the plugin scope (done, with tests).

### F5. `bot.send` vs `bot.sendTo` vs `bot.sendText` (medium)

`sendTo` (handoff) and `broadcast` accepted a plain string, but `send` did not.
`sendText` covers only text.

**Decision:** widen `send(chatId, string | OutboundContent)` (done). Keep `sendTo`,
whose name reads well in handoff code, and `sendText`. Both are documented as
equivalent to `send`. They are not deprecated because they are used across the docs.

### F6. `bot.trigger` vs `bot.triggerFlow` (medium)

There are two entry points for a proactive start. `triggerFlow(id, target, { state, body })`
is a thin wrapper over `trigger(name, { chatId, userId, isGroup, data, ifActive, body })` with
`ifActive: 'replace'`. Differences: the target is split into its own argument,
`state` corresponds to `data`, it resolves to `boolean` instead of `TriggerResult`, and
for an unknown flow it resolves `false` instead of rejecting.

**Decision:** keep both. `triggerFlow` backs the `@botmesh/manager` HTTP contract (a
`boolean` result and a 404 for an unknown flow), and both the JSDoc and the guides already
call it a wrapper. Revisit `state` vs `data` before 2.0.0 stable. **Resolved (alpha):**
`triggerFlow` takes `data`; `state` is a `@deprecated` alias (see
[Alpha clean-ups](#alpha-clean-ups-deferred-items-2-to-5), item 5).

### F7. Four names for a text reply (low)

`ctx.say`, `ctx.reply`, `ctx.answer` and `ctx.text` are the same function.

**Decision:** keep them, because they are documented as aliases in both guides. JSDoc now
names `reply` as the canonical one and marks the others as aliases (done).

### F8. `ctx.replyWithTyping(text, msPerChar?)` overlaps `ReplyOptions.typing` (medium)

It ignores `BotConfig.typing`, does not refresh the indicator and is not dropped when the
bot stops or the chat is handed off. `FEATURES.md` also showed it with a non-existent
`{ msPerChar }` options object.

**Decision:** deprecate it in favour of `ctx.reply(text, { typing: true })`. Update the
EN/ES messaging guides and fix the `FEATURES.md` example (done).

### F9. `bot.onMessage(handler)` vs `bot.on('message', listener)` (medium)

`onMessage` is the dispatcher's catch-all: it only receives what nothing else routed.
`on('message')` is the event that observes every inbound message. The names suggest the
opposite.

**Decision:** keep both (renaming would break the most common API). The JSDoc of
`onMessage` now spells out the difference (done).

### F10. Return types of registration methods (low)

`when`, `command`, `onMessage`, `onType`, `plug` and `onIdle` return an unsubscriber.
`use`, `before`, `after`, `onError` and `hook` return `this` for chaining.

**Decision:** keep. Changing either group would break callers. JSDoc on each method now
says which one it returns (done).

### F11. Inline target types for conversations (low)

`abortConversation(target: string | { from: string; sender: string; isGroup })` and
`inspectConversation(target: { from: ChatId; sender: UserId; isGroup })` declared the
same shape twice, with different id types.

**Decision:** add `ConversationTarget` and use it in both. Any `ctx` satisfies it (done).

### F12. `HookEvent` collapsed to `string` (low)

`'message' | 'send' | … | string` reduces to `string`, so editors gave no autocomplete.

**Decision:** use `| (string & {})`. The accepted values are the same and autocomplete
works (done).

### F13. `any` in public types (medium)

| Site | Decision |
| --- | --- |
| `isPlugin(x: any)` | changed to `unknown`, with narrowing in the body (done) |
| `Bot.on/once/off/emit(event: string, listener: (...args: any[]) => void)` | **kept**: the overload must stay assignable to Node's `EventEmitter` signatures. `unknown[]` would reject typed listeners such as `(x: string) => void` |
| `HookHandler<TCtx = any>` | ~~kept~~ **Resolved (alpha):** the default is `unknown` and the context is inferred from the event name (see [Alpha clean-ups](#alpha-clean-ups-deferred-items-2-to-5), item 4) |

### F14. Error classes (medium)

- `ProviderError` and `ConversationError` (and the subclasses without their own
  constructor) reported `name === 'Error'`, so logs read `Error: conversation timeout`.
  **Decision:** both bases now set `this.name = new.target.name` (done).
- `AITimeoutError` (`@botmesh/ai`) did not extend core's `TimeoutError`.
  **Decision:** it now does, so one `instanceof TimeoutError` check covers both (done).
- `ConversationTimeout`, `ConversationCancelled`, `RetriesExceeded` and
  `RateLimiterTimeout` lack the `Error` suffix. **Decision:** keep them. They are control
  signals that are rarely constructed by users, and aliases would only add surface.
- Providers throw the typed `ProviderError` subclasses consistently (the AGENTS.md rule
  holds in the public providers).

### F15. `Plugin.install` allows `Promise<void>` (medium, boolean/async trap)

`bot.plug()` does not await `install`, so an async `install` that rejects causes an
unhandled rejection. The type still allows `Promise<void>`.

**Decision:** narrowing the type would break existing plugins, so the JSDoc on `install`
now warns about it and points to lazy initialisation (done). **Resolved (alpha):** the
return type is now `void | SyncInstallError`, which rejects an async `install` at
compile time (see [Alpha clean-ups](#alpha-clean-ups-deferred-items-2-to-5), item 4).

### F16. `@internal` leaks (low)

No exported symbol is tagged `@internal`. `AIPluginConfig.__provider` (a test-only
injection hook) is tagged `@internal` but still appears in the `.d.ts`, because no package
uses `stripInternal`.

**Decision:** keep. Turning on `stripInternal` needs a per-package audit, because some
`@internal` helpers are imported across workspace packages. Deferred. **Resolved (alpha):**
audited and enabled for every package (see [Alpha clean-ups](#alpha-clean-ups-deferred-items-2-to-5), item 2).

### F17. `Config` alias of `BotConfig` (low)

`@botmesh/core` exported the same type under two names. Nothing in the repo used `Config`.

**Decision:** `Config` is now a `@deprecated` type alias of `BotConfig` (done).

### F18. Provider `logger` options take a pino `Logger`, core takes `LoggerLike` (medium)

`BotConfig.logger` is the structural `LoggerLike`, but `BaileysProviderConfig`,
`CloudAPIProviderConfig` and `TelegramProviderConfig` require pino's full `Logger`. A
custom logger therefore works for the bot but not for the provider.

**Decision:** deferred. Widening the input type is non-breaking for callers, but each
provider first needs an audit of which pino methods it calls (`child`, `level`, …).
**Resolved (alpha):** audited and widened in all 13 channels (see
[Alpha clean-ups](#alpha-clean-ups-deferred-items-2-to-5), item 3).

### F19. Store defaults (low)

`MemoryStore` caps `maxMessagesPerChat` at 1000 by default, while the persistent stores
have no limit unless you set one.

**Decision:** keep. It is deliberate for a RAM-only store; documented in its JSDoc, the store guides and `AGENTS.md`, and `Infinity` disables it. An invalid cap now throws a `RangeError`, like the persistent stores.

### F20. Naming conventions (low)

- `get*` returns one item (`getHandoff`, `getStore`) and `list*` returns all of them
  (`listHandoffs`, `listFlows`, `listConversations`). This is consistent.
- `locales()` and `metrics()` are accessors without `get`. They are kept.
- `telegram.baseUrl` vs `meta.graphUrl`: these are transport-specific names and are kept.
- `Dispatcher{Message,Command}Handler` duplicate `MessageHandler`/`CommandHandler`, but over
  the dispatcher's own context type. They are kept for advanced use.

## Deferred (needs a maintainer decision)

These would be breaking, or they need a wider audit:

1. ~~**Engine internals on the main entry.**~~ **Resolved:** `buildMessageContext`,
   `createControls`, `createPacer`, `runBroadcast`, `runFormStep`, `newFormToken`,
   `resolveFormMode`, `resolveReplyTyping`, `normalizeTypingConfig`, `typingDuration`,
   `parseReplyDelay`, `ExternalSendClock`, `MetricsCollector`, `formatUptime` and
   `TYPING_REFRESH_MS` now live in the `@botmesh/core/internal` subpath (no semver
   guarantee). The main entry still re-exports the same values, each marked `@deprecated`
   on its export specifier, until v3. `node scripts/api-check.cjs deprecated` lists them
   (plus `Config` and `DEFAULT_SCHEMA_MESSAGE`).
2. ~~`stripInternal` per package (F16).~~ Resolved below.
3. ~~Accept `LoggerLike` in the provider configs (F18).~~ Resolved below.
4. ~~`HookHandler<TCtx = unknown>` and narrowing `Plugin.install` to `void` (F13, F15), in
   the next major.~~ Resolved below.
5. ~~Align `triggerFlow`'s `state` with `trigger`'s `data` (F6).~~ Resolved below.

## Alpha clean-ups (deferred items 2 to 5)

The maintainer authorised breaking clean-ups while the alpha is unpublished, as long as
each one is documented. These are **breaking for the alpha**; the `CHANGELOG.md`
`[Unreleased]` section lists them too, and every public package touched has a changeset.
Every type-level claim below was verified with the repo's `tsc` 7 (scratch files, then the
tests in `packages/core/tests/api-deferred.test.ts`, which pin them with
`expectTypeOf` and `// @ts-expect-error`).

Surface after this pass (`node scripts/api-check.cjs surface`): **11 added, 0 removed**
(`@botmesh/core`: `AnyHookHandler`, `HookBeforeContext`, `HookContextMap`, `HookContextOf`,
`HookErrorHandler`, `HookRegistration`, `SendHookContext`, `SyncInstallError`;
`@botmesh/baileys`: `BaileysLogger`, `isBaileysLogger`, `toBaileysLogger`), plus the
members `AIPluginConfig.instance` and `FlowTriggerOptions.data`. `pnpm api-check`
reports 0 findings in every mode.

### 2. `stripInternal` (F16)

**Decision:** `"stripInternal": true` in `tsconfig.base.json`, so every package strips
`@internal` symbols and members from its `.d.ts` (TypeScript 7 honours the flag; verified
by building without it: `api-check internal` then lists `AIPluginConfig.__provider` and the
`RecordingProvider` members, and 0 with it).

Audit of every `@internal` tag in `packages/*/src`: core's flow/describe/schema/media
helpers, `DynamicFlowRegistry`, `FlowRouteLog` and the transcript recorder's internals are
consumed only inside `@botmesh/core` (compiled from `src`); the private packages' tags
(`events`, `manager`, `deployments`' `normalizeGateResult`, `mongo-store`'s
`TRIM_DELETE_BATCH`, `rag`'s clock) are used inside their own package or by its tests
(`tsconfig.test.json` compiles from `src`). The only published leak was
`AIPluginConfig.__provider`, used by `pack:smoke` and `examples/bakery-ai`: it is
**promoted** to the public option `instance` (a ready-built `AIProvider`); `__provider`
stays as a hidden runtime alias (`instance` wins when both are set).

Tooling: `api-check internal` walks the members of every exported declaration
(`INTERNAL member Owner.name`), `api-check missing` reports `DANGLING` references (a kept
signature naming a stripped type), `pnpm api-check` runs the three gates, and
`pack:smoke` greps every packed `.d.ts` for `@internal`. Rule for contributors (in
`AGENTS.md`): an `@internal` symbol is invisible to other packages after the build.

### 3. `LoggerLike` in every provider config (F18)

**Decision:** `logger?: LoggerLike` in all 13 channel configs. pino's `Logger` is
assignable to core's `LoggerLike` (and so is `console`), so existing callers compile
unchanged. Method audit: the providers call only `debug/info/warn/error`; none uses
`child`, `level`, `trace` or `fatal`. The one exception is Baileys itself: `makeWASocket`,
`makeCacheableSignalKeyStore` and `downloadMediaMessage` take its `ILogger` (`level`,
`child`, `trace`), so `@botmesh/baileys` adds `toBaileysLogger()` (a pino-shaped logger
passes through untouched, anything else is wrapped: `trace` forwarded or no-op, `level`
fallback `'info'`, `child()` when available) and the `BaileysLogger` type.
`@botmesh/email` already took a `LoggerLike`; its double cast is gone.

Closed later (same alpha): `core/src/core/bot/compose.ts` no longer casts `BotConfig.logger`
to pino. `toBotLogger()` (`core/src/core/bot/logger.ts`) passes a pino-shaped logger
through untouched and wraps any other `LoggerLike`: `child()` forwards to the logger's own
`child` (or reuses it, dropping the bindings), `trace`/`fatal` are no-ops and the four
levels forward every argument. So `new Bot({ provider, logger: console })` and a custom
`{ debug, info, warn, error }` both construct and log.

### 4. `HookHandler<TCtx = unknown>` and `Plugin.install` narrowed to `void` (F13, F15)

**Decision (hooks):** `HookHandler<TCtx = unknown>`. `bot.before/after/onError/hook` are
generic on the event name and infer the context through the new, augmentable
`HookContextMap` (`message` → `MessageContext`, `send` → `SendHookContext`, `call` →
`CallEvent`, `reaction`, `poll`, `group`, `presence`, `status`, `connection`), so
`bot.before('message', (ctx, next) => ctx.body)` typechecks without an annotation; a
custom event's context is `unknown` unless the handler annotates it, `TCtx` is given or
the map is augmented. New `HookErrorHandler` (`onError` receives `(ctx, error)`),
`SendHookContext`, `HookContextOf`, `HookBeforeContext` and `AnyHookHandler` (the
registry-side type, contravariant `never`). Breaking: a `HookHandler<MessageContext>`
passed to `'send'` is now a compile error (it always was wrong), and an un-annotated
custom-event hook reading `ctx.x` needs an annotation. Every annotated hook in the repo
(supertype annotations such as `{ content: unknown }`, `{ abort(): void }`, `unknown`,
`any`) still compiles. `HookHandler` left `ALLOWED_ANY` in `api-check`.

**Decision (install):** `install(ctx, config?): void | SyncInstallError`, where
`SyncInstallError` is a string-literal type carrying the explanation. `install(): void`
alone would **not** reject `async install()` (TypeScript's void-return rule lets
`() => Promise<void>` satisfy `() => void`), and a generic `definePlugin<T>(spec: T &
AssertSyncInstall<T>)` breaks `definePlugin<AIPluginConfig>({ … })`. With the union,
`async install`, `install: async () => {}`, `install: () => Promise.resolve()`, async
factory results and `class implements PluginSpec { async install() }` all fail with the
message, while sync methods, arrows, classes and factories compile. Runtime routing of a
rejected promise to `'error'` is unchanged (JavaScript plugins); the ESLint rule
`no-async-plugin-install` stays for JavaScript and `as any`, with an updated message.
Breaking: value-returning concise arrows (`install: (ctx) => ctx.bot.when(…)`) are an
error too (none existed in the repo, docs or examples).

### 5. `triggerFlow` `state` → `data` (F6)

**Decision:** `FlowTriggerOptions.data` (the same option as `bot.trigger()`); `state` is
kept as a `@deprecated` alias for the alpha, and passing both (different objects) throws
a `TypeError` before the started-bot check. The `@botmesh/manager` HTTP contract keeps
`state` in the `trigger` body and maps it to `data`.
