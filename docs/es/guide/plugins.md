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

`bot.plug(plugin, config?)` devuelve una función **unplug** (no el bot, así
que las llamadas a `plug()` no se encadenan). Al llamarla, primero ejecuta el
`uninstall(ctx)` del plugin, si lo tiene, y después revierte, de lo más nuevo
a lo más antiguo, lo que el plugin registró vía `ctx.bot`:

- comandos (`command()`), matchers (`when()`, `onMessage()`, `onType()`),
  conversaciones y disparadores de flows (`conversation()`, `use(flow)`);
- hooks (`before()`, `after()`, `onError()`, `hook()`);
- plugins anidados (`ctx.bot.plug()` / `ctx.bot.use(plugin)`);
- flows registrados en caliente con `ctx.bot.registerFlow()`, o creados (no
  reemplazados) con `ctx.bot.replaceFlow()`;
- cada callback de `ctx.onDispose(fn)`.

**No** deshace nada más: listeners de eventos (`ctx.bot.on()` / `once()`),
herramientas inyectadas (`ctx.bot.provide()` / `ctx.tools`), mensajes de
idioma (`ctx.bot.locale()`), tareas programadas (`schedule()`, `every()`,
`delay()`), handlers de inactividad (`onIdle()`), un flow que `replaceFlow()`
sobrescribió (no se restaura), el estado de handoff, escrituras en el store ni
timers o conexiones propios. Deshazlos en `ctx.onDispose()` (o en
`uninstall()`). Llamar a unplug dos veces no hace nada. Si `install()` lanza de
forma síncrona, lo que alcanzó a registrar se revierte antes de que el error te
llegue; si devuelve una promesa que rechaza, el rechazo va al evento `'error'`
y no se revierte nada.

### Dependencias entre plugins (`requires`)

Un plugin puede listar por nombre los plugins que necesita. `bot.plug()` los
comprueba antes de ejecutar `install()` y lanza un error descriptivo si falta
alguno:

```ts
const crm = definePlugin({ name: 'crm', version: '1.0.0', requires: ['inbox'], install(ctx) { /* … */ } })

bot.plug(crm)                        // Error: Plugin "crm" requires plugin(s) "inbox", which is not plugged…

const unplugInbox = bot.plug(inbox)  // ok: primero la dependencia...
const unplugCrm = bot.plug(crm)      // ...y después el plugin que la requiere
// plug() devuelve una función unplug, no el bot: una llamada por plugin, sin encadenar
```

La comprobación solo ocurre al enchufar: desenchufar `inbox` después no
desenchufa `crm`. Un plugin anidado dentro de otro (`ctx.bot.plug()` desde
`install()`) puede requerir a su padre.

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
  requires?: string[],      // plugins que deben estar enchufados antes
  install(ctx, config) {    // se ejecuta al instalar (obligatorio)
    // ctx: { bot, logger, tools, config, onDispose(fn) }
    // regístralo vía ctx.bot.when/command/before/... y usa
    // ctx.onDispose(fn) para cualquier limpieza personalizada
  },
})
```

::: warning `install()` debe ser síncrono
`bot.plug()` no hace `await` de `install()`: el bot sigue antes de que un
`install` async termine y su rechazo solo llega al evento `'error'` (en
versiones anteriores del core tumbaba el proceso): no se revierte nada y el
plugin cuenta como enchufado. Si tu
plugin necesita inicialización async (abrir una conexión, cargar un SDK),
mantén `install` síncrono y resuelve de forma perezosa en el primer uso,
reportando los errores de configuración sin tumbar el bot. Así carga
`@bot-wa/ai` los SDKs de sus proveedores.
:::

## Paquetes de plugins

Además de `slashCommandsPlugin`, estos paquetes traen plugins listos:

- [IA](/es/guide/ai) — `@bot-wa/ai`: respuestas con LLM (`aiPlugin`), con
  [herramientas](/es/guide/ai-herramientas),
  [memoria y RAG](/es/guide/ai-memoria-rag) y
  [streaming](/es/guide/streaming).
- [Voz](/es/guide/voz) — el experimental `@bot-wa/voice` (`voicePlugin`):
  voz a texto para las notas de voz entrantes y respuestas con texto a voz.
- [Integraciones](/es/guide/integraciones) — los experimentales
  `@bot-wa/chatwoot`, `@bot-wa/tickets`, `@bot-wa/moderation` y
  `@bot-wa/dialogflow`.

## Siguientes pasos

- [Inyección de dependencias](./di) — comparte herramientas entre plugins
- [Ejemplo: rate limiter](/es/ejemplos/rate-limiter) — plugin completo
