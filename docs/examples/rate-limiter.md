# Plugin: Rate Limiter

A complete plugin that limits how many messages a user can send per time window.

## The plugin

```js
const { definePlugin } = require('@bot-wa/bot-wa-baileys')

const rateLimitPlugin = definePlugin({
  name: 'rate-limit',
  version: '1.0.0',
  description: 'Limit messages per user — max N messages per window',
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
        const wait = Math.ceil((entry.resetAt - now) / 1000)
        await c.reply(`⏳ Too many messages. Wait ${wait}s.`)
        c.abort()
        return
      }

      await next()
    })

    ctx.logger.info(`Rate limit active: ${max} msg / ${windowMs / 1000}s`)
  },
})

// Default config (10 msg / 60s)
bot.plug(rateLimitPlugin)

// Custom config
bot.plug(rateLimitPlugin, { max: 20, windowMs: 60000 })
```

## How it works

1. Each user has a counter with a time window
2. Each message increments the counter
3. If they exceed `max` messages in `windowMs`:
   - Bot replies "⏳ Wait Xs"
   - `c.abort()` stops the pipeline
4. When the window passes, the counter resets

## Variants

### Groups only

```js
ctx.bot.before('message', async (c, next) => {
  if (!c.isGroup) { await next(); return }
  // ... rate limit logic ...
})
```

### With temporary ban

```js
const bans = new Map()

ctx.bot.before('message', async (c, next) => {
  const ban = bans.get(c.from)
  if (ban && ban.until > now) {
    await c.reply(`🚫 Blocked for ${Math.ceil((ban.until - now) / 1000)}s.`)
    c.abort()
    return
  }
  // ... rate limit logic ...
  if (entry.count > max) {
    bans.set(c.from, { until: now + 5 * 60 * 1000 })
    await c.reply('🚫 Too many messages. Blocked for 5 minutes.')
    c.abort()
    return
  }
  await next()
})
```

### With whitelist

```js
const whitelist = new Set(['57300XXXXXXX@s.whatsapp.net'])

ctx.bot.before('message', async (c, next) => {
  if (whitelist.has(c.from)) { await next(); return }
  // ... rate limit logic ...
})
```

## Next steps

- [Plugins](/guide/plugins) — full plugin guide
- [Hooks](/guide/hooks) — middleware and before/after