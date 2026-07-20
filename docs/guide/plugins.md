# Plugins

Plugins are reusable packages of functionality.

## Use a plugin

```js
const { Bot, slashCommandsPlugin } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({ session: 'my-bot' })

bot.plug(slashCommandsPlugin, {
  greeting: '🤖 Hi! Send /help to see my commands.',
})

bot.start()
```

### Built-in: slashCommands

| Command | What it does |
|---|---|
| `/start` | Shows the greeting |
| `/help` | Shows the greeting (alias) |
| `/reset` | Cancels any active flow |
| `/id` | Shows the chat ID |
| `/ping` | Health check (responds "pong") |

## Create a plugin

### Simple plugin

```js
const { definePlugin } = require('@bot-wa/bot-wa-baileys')

const loggingPlugin = definePlugin({
  name: 'logging',
  version: '1.0.0',
  description: 'Log every message',
  install(ctx) {
    // ctx.bot    → Bot instance
    // ctx.logger → pino logger
    // ctx.tools  → tools registry
    // ctx.config → config passed to plug()

    ctx.bot.before('message', async (c, next) => {
      ctx.logger.info(`📥 ${c.from}: ${c.body}`)
      await next()
    })
  },
})

bot.plug(loggingPlugin)
```

### Configurable plugin

```js
const rateLimitPlugin = definePlugin({
  name: 'rate-limit',
  version: '1.0.0',
  install(ctx, config = {}) {
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
  },
})

bot.plug(rateLimitPlugin, { max: 20, windowMs: 60000 })
```

## Plugin structure

```js
{
  name: string,           // unique name (required)
  version: string,        // semver (required)
  description?: string,   // human description
  requires?: string[],    // other plugin dependencies
  install(ctx, config) {  // runs on install (required)
    // ctx.bot, ctx.logger, ctx.tools, ctx.config
  },
  uninstall?(ctx) {       // optional cleanup
  },
}
```

## Next steps

- [Dependency injection](./di) — share tools between plugins
- [Example: rate limiter](/examples/rate-limiter) — full plugin