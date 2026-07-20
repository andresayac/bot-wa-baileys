# Plugin: Rate Limiter

A complete plugin that limits how many messages a user can send per time window.

## The plugin

```ts
import { Bot, definePlugin } from '@bot-wa/bot-wa-baileys'

interface RateLimitConfig {
  max?: number
  windowMs?: number
}

const rateLimitPlugin = definePlugin<RateLimitConfig>({
  name: 'rate-limit',
  version: '1.0.0',
  description: 'Limit messages per user — max N messages per window',
  install(ctx, config = {}) {
    const max = config.max ?? 10
    const windowMs = config.windowMs ?? 60000
    const counts = new Map<string, { count: number; resetAt: number }>()

    ctx.bot.before('message', async (msgCtx, next) => {
      const now = Date.now()
      let entry = counts.get(msgCtx.from)

      if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs }
        counts.set(msgCtx.from, entry)
      }

      entry.count++

      if (entry.count > max) {
        const wait = Math.ceil((entry.resetAt - now) / 1000)
        await msgCtx.reply(`⏳ Too many messages. Wait ${wait}s.`)
        msgCtx.abort()
        return
      }

      await next()
    })

    // The before('message') hook above is unregistered automatically when the
    // plugin is unplugged. Use onDispose() for anything else that needs
    // cleanup — here, a periodic sweep of expired counters.
    const gc = setInterval(() => {
      const now = Date.now()
      for (const [jid, entry] of counts) {
        if (entry.resetAt < now) counts.delete(jid)
      }
    }, windowMs)
    ctx.onDispose(() => clearInterval(gc))

    ctx.logger.info(`Rate limit active: ${max} msg / ${windowMs / 1000}s`)
  },
})

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

// Default config (10 msg / 60s)
const unplug = bot.plug(rateLimitPlugin)

// Custom config:
// bot.plug(rateLimitPlugin, { max: 20, windowMs: 60000 })

// Later, to fully remove it (unregisters the hook and clears the interval):
// unplug()

await bot.start()
```

## How it works

1. Each sender gets a counter with a reset time (`resetAt`)
2. Every incoming message increments the counter for `msgCtx.from`
3. If the counter exceeds `max` within `windowMs`:
   - the bot replies `⏳ Too many messages. Wait Xs.`
   - `msgCtx.abort()` stops the pipeline — no other handler runs for this message
4. Once `resetAt` passes, the next message starts a fresh window
5. `bot.plug()` returns an `unplug()` function that reverts everything the
   plugin registered through `ctx.bot` (the hook), plus anything queued with
   `ctx.onDispose()` (the GC interval)

## Variants

### Groups only

```ts
ctx.bot.before('message', async (msgCtx, next) => {
  if (!msgCtx.isGroup) { await next(); return }
  // ... rate limit logic ...
})
```

### With a temporary ban

```ts
const bans = new Map<string, { until: number }>()

ctx.bot.before('message', async (msgCtx, next) => {
  const now = Date.now()
  const ban = bans.get(msgCtx.from)
  if (ban && ban.until > now) {
    await msgCtx.reply(`🚫 Blocked for ${Math.ceil((ban.until - now) / 1000)}s.`)
    msgCtx.abort()
    return
  }

  // ... increment the per-sender counter as in "The plugin" above ...
  const entry = counts.get(msgCtx.from)!
  if (entry.count > max) {
    bans.set(msgCtx.from, { until: now + 5 * 60 * 1000 })
    await msgCtx.reply('🚫 Too many messages. Blocked for 5 minutes.')
    msgCtx.abort()
    return
  }
  await next()
})
```

### With a whitelist

```ts
const whitelist = new Set(['573001112233@s.whatsapp.net'])

ctx.bot.before('message', async (msgCtx, next) => {
  if (whitelist.has(msgCtx.from)) { await next(); return }
  // ... rate limit logic ...
})
```

### Limit the bot's own outbound sends

`before('send')` fires for every outbound message (`bot.send`, `ctx.reply`,
`ctx.photo`, ...). Its payload is `{ jid, content, options }` and it can be
aborted the same way, skipping the send entirely:

```ts
ctx.bot.before('send', async (payload, next) => {
  const now = Date.now()
  let entry = counts.get(payload.jid)

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs }
    counts.set(payload.jid, entry)
  }

  entry.count++
  if (entry.count > max) {
    payload.abort() // nothing gets transmitted for this send
    return
  }
  await next()
})
```

## Next steps

- [Plugins](/guide/plugins) — full plugin guide
- [Hooks](/guide/hooks) — middleware and before/after
