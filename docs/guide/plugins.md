# Plugins

Plugins are reusable packages of functionality.

## Use a plugin

```ts
import { Bot, slashCommandsPlugin } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({ provider: new BaileysProvider({ session: 'my-bot' }) })

const unplug = bot.plug(slashCommandsPlugin, {
  greeting: '🤖 Hi! Send /help to see my commands.',
})

await bot.start()

// later, if you need to revert everything the plugin registered:
// unplug()
```

`bot.plug(plugin, config?)` returns an **unplug** function that reverts
every handler/hook the plugin registered.

### Built-in: slashCommands

Config: `{ greeting?: string; unknownMessage?: string }`. The command
prefix itself is a bot option (`new Bot({ commandPrefix })`), not a plugin
option.

| Command | What it does |
|---|---|
| `/start` | Shows the greeting |
| `/help` | Shows the greeting (alias) |
| `/reset` | Cancels the active conversation |
| `/cancel` | Cancels the active conversation (alias of `/reset`) |
| `/id` | Shows the chat ID |
| `/ping` | Health check (responds "pong") |

Unknown `/commands` get an automatic "unknown command" reply
(`unknownMessage`).

## Create a plugin

### Simple plugin

```ts
import { definePlugin } from '@bot-wa/core'

const loggingPlugin = definePlugin({
  name: 'logging',
  version: '1.0.0',
  description: 'Log every message',
  install(ctx) {
    // ctx.bot        → Bot instance
    // ctx.logger     → pino logger
    // ctx.tools      → tools registry
    // ctx.config     → config passed to plug()
    // ctx.onDispose  → register teardown logic

    ctx.bot.before('message', async (c, next) => {
      ctx.logger.info(`📥 ${c.from}: ${c.body}`)
      await next()
    })
  },
})

bot.plug(loggingPlugin)
```

### Configurable plugin with cleanup

```ts
const rateLimitPlugin = definePlugin({
  name: 'rate-limit',
  version: '1.0.0',
  install(ctx, config: { max?: number; windowMs?: number } = {}) {
    const max = config.max ?? 10
    const windowMs = config.windowMs ?? 60000
    const counts = new Map()

    ctx.bot.before('message', async (c, next) => {
      const now = Date.now()
      let entry = counts.get(c.from)

      if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs }
        counts.set(c.from, entry)
      }

      entry.count++
      if (entry.count > max) {
        await c.reply(`⏳ Wait ${Math.ceil((entry.resetAt - now) / 1000)}s`)
        c.abort()
        return
      }

      await next()
    })

    // runs when this plugin is unplugged (bot.plug() returned unplug())
    ctx.onDispose(() => counts.clear())
  },
})

bot.plug(rateLimitPlugin, { max: 20, windowMs: 60000 })
```

## Plugin structure

```ts
definePlugin({
  name: string,             // unique name (required)
  version: string,          // semver (required)
  description?: string,     // human description
  install(ctx, config) {    // runs on install (required)
    // ctx: { bot, logger, tools, config, onDispose(fn) }
    // register via ctx.bot.when/command/before/... and use
    // ctx.onDispose(fn) for any custom teardown
  },
})
```

::: warning `install()` must be synchronous
`bot.plug()` does not `await` `install()`. An `async install` that rejects
becomes an unhandled rejection that can take the process down. If your
plugin needs async setup (open a connection, load an SDK), keep `install`
synchronous and resolve lazily on first use, reporting configuration errors
without crashing. That's how `@bot-wa/ai` loads its provider SDKs.
:::

## Plugin packages

Besides `slashCommandsPlugin`, these packages ship ready-made plugins:

- [AI](/guide/ai) — `@bot-wa/ai`: LLM replies (`aiPlugin`), with
  [tools](/guide/ai-tools), [memory and RAG](/guide/ai-memory-rag) and
  [streaming](/guide/streaming).
- [Voice](/guide/voice) — experimental `@bot-wa/voice` (`voicePlugin`):
  speech-to-text for inbound voice notes and text-to-speech replies.
- [Integrations](/guide/integrations) — experimental `@bot-wa/chatwoot`,
  `@bot-wa/tickets`, `@bot-wa/moderation` and `@bot-wa/dialogflow`.

## Next steps

- [Dependency injection](./di) — share tools between plugins
- [Example: rate limiter](/examples/rate-limiter) — full plugin
