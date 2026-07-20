# Plugin: rate limiter

Un plugin completo que limita cuántos mensajes puede enviar un usuario
por ventana de tiempo.

## El plugin

```js
const { definePlugin } = require('@bot-wa/bot-wa-baileys')

const rateLimitPlugin = definePlugin({
  name: 'rate-limit',
  version: '1.0.0',
  description: 'Limita mensajes por usuario — máx N mensajes por ventana',
  install(ctx, config = {}) {
    const max = config.max ?? 10              // default: 10 mensajes
    const windowMs = config.windowMs ?? 60000 // default: 60 segundos
    const counts = new Map()

    ctx.bot.before('message', async (c, next) => {
      const now = Date.now()
      let entry = counts.get(c.from)

      // Crear o resetear ventana
      if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs }
        counts.set(c.from, entry)
      }

      entry.count++

      // Superó el límite
      if (entry.count > max) {
        const espera = Math.ceil((entry.resetAt - now) / 1000)
        await c.reply(`⏳ Estás enviando muchos mensajes. Espera ${espera}s.`)
        c.abort()  // detiene el pipeline
        return
      }

      await next()
    })

    ctx.logger.info(`Rate limit activo: ${max} msg / ${windowMs / 1000}s`)
  },
})

// Usar con configuración por defecto (10 msg / 60s)
bot.plug(rateLimitPlugin)

// O con configuración personalizada
bot.plug(rateLimitPlugin, { max: 20, windowMs: 60000 })
```

## Cómo funciona

1. Cada usuario tiene un contador con una ventana de tiempo
2. Cada mensaje incrementa el contador
3. Si supera `max` mensajes en `windowMs`:
   - El bot responde "⏳ Espera Xs"
   - `c.abort()` detiene el pipeline (no se procesa el mensaje)
4. Cuando pasa la ventana, el contador se reinicia

## Variantes

### Rate limit solo en grupos

```js
ctx.bot.before('message', async (c, next) => {
  if (!c.isGroup) {
    await next()
    return
  }
  // ... lógica de rate limit ...
})
```

### Rate limit con ban temporal

```js
const bans = new Map()

ctx.bot.before('message', async (c, next) => {
  // Verificar si está baneado
  const ban = bans.get(c.from)
  if (ban && ban.until > now) {
    await c.reply(`🚫 Estás bloqueado por ${Math.ceil((ban.until - now) / 1000)}s.`)
    c.abort()
    return
  }

  // ... rate limit normal ...

  if (entry.count > max) {
    // Banear por 5 minutos
    bans.set(c.from, { until: now + 5 * 60 * 1000 })
    await c.reply('🚫 Demasiados mensajes. Bloqueado por 5 minutos.')
    c.abort()
    return
  }

  await next()
})
```

### Rate limit con whitelist

```js
const whitelist = new Set(['57300XXXXXXX@s.whatsapp.net'])

ctx.bot.before('message', async (c, next) => {
  if (whitelist.has(c.from)) {
    await next()
    return
  }
  // ... rate limit normal ...
})
```

## Siguientes pasos

- [Plugins](/es/guide/plugins) — guía completa de plugins
- [Hooks](/es/guide/hooks) — middleware y before/after