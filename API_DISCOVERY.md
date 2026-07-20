# 🧬 BRIEFING — API Pública v2.0 (Discovery)

> **Decisión clave del usuario:**
> - ❌ Quitar toda dependencia/coupling con `bot-whatsapp`.
> - ✅ Mantener nombre del paquete `@bot-wa/bot-wa-baileys`.
> - ✅ Renacimiento: el paquete se vuelve un **framework WhatsApp basado en Baileys**, no un provider.
>
> Este documento es el **discovery** antes de escribir nada de código. Define la API pública completa que iré a implementar. Sin esto, tirar código sería a ciegas.

- **Fecha:** 2026-07-18
- **Versión objetivo:** `2.0.0` (renombrada v1.1.5 → pool v2 con nueva API)
- **Stance:** breaking changes aceptados en v2. El usuario bot-whatsapp queda fuera (fue "pruebas").

---

## 🎯 Principios de diseño (no negociables)

1. **Zero-config por defecto.** `new Bot()` arranca con defaults sanos. Plug-and-play.
2. **Progressive disclosure.** Novato: 5 líneas. Pro: hooks y plugins. Creador: define plugins.
3. **TypeScript estricto.** Cero `any` en API pública. Inferencia total.
4. **Unopinionated.** El bot no decide por ti. Defaults sencillos, todo sobreescribible.
5. **Composable.** Todo es un plugin (incluso core features son plugins internos).
6. **Sin acoplamiento externo.** Cero dependencias de otros frameworks del ecosistema.
7. **Lo que财税a:** simples flows declarativos. Lo difícil:基建/media/store están abstraídos.

---

## 🧱 Caja de construcción — piezas para exponer

```
Bot                     Orquestador principal (entry point)
├── Events              EventRegistry nativo de WhatsApp + custom
├── Hooks              before / after / error pipeline
├── Plugins            use(plugin) — sistema modular
├── Flows              addKeyword()... DSL v2 con .choose/.timeout/etc
├── Scheduler          Cron + time-based (every, delay, schedule)
├── StoreAdapter       Memory | SQLite | Redis | Postgres | Mongo
├── Media              ImageProcessor / AudioProcessor / StickerProcessor
├── Provider           BaileysProvider (socket WhatsApp)
├── Keyboard          Menús HMIC en mensajes (interactive)
├── ContextManager     Memoria conversacional + summarization
├── I18n               Multi-idioma con auto-detect
└── Dashboard          UI web opcional (URL magic route)
```

---

## 🔌 API Pública — Documento de descubrimiento

### 1) Instanciación

```ts
import { Bot } from '@bot-wa/bot-wa-baileys'

// === Zero config ===
const bot = new Bot()
// → crea session 'default' en './sessions/' (auto-default)
// → emite QR por terminal automáticamente
// → store en memoria
// → Ta listo en 5 segundos

// === Con config ===
const bot = new Bot({
  session: 'mi-bot',
  sessionsDir: './data/sessions',
  store: 'memory',                        // | 'sqlite' | 'redis' | custom
  storeConfig: { /* depende del tipo */ },
  qr: { terminal: true, file: false },    // cómo pintar el QR
  PairingCode: '+57300XXXXXXX',           // opcional, alternativa al QR
  reconnect: true,                        // auto-reconnect default
  markOnlineOnConnect: false,             // no robar push notifications
  browser: 'macOS',                       // identidad del linked device
  debug: false,
})

await bot.start()   // ⭐ explícito — new Bot() no conecta solo
await bot.stop()
```

**¿Por qué explícito `bot.start()`?** Porque permite:
- Configurar hooks/plugins ANTES de conectar.
- Inicializar store async (DB) antes de mensajes.
- Tests sin conexión real.

### 2) API declarativa — el "hello world"

```ts
// Pattern 1: hears/reply (estilo Telegram bot)
bot.hears('hola', async (ctx) => {
  await ctx.reply('¡Hola! 👋')
})

// Pattern 2: regex
bot.hears(/\/ayuda|help/i, helpFlow)

// Pattern 3: keywords array
bot.hears(['buenos días', 'good morning'], morningFlow)

// Pattern 4: callback directo
bot.hears('foto', (ctx) => ctx.replyPhoto('./foto.png'))
bot.hears('audio', (ctx) => ctx.replyAudio('./notificacion.mp3'))
bot.hears('ubicacion', (ctx) =>
  ctx.replyLocation(4.7110, -74.0721, 'Bogotá')
)

// Pattern 5: anything (catch-all)
bot.onMessage(async (ctx) => {
  console.log('No matched:', ctx.body)
})

// Pattern 6: tank de tipos de mensaje
bot.onImage(async (ctx) => {/* ctx.media: Buffer */})
bot.onAudio(async (ctx) => {/* ... */})
bot.onVideo/onDocument/onLocation/onContact/onSticker
```

### 3) API con flows (DSL v2)

```ts
import { addKeyword } from '@bot-wa/bot-wa-baileys'

const supportFlow = addKeyword('soporte')
  .answer('🛠️ Bienvenido al soporte. ¿Cuál es tu nombre?', { capture: true })
  .answer(async (ctx, { state }) => {
    state.set('name', ctx.body)
    return `Gracias ${ctx.body}, describe tu problema`
  }, { capture: true, validate: (s) => s.length > 10 })
  .choose({
    '1': () => flowNivel1,
    '2': () => flowNivel2,
    default: (ctx) => ctx.reply('Opción inválida')
  })
  .timeout(60_000, '⏰ Su sesión caducó.Adiós.')
  .fallback((ctx) => ctx.reply('No entendí. Usa 1 o 2.'))
  .end()                                   // marca fin del flow

bot.use(supportFlow)
```

**Features nuevas key:**
- `.answer(media)` — admite media (image/video/audio/file/url/base64) ✅ _v1 no lo tenía_
- `.choose({...})` — menú condicional tipo switch ✅ _v1 no lo tenía_
- `.timeout(ms, msg)` — auto-exit con mensaje ✅ _v1 no lo tenía_
- `.fallback(fn)` — cuando usuario se va off-topic ✅ _v1 no lo tenía_
- `.validate(fn, msg?)` — validación de input capturado
- `.end()` — fin explícito (sin esto, flow sigue hasta ultima answer)
- `.persistent()` — el estado sobrevive reinicios (requiere store)
- `.effect(fn)` — side-effects (HTTP, DB) sin responder nada
- `.child(flow)` / `.parent(flow)` — anidación

### 4) Hooks — el corazón de plugins

```ts
// before: puede mutar payload o abortar
bot.before('message', async (ctx, next) => {
  console.log('IN:', ctx.body, ctx.from)
  if (await isBlacklisted(ctx.from)) return ctx.abort()
  await next()
})

// after: post-procesamiento
bot.after('message', async (ctx) => {
  metrics.increment('messages.processed')
})

// error handling
bot.onError('message', async (ctx, error) => {
  await ctx.reply('Ups, algo falló 😅')
  console.error(error)
})

// sobre send
bot.before('send', async (ctx) => {
  ctx.payload.text = censorBadWords(ctx.payload.text)
})

// hooks multipropósito
bot.hook('group.participant.add', async (ctx) => {
  await ctx.replyToGroup(`Bienvenido @${ctx.participant}`)
})

// plugin creator pattern
export function loggingPlugin(options = {}) {
  return definePlugin({
    name: 'logger',
    version: '1.0.0',
    install(bot) {
      bot.before('message', async (ctx, next) => {
        bot.logger.info({ in: ctx.body, from: ctx.from })
        await next()
      })
    }
  })
}

bot.use(loggingPlugin({ level: 'debug' }))
```

### 5) Plugins

```ts
export interface BotPlugin {
  name: string
  version: string
  install(bot: Bot, config?: any): void | Promise<void>
  uninstall?(bot: Bot): void
}

// Helpers
definePlugin(spec): BotPlugin
plugin.name.install(bot)

// Built-in plugins que existirán (algunos en este repo, otros como paquetes aparte)
- groupsPlugin        // gestión de grupos como API colonial
- scheduler           // cron
- securityPlugin      // blocklist, rate-limit, validation
- messagesPlugin      // history tracking avanzado
- presencePlugin      // subscripción a typing/online
- aiPlugin            // openai-compatible (separado @bot-wa/ai)
- dashboardPlugin     // web UI (separado @bot-wa/dashboard)
- sqlitePlugin        // store (separado)
- redisPlugin         // store (separado)
```

### 6) Scheduler — cosa simple

```ts
// Cron
bot.schedule('0 9 * * 1-5', async () => {
  await bot.broadcast(['521@x', '571@y'], 'Buenos días ☕')
})

// Every
bot.every('hour', async () => maintenanceCheck())
bot.every('5 minutes', checkStock)

// Una vez
bot.delay('2 hours', followUp)

// Recurrente con condición
bot.repeatUntil(async (stop) => {
  if (await isResolved()) stop()
  else await notify('Aún esperando...')
}, { interval: '1 minute', maxAttempts: 30 })
```

### 7) Context — el objeto del usuario

```ts
interface MessageContext {
  // Datos del mensaje
  body: string
  from: string                          // jid normalizado
  fromMe: boolean
  isGroup: boolean
  key: WAMessageKey
  rawMessage: proto.IWebMessageInfo     // original de Baileys
  media?: { buffer: Buffer; mimetype: string; filename?: string }
  mentions: string[]
  quoted?: MessageContext
  
  // Datos del chat
  chat: { id, name, isGroup, participants? }
  
  // Datos del emisor
  sender: { id, name, pushName, isBusiness?, isBot? }
  
  // Helpers — todos async, devuelven Promise
  reply(text | media): Promise<SentMessage>
  replyText(text): Promise<SentMessage>
  replyPhoto(source, caption?): Promise<SentMessage>
  replyVideo(source, caption?): Promise<SentMessage>
  replyAudio(source): Promise<SentMessage>
  replyFile(source, filename?): Promise<SentMessage>
  replySticker(source): Promise<SentMessage>
  replyLocation(lat, lng, name?): Promise<SentMessage>
  replyContact(phone, name?): Promise<SentMessage>
  replyPoll(question, options[]): Promise<SentMessage>
  replyReaction(emoji): Promise<SentMessage>
  replyWithTyping(text, msPerChar?: number): Promise<SentMessage>
  
  // Acciones del chat
  markRead(): Promise<void>
  sendTyping(): Promise<void>
  sendRecording(): Promise<void>
  react(emoji): Promise<void>
  delete(): Promise<void>                  // borra el mensaje recibido
  
  // Tools inyectados por plugins (ver abajo)
  tools: Record<string, any>
  
  // Flow control
  abort(): void
  next?: () => Promise<void>
}
```

### 8) Tools inyectables (DI ligero)

```ts
// Plugins pueden registrar "tools" accionables en ctx
bot.provide('db', sqlite('./bot.db'))
bot.provide('cache', new Map())
bot.provide('http', httpClient({ timeout: 5000 }))

// Y ahora aparecen en ctx.tools
bot.hears('perfil', async (ctx) => {
  const user = await ctx.tools.db.get('SELECT * FROM users WHERE jid = ?', ctx.from)
  await ctx.reply(`Hola ${user.name}`)
})
```

### 9) Bot class — API pública resumen

```ts
class Bot extends EventEmitter {
  // Lifecycle
  constructor(config?: BotConfig)
  start(): Promise<void>
  stop(): Promise<void>
  ready: Promise<void>                     // await hasta conectado
  
  // Declarativo
  hears(pattern, handler | Flow): Unlisten
  onMessage(handler): Unlisten
  onImage/onAudio/onVideo/onDocument/onLocation/onContact/onSticker(handler): Unlisten
  
  // Flows
  use(flow | plugin | Flow[]): this
  
  // Eventos
  on(event, handler): this
  before(event, handler, priority?): this
  after(event, handler, priority?): this
  onError(event, handler): this
  off(event, handler): this
  
  // Enviar a destinos arbitrarios
  send(jid, content): Promise<SentMessage>
  sendText(jid, text): Promise<SentMessage>
  sendPhoto(jid, source, caption?): Promise<SentMessage>
  // ... (todos los tipos sendText/sendAudio/etc)
  
  // Bulk
  broadcast(jids[], content): Promise<SentMessage[]>
  broadcastToList(broadcastJid, content): Promise<SentMessage>
  
  // Acciones globales
  getConnectionState(): ConnectionState
  getSessionName(): string
  getStore(): IStore
  
  // Sub-binding
  groups: GroupsAPI                        // bot.groups.create(...)
  profile: ProfileAPI                      // bot.profile.setName(...)
  privacy: PrivacyAPI                      // bot.privacy.block(jid)
  chats: ChatsAPI                          // bot.chats.archive(jid)
  presence: PresenceAPI                    // bot.presence.subscribe(jid)
  
  // Scheduler
  schedule(cron, fn): ScheduledTask
  every(interval, fn): ScheduledTask
  delay(duration, fn): ScheduledTask
  
  // Hooks internos
  provide(name, value): this
  hook(event, handler, priority?): this
  
  // Logger
  logger: Logger
  
  // Events nativos de EventEmitter
  emit(event, payload): boolean
}
```

### 10) Sub-APIs coloniales (binding namespaces)

```ts
bot.groups.create(name, participants[])
bot.groups.leave(jid)
bot.groups.members(jid)
bot.groups.addMember(jid, userId)
bot.groups.inviteLink(jid)
// ...

bot.profile.setName('Nuevo nombre')
bot.profile.setPhoto(buffer)
bot.profile.setStatus('Disponible')
bot.profile.get(jid)                      // info pública

bot.privacy.block(jid)
bot.privacy.unblock(jid)
bot.privacy.setLastSeen('all' | 'contacts' | 'none')
bot.privacy.setReadReceipts('all' | 'none')
// ...

bot.chats.archive(jid)
bot.chats.pin(jid)
bot.chats.mute(jid, ms)
bot.chats.delete(jid)
bot.chats.getAll()
// ...
```

### 11) Multi-sesión

```ts
const manager = new BotManager()

const ventas = await manager.start({ session: 'ventas', qr: { terminal: true } })
const soporte = await manager.start({ session: 'soporte', qr: { terminal: true } })

ventas.hears('hola', ctx => ctx.reply('Hola desde ventas 🏷️'))
soporte.hears('hola', ctx => ctx.reply('Hola desde soporte 🛠️'))

manager.broadcast(['ventas', 'soporte'], 'Cierre del día 🌙')

await manager.stopAll()
```

### 12) Types públicos

```ts
export type {
  Bot, BotConfig, MessageContext, SentMessage,
  Flow, FlowBuilder, FlowStep, FlowOptions, FlowTools,
  BotPlugin, PluginContext, HookContext,
  IStore, StoreAdapter, StoreConfig,
  GroupsAPI, ProfileAPI, PrivacyAPI, ChatsAPI, PresenceAPI,
  ConnectionState, MediaSource, JID,
  ScheduledTask, Logger,
}
```

---

## 📐 Estructura final propuesta del repo

```
src/
├── index.ts               # Barrel exports
├── core/
│   ├── Bot.ts             # Class principal + lifecycle
│   ├── types.ts           # TODOS los tipos públicos aquí
│   ├── events.ts          # EventRegistry
│   ├── context.ts         # MessageContext factory
│   ├── logger.ts          # Wrapper pino
│   └── errors.ts          # Errores typed
├── hooks/
│   ├── HookSystem.ts      # before/after/error pipeline
│   └── types.ts
├── plugins/
│   ├── PluginManager.ts
│   ├── definePlugin.ts
│   └── builtin/
│       ├── groups.ts
│       ├── scheduler.ts
│       ├── security.ts
│       ├── presence.ts
│       └── messages.ts
├── flows/
│   ├── FlowBuilder.ts     # addKeyword() v2
│   ├── FlowEngine.ts      # runtime
│   ├── FlowState.ts       # estado con IStore
│   └── types.ts
├── store/
│   ├── IStore.ts          # interfaz pública
│   ├── MemoryStore.ts     # adaptación de tu store.ts actual
│   ├── adapters/
│   │   ├── SQLiteStore.ts
│   │   ├── RedisStore.ts
│   │   └── ...
│   └── decorators.ts      # helpers
├── media/
│   ├── MediaProcessor.ts
│   ├── StickerProcessor.ts
│   ├── AudioProcessor.ts
│   ├── ImageProcessor.ts
│   └── utils.ts
├── provider/
│   ├── BaileysProvider.ts # tu baileys.ts refactorizado
│   ├── IBaileysProvider.ts
│   └── types.ts
├── api/                   # sub-APIs coloniales
│   ├── GroupsAPI.ts
│   ├── ProfileAPI.ts
│   ├── PrivacyAPI.ts
│   ├── ChatsAPI.ts
│   └── PresenceAPI.ts
├── scheduler/
│   └── Scheduler.ts
├── session/
│   ├── AuthState.ts       # wrapper de useMultiFileAuthState
│   └── MultiSession.ts    # BotManager
├── utils/
│   ├── jid.ts             # PN/LID, formatPhone, isGroup, etc
│   ├── http.ts
│   ├── media.ts
│   ├── timers.ts
│   └── fs.ts
└── legacy/                # borrable después
    ├── BaileysClass.ts    # tu clase actual, deprecated
    └── README.md
```

---

## ✅ Caja de aceptación de este discovery

Antes de escribir la implementación, capturo las decisiones:

- [ ] Aprobar el shape general de `Bot` API
- [ ] Aprobar el shape de `MessageContext` (reply, replyPhoto, etc)
- [ ] Aprobar el DSL v2 de Flows con `.choose/.timeout/.fallback`
- [ ] Aprobar conceptos de plugins y hooks
- [ ] Aprobar la estructura de carpetas propuesta
- [ ] Confirmar: ¿`new Bot()` zero-config auto-emite QR por terminal default? (recomendado SÍ)
- [ ] Confirmar: ¿empezamos por `Bot` + `HookSystem` + 1 plugin de prueba (logging) como MVP?

---

## 🎯 Siguiente paso inmediato

Si este discovery se acepta, el plan de implementación:

**Sprint 1 (1 semana) — MVP funcional:**
1. `core/Bot.ts` + lifecycle (`start`/`stop`/`ready`)
2. `provider/BaileysProvider.ts` (refactor de tu `baileys.ts` actual, sin romper)
3. `core/context.ts` → `MessageContext` con `reply`, `replyPhoto`, etc
4. `hooks/HookSystem.ts` → before/after/error pipeline
5. `core/events.ts` → wiring de eventos de Baileys
6. ` Bot.hears()` + ` bot.use(flow)` funcional
7. `flows/FlowBuilder.ts` v1 (sin .choose aún)

**Sprint 2 (1 semana) — Plugins + Flows avanzados:**
8. `plugins/PluginManager.ts`
9. `plugins/definePlugin.ts` + 1 plugin de muestra (`logging`)
10. `flows/` con `.choose`, `.timeout`, `.fallback`, `.validate`
11. ` IStore` interfaz + `MemoryStore` (adaptar tu store.ts)

**Sprint 3 (1 semana) — Features + sub-APIs:**
12. Sub-APIs coloniales: `groups`, `profile`, `privacy`, `chats`
13. Scheduler
14. MediaProcessor completo
15. Multi-session (BotManager)

**Sprint 4 (1 semana) — Docs + polish:**
16. TypeDoc
17. Examples (basic, flows, plugins, groups, scheduler, multibot)
18. README nuevo
19. Migration guide desde v1.1.5
20. v2.0.0-alpha publicada a npm

---

*Discovery para sign-off. Última actualización: 2026-07-18.*
