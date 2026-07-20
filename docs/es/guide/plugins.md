# Plugins

Los plugins son paquetes reutilizables de funcionalidad. Pueden registrar
hooks, handlers, herramientas o lo que necesites. Empaqueta una vez,
usa en cualquier bot.

## Usar un plugin existente

```js
const { Bot, slashCommandsPlugin } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({ session: 'mi-bot' })

// Instalar con configuración
bot.plug(slashCommandsPlugin, {
  greeting: '🤖 ¡Hola! Envía /help para ver mis comandos.',
})

bot.start()
```

### Plugin incluido: slashCommands

Agrega 5 comandos listos para usar:

| Comando | Qué hace |
|---|---|
| `/start` | Muestra el greeting |
| `/help` | Muestra el greeting (alias) |
| `/reset` | Cancela cualquier flujo activo |
| `/id` | Muestra el ID del chat |
| `/ping` | Health check (responde "pong") |

## Crear un plugin

### Plugin simple

```js
const { definePlugin } = require('@bot-wa/bot-wa-baileys')

const loggingPlugin = definePlugin({
  name: 'logging',
  version: '1.0.0',
  description: 'Log every message',
  install(ctx) {
    // ctx.bot    → la instancia de Bot
    // ctx.logger → logger con pino
    // ctx.tools  → registro de herramientas
    // ctx.config → configuración pasada a plug()

    ctx.bot.before('message', async (c, next) => {
      ctx.logger.info(`📥 ${c.from}: ${c.body}`)
      await next()
    })
  },
})

bot.plug(loggingPlugin)
```

### Plugin configurable

```js
const rateLimitPlugin = definePlugin({
  name: 'rate-limit',
  version: '1.0.0',
  description: 'Limita mensajes por usuario',
  install(ctx, config = {}) {
    const max = config.max ?? 10           // default: 10 mensajes
    const windowMs = config.windowMs ?? 60000  // default: 60 segundos
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
        await c.reply(`⏳ Espera ${Math.ceil((entry.resetAt - now) / 1000)}s`)
        c.abort()
        return
      }

      await next()
    })

    ctx.logger.info(`Rate limit: ${max} msg / ${windowMs / 1000}s`)
  },
})

// Usar con configuración personalizada
bot.plug(rateLimitPlugin, { max: 20, windowMs: 60000 })
```

## Estructura de un plugin

```js
{
  name: string,           // nombre único (obligatorio)
  version: string,        // semver (obligatorio)
  description?: string,   // descripción humana
  requires?: string[],    // dependencias de otros plugins
  install(ctx, config) {  // se ejecuta al instalar (obligatorio)
    // ctx.bot    → Bot
    // ctx.logger → Logger
    // ctx.tools  → herramientas inyectadas
    // ctx.config → config pasada a plug()
  },
  uninstall?(ctx) {       // cleanup opcional
    // ...
  },
}
```

## Publicar un plugin

Crea un paquete npm que exporte el plugin:

```js
// mi-plugin/index.js
module.exports = definePlugin({
  name: 'mi-plugin',
  version: '1.0.0',
  install(ctx, config) {
    // ...
  },
})
```

```json
// mi-plugin/package.json
{
  "name": "bot-wa-mi-plugin",
  "main": "index.js",
  "peerDependencies": {
    "@bot-wa/bot-wa-baileys": "^2.0.0"
  }
}
```

Luego los usuarios lo instalan:

```bash
pnpm add bot-wa-mi-plugin
```

```js
const miPlugin = require('bot-wa-mi-plugin')
bot.plug(miPlugin)
```

## Siguientes pasos

- [Inyección de dependencias](./di) — compartir herramientas entre plugins
- [Ejemplo: rate limiter](/es/ejemplos/rate-limiter) — plugin completo