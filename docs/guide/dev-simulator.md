# Terminal simulator (`botmesh dev`)

`botmesh dev` lets you chat with your bot in the terminal: no WhatsApp
number, no phone and no ban risk. It injects an in-memory provider, so
nothing leaves the process, and it hot-reloads your code when you save.

```bash
npx botmesh dev src/bot.js
```

The `botmesh` command ships with `@botmesh/core`. Projects generated with
`create-botmesh` already have it as `npm run dev`.

## 1. The factory pattern (`defineBot`)

Your module default-exports a **factory** that receives the provider and
returns the `Bot` without starting it. Whoever runs the file decides which
provider to inject:

```js
// src/bot.js
import { Bot, defineBot, flow, isMainModule } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

const createBot = defineBot((provider) => {
  const bot = new Bot({ provider })           // ALWAYS use the provider you receive
  bot.when('hola', (ctx) => ctx.reply('Hi! 👋'))
  bot.use(flow('menu').ask('Your name?', 'name').say((_ctx, c) => `Hi ${c.state.name}`))
  return bot                                   // do not call bot.start() here
})
export default createBot

// npm start (node src/bot.js) → real provider. botmesh dev only imports the factory.
if (isMainModule(import.meta)) {
  const bot = await createBot(new BaileysProvider({ session: 'my-bot' }))
  bot.on('qr', (qr) => bot.logger.info(qr))
  await bot.start()
}
```

- The factory can be async (`async (provider) => { ... }`).
- `isMainModule(import.meta)` uses `import.meta.main` (Node ≥ 22.18 / 24.2)
  or compares `process.argv[1]` (case-insensitive on Windows). It is
  `false` when a process manager imports your file from its own wrapper
  (pm2 in ESM mode); in that case use a separate start file that imports
  the factory.
- `botmesh dev` sets the environment variable `BOT_WA_DEV=1` in case your
  code needs to detect the simulator.

## 2. Usage

```bash
npx botmesh dev src/bot.js                       # or "npm run dev" in create-botmesh projects
npx botmesh dev src/bot.js --env-file .env       # load variables (e.g. ANTHROPIC_API_KEY for @botmesh/ai)
npx botmesh dev src/bot.ts                       # TypeScript through Node's native type stripping
npx botmesh dev src/bot.js --user ana --name "Ana" --group team --no-watch
```

| Option | Meaning |
| --- | --- |
| `--user <id>` | simulated sender id (default `user`) |
| `--name <name>` | simulated display name (default `Dev User`) |
| `--group <id>` | start inside group chat `<id>` |
| `--env-file <path>` | load environment variables from a file; repeatable; a missing file only warns |
| `--watch <dir>` | folder to watch for hot reload (default: the entry's folder) |
| `--no-watch` | disable hot reload (`:reload` still works) |
| `--color` / `--no-color` | force colours on or off (default: auto; `NO_COLOR` is respected) |
| `-h`, `-v` | help, version |

Exit codes: `0` ok, `1` runtime failure, `2` usage error.

## 3. Commands inside the simulator

- Any line is a message to the bot. Slash commands (`/reset`) are sent as
  messages.
- `::text` sends text that starts with `:`. An emoticon like `:)` is a
  normal message.
- `:as <user> [name]` switches the sender (stays in the same chat).
- `:group <id>` moves into a group chat; mention the bot as `@bot`. `:dm`
  goes back to the private chat.
- `:media <image|video|audio|voice|document|sticker> <path> [caption]` sends
  a file from disk (aliases: `photo`, `doc`, `file`, `ptt`; quote paths with
  spaces). The bytes arrive through `provider.downloadMedia(ref)`.
- `:click <n|id|label>` taps a button, list row or card button, or votes on
  the last poll (it reaches `bot.on('poll')`).
- `:state` shows who you are, the bot status and the live conversation
  (whether it is waiting for an answer, and its `c.state`).
- `:reset` restarts the bot from scratch (drops conversations and
  in-memory state). `:reload` re-imports your code. `:help`, `:quit` (also
  Ctrl+C or Ctrl+D).

Buttons, lists, cards and polls print numbered (`[1] Info`); media prints
as `[image: url]` with the caption on the next line. Messages the bot sends
to other chats print as `bot → <chatId> › ...`.

When input is piped (`printf 'hola\n' | npx botmesh dev src/bot.js --no-watch`),
each line waits until the bot has finished reacting (up to 30 s, to cover AI
calls), so transcripts stay in order.

## 4. Hot reload

- Saving a `.js/.mjs/.cjs/.ts/.mts/.cts/.jsx/.tsx` file in the watched
  folder stops the current bot (`bot.stop()`), re-imports the entry and
  builds a new bot. Relative imports (`./flows/menu.js`) reload too;
  packages (`@botmesh/core`, `node_modules`) do not.
- `node_modules`, dot-folders, `sessions/`, `*_sessions`, `.json`, `.env`
  and logs are ignored, so writing a store or credentials never loops.
- If a reload fails (e.g. a syntax error), the previous version keeps
  running. In-memory conversations are lost on reload.
- Node cannot unload old modules, so memory grows in very long sessions:
  restart now and then. Close resources you create outside the bot
  (servers, intervals) in `bot.on('stopped', ...)`.

## 5. TypeScript

- It needs Node's native type stripping: on by default in Node ≥ 22.18 /
  23.6. On Node 22.6–22.17 run
  `NODE_OPTIONS=--experimental-strip-types npx botmesh dev src/bot.ts`.
- Relative imports must use the real `.ts` extension and type-only imports
  must use `import type`. No TSX, enums or namespaces (unless you enable
  transform-types).
- When support is missing, the CLI prints these options instead of a
  cryptic error.

## 6. Safety

- If the factory builds the `Bot` with a provider other than the one it
  receives, the simulator refuses to start it (it could connect for real),
  stops that bot and halts: it never calls the factory again, and in watch
  mode the CLI exits with code 1.
- A default export not created with `defineBot()` gets a one-time warning.
- If the entry runs but does not export a factory (an old `bot.js` that
  starts itself on import), `botmesh dev` exits, even in watch mode, to close
  any real connection it opened.

## 7. Programmatic API (`@botmesh/core/dev`)

```ts
import { DevSession } from '@botmesh/core/dev'

const session = new DevSession({ load: () => import('./bot.js'), write: (t) => process.stdout.write(t) })
await session.start()
await session.handleLine('hola')
await session.handleLine(':state')
await session.stop()
```

- `DevSession` does no I/O itself; inject `load` and `write`. Options
  include `user`, `name`, `group`, `echo`, `settleMs`/`maxSettleMs` and
  `onHalt`.
- `DevProvider` extends `MockProvider` with `onOutbound`, `injectMedia` and
  `injectPollVote`.
- Pure helpers are exported too: `renderOutbound`, `parseDevInput`,
  `watchForChanges`, and `runCli(argv, io)` with injectable streams.

Related core additions: `bot.inspectConversation({ from, sender, isGroup })`
returns `{ key, state, waiting, queued, accepts? }` or `undefined` (`state` is a
shallow copy; `accepts` says what the pending wait takes: `'text'`, a list of
message types for `waitMedia`, or `'any'` for `choose`/`waitAny`), and `bot.isBusy()` tells whether the bot is still handling
an event or running a conversation step.

## Next steps

- [Testing](./testing)
- [Inspect & lint flows](./flow-tools)
