# @botmesh/core

[![Docs](https://img.shields.io/badge/docs-guides-blue)](https://github.com/andresayac/botmesh/tree/main/docs)
[![npm](https://img.shields.io/npm/v/@botmesh/core)](https://www.npmjs.com/package/@botmesh/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/andresayac/botmesh/blob/main/LICENSE.md)

A **transport-agnostic** bot engine: declarative flows to get going in 30 seconds, an async conversation runtime when you need full control, hooks/plugins/DI and a scheduler. You inject the transport (WhatsApp through [`@botmesh/baileys`](https://github.com/andresayac/botmesh/tree/main/packages/baileys-provider); Telegram/Discord use the same `IProvider` contract).

> **v2 is a transport-agnostic rewrite.** If you come from v1 (`BaileysClass`), read the [migration guide](https://github.com/andresayac/botmesh/blob/main/docs/MIGRATION-v1-to-v2.md).

## Installation

```
npm i @botmesh/core@alpha @botmesh/baileys@alpha
```

Requires **Node >= 22** (ESM-only). The core carries no transport dependency — the transport package you pick brings its own.

## Quickstart (30 seconds)

```ts
import { Bot, flow } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

const bot = new Bot({
  provider: new BaileysProvider({
    session: 'my-bot',
    qr: { terminal: true },        // print the QR in the terminal
  }),
})

bot.when('hola', (ctx) => ctx.reply('👋 Hello!'))

bot.use(
  flow('signup')
    .say('📝 Let us sign you up')
    .ask('Your name?', 'name')
    .say((_ctx, c) => `✅ Hi ${c.state.name}`)
)

// Advanced: async conversation with full control
bot.conversation('support', async (c, ctx) => {
  await ctx.reply('Describe your problem')
  const problem = await c.waitText({ timeout: '2m' })
  await ctx.reply(`🎫 Logged: ${problem}`)
})

await bot.start()   // scan the QR
```

A full example (commands, media, hooks, DI, scheduler) lives in [`packages/baileys-provider/examples/bot.ts`](https://github.com/andresayac/botmesh/blob/main/packages/baileys-provider/examples/bot.ts).

No camera? Set `pairingCode: '+57300XXXXXXX'` on `BaileysProvider` (full international format) and listen for `bot.on('qr', ...)` — the pairing code arrives there too.

> **Persistent flows:** `flow(...).persistent()` only survives a restart with a persistent store. The default `MemoryStore` lives in RAM; to keep checkpoints use a disk-backed store (e.g. [`@botmesh/sqlite-store`](https://github.com/andresayac/botmesh/tree/main/packages/sqlite-store)).

## Features (v2)

- **Transport-agnostic engine** — the core knows nothing about WhatsApp: `IProvider` normalizes input (`InboundEvent`) and output (`OutboundContent`); each transport resolves its own identity internally.
- **Declarative flows that compile to an async runtime** — `flow().say().ask().choose()` compiles to a real `bot.conversation`.
- **Dispatcher by specificity** — commands (`/reset`) > active conversation > matchers (normalized `equals` by default, or `contains`/`startsWith`/`endsWith`) > catch-all.
- **Async conversation runtime** — `c.ask`, `c.waitText`, `c.waitMedia`, `c.waitLocation`, `c.choose`, with validation, retries and per-wait timeouts.
- **Projected interactions** — button/slash clicks arrive as a `type: 'buttons'` message with `ctx.acknowledge()` (no-op on WhatsApp).
- **Runtime config validation** — the constructor throws `ConfigValidationError` with a clear message.
- **Group mode** — `config.groupMode: 'all' | 'mentions' | 'commands'`.
- **Graceful shutdown with drain** — `bot.stop({ drain: true })` waits for in-flight sends.
- **Testing kit without a real transport** — `createTestBot()` from `@botmesh/core/testing`, with a v2 `MockProvider` and assertions over the outbox.
- **Hooks and plugins with DI** — `before`/`after`/`onError`, `bot.plug()`/`unplug()`, `bot.provide()`.
- **Built-in scheduler** — `bot.schedule()` (cron), `bot.every()`, `bot.delay()`.
- **100% ESM + strict TypeScript.**

> Note: the WhatsApp management sub-APIs (`bot.groups/profile/privacy/chats/presence`) moved to the transport and will be re-exposed as provider namespaces soon.

## Persistent store (SQLite)

The default `MemoryStore` is ideal for development. For production use the [`@botmesh/sqlite-store`](https://github.com/andresayac/botmesh/tree/main/packages/sqlite-store) package:

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'
import { SQLiteStore } from '@botmesh/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})
```

## Group mode

```ts
const bot = new Bot({
  provider,
  groupMode: 'mentions',  // only answer when @mentioned
  // groupMode: 'commands',  // only answer commands
  // groupMode: 'all',       // answer everything (default)
})
```

## Documentation

- [Migration guide v1 → v2](https://github.com/andresayac/botmesh/blob/main/docs/MIGRATION-v1-to-v2.md)
- API (TypeDoc): generate it locally with `pnpm docs:api` (output in `docs/api/`)

## Acknowledgements

Inspired by ideas and code from [bot-whatsapp](https://github.com/codigoencasa/bot-whatsapp) by codigoencasa.

## License

[MIT](https://github.com/andresayac/botmesh/blob/main/LICENSE.md) © Andres Aya
