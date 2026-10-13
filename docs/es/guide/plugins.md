# Plugins

Los plugins son paquetes reutilizables de funcionalidad.

## Usar un plugin

```ts
import { Bot, slashCommandsPlugin } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({ provider: new BaileysProvider({ session: 'my-bot' }) })

const unplug = bot.plug(slashCommandsPlugin, {
  greeting: '🤖 Hi! Send /help to see my commands.',
})

await bot.start()

// más adelante, si necesitas revertir todo lo que registró el plugin:
// unplug()
```

`bot.plug(plugin, config?)` devuelve una función **unplug** que revierte
cada handler/hook que el plugin registró.

### Incluido: slashCommands

Config: `{ greeting?: string; unknownMessage?: string }`. El prefijo de
comandos es una opción del bot (`new Bot({ commandPrefix })`), no del
plugin.

| Comando | Qué hace |
|---|---|
| `/start` | Muestra el saludo |
| `/help` | Muestra el saludo (alias) |
| `/reset` | Cancela la conversación activa |
| `/cancel` | Cancela la conversación activa (alias de `/reset`) |
| `/id` | Muestra el ID del chat |
| `/ping` | Health check (responde "pong") |

Los `/comandos` desconocidos reciben automáticamente una respuesta de
"comando desconocido" (`unknownMessage`).

## Crear un plugin

### Plugin simple

```ts
import { definePlugin } from '@bot-wa/core'

const loggingPlugin = definePlugin({
  name: 'logging',
  version: '1.0.0',
  description: 'Log every message',
  install(ctx) {
    // ctx.bot        → la instancia de Bot
    // ctx.logger     → logger con pino
    // ctx.tools      → registro de herramientas
    // ctx.config     → configuración pasada a plug()
    // ctx.onDispose  → registra lógica de limpieza

    ctx.bot.before('message', async (c, next) => {
      ctx.logger.info(`📥 ${c.from}: ${c.body}`)
      await next()
    })
  },
})

bot.plug(loggingPlugin)
```

### Plugin configurable con cleanup

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

    // se ejecuta cuando el plugin se desinstala (bot.plug() devolvió unplug())
    ctx.onDispose(() => counts.clear())
  },
})

bot.plug(rateLimitPlugin, { max: 20, windowMs: 60000 })
```

## Estructura de un plugin

```ts
definePlugin({
  name: string,             // nombre único (obligatorio)
  version: string,          // semver (obligatorio)
  description?: string,     // descripción para humanos
  install(ctx, config) {    // se ejecuta al instalar (obligatorio)
    // ctx: { bot, logger, tools, config, onDispose(fn) }
    // regístralo vía ctx.bot.when/command/before/... y usa
    // ctx.onDispose(fn) para cualquier limpieza personalizada
  },
})
```

::: warning `install()` debe ser síncrono
`bot.plug()` no hace `await` de `install()`. Un `install` async que rechace
se convierte en un unhandled rejection que puede tumbar el proceso. Si tu
plugin necesita inicialización async (abrir una conexión, cargar un SDK),
mantén `install` síncrono y resuelve de forma perezosa en el primer uso,
reportando los errores de configuración sin tumbar el bot. Así carga
`@bot-wa/ai` los SDKs de sus proveedores.
:::

## Siguientes pasos

- [Inyección de dependencias](./di) — comparte herramientas entre plugins
- [Ejemplo: rate limiter](/es/ejemplos/rate-limiter) — plugin completo
