# Plugin: rate limiter

Un plugin completo que limita cuántos mensajes puede enviar un usuario por
ventana de tiempo.

## El plugin

```ts
import { Bot, definePlugin } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

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

    // El hook before('message') de arriba se desregistra automáticamente
    // cuando se desconecta el plugin. Usa onDispose() para cualquier otra
    // limpieza — aquí, un barrido periódico de contadores expirados.
    const gc = setInterval(() => {
      const now = Date.now()
      for (const [chatId, entry] of counts) {
        if (entry.resetAt < now) counts.delete(chatId)
      }
    }, windowMs)
    ctx.onDispose(() => clearInterval(gc))

    ctx.logger.info(`Rate limit active: ${max} msg / ${windowMs / 1000}s`)
  },
})

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo-bot', qr: { terminal: true, small: true } }),
})

// Configuración por defecto (10 msg / 60s)
const unplug = bot.plug(rateLimitPlugin)

// Configuración personalizada:
// bot.plug(rateLimitPlugin, { max: 20, windowMs: 60000 })

// Más adelante, para quitarlo por completo (desregistra el hook y limpia el interval):
// unplug()

await bot.start()
```

## Cómo funciona

1. Cada remitente tiene un contador con una hora de reinicio (`resetAt`)
2. Cada mensaje entrante incrementa el contador de `msgCtx.from`
3. Si el contador supera `max` dentro de `windowMs`:
   - el bot responde `⏳ Too many messages. Wait Xs.`
   - `msgCtx.abort()` detiene el pipeline — no corre ningún otro handler
     para este mensaje
4. Cuando pasa `resetAt`, el siguiente mensaje arranca una ventana nueva
5. `bot.plug()` devuelve una función `unplug()` que revierte todo lo que el
   plugin registró a través de `ctx.bot` (el hook), más todo lo encolado con
   `ctx.onDispose()` (el interval de limpieza)

## Variantes

### Solo en grupos

```ts
ctx.bot.before('message', async (msgCtx, next) => {
  if (!msgCtx.isGroup) { await next(); return }
  // ... lógica de rate limit ...
})
```

### Con un ban temporal

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

  // ... incrementar el contador por remitente como en "El plugin" arriba ...
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

### Con whitelist

```ts
const whitelist = new Set(['573001112233@s.whatsapp.net'])

ctx.bot.before('message', async (msgCtx, next) => {
  if (whitelist.has(msgCtx.from)) { await next(); return }
  // ... lógica de rate limit ...
})
```

### Limitar los envíos salientes del propio bot

`before('send')` se dispara en cada mensaje saliente (`bot.send`,
`ctx.reply`, `ctx.photo`, ...). Su payload es `{ chatId, content, options }`
(donde `content` es el `OutboundContent` neutral de transporte) y se puede
abortar de la misma forma, saltándose el envío por completo:

```ts
ctx.bot.before('send', async (payload, next) => {
  const now = Date.now()
  let entry = counts.get(payload.chatId)

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs }
    counts.set(payload.chatId, entry)
  }

  entry.count++
  if (entry.count > max) {
    payload.abort() // no se transmite nada para este envío
    return
  }
  await next()
})
```

## Siguientes pasos

- [Plugins](/es/guide/plugins) — guía completa de plugins
- [Hooks](/es/guide/hooks) — middleware y before/after
