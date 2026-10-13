# Roadmap de Features — bot-wa-baileys

> Generado: 2026-07-23
> Análisis exhaustivo de: `packages/*` (nuestro), `terceros/bot-wa-games` (proyecto real), `terceros/builderbot` (librería competidora completa)
> Meta: ser la mejor librería del mundo para construir bots

---

## Cómo leer este documento

Cada feature tiene:
- **Por qué pertenece a la librería** (no se hace con un `fetch()` en un handler)
- **Evidencia** (de nuestro código, de bot-wa-games, o de builderbot)
- **API propuesta**
- **Requiere** (qué tocar internamente)

---

## TIER 1 — Motor del bot (lo que DUELE no tener)

### 1. `ctx.user` — Perfiles persistentes con namespaces + TTL

Estado persistente por usuario que sobrevive entre conversaciones. Con namespaces para evitar colisiones entre plugins y TTL para auto-cleanup.

**Por qué pertenece:** Requiere extensión del `IStore` (5 implementaciones) + inyección en `MessageContext`. Un usuario no puede hacerlo limpio sin tocar internals.

**Evidencia:**
- `bot-wa-games`: `globalState.update(ctx.from, { AkinatorLanguage: 'es', HangmanDifficulty: 'facil' })` — singleton con `fs.writeFileSync` en cada update, sin concurrencia, sin cleanup, prefijos manuales (`AkinatorLanguage`, `HangmanDifficulty`).
- `builderbot`: `SingleState` (Map por `from`), `GlobalState` (singleton), `state.get('prop.nested')` con dot-notation.

```ts
// API propuesta
bot.when('hola', async (ctx) => {
  const name = await ctx.user.get('name')
  await ctx.user.set('name', 'Juan')

  // Namespace por feature/plugin (sin colisiones)
  await ctx.user.ns('akinator').set('language', 'es')
  const lang = await ctx.user.ns('akinator').get('language')

  // TTL — auto-cleanup de state de juegos/sesiones temporales
  await ctx.user.ns('game').set('board', board, { ttl: '30m' })

  // Dot-notation (como builderbot)
  await ctx.user.set('address.city', 'Bogotá')
  const city = await ctx.user.get('address.city')

  // Bulk
  await ctx.user.update({ name: 'Juan', lang: 'es' })
  await ctx.user.ns('game').clear()
})
```

**Requiere:**
- Extender `IStore` con `getUserData(chatId, userId, namespace?)` / `setUserData(...)` / `deleteUserData(...)` / `listUserData(prefix?)`
- Implementar en: MemoryStore, SQLiteStore, RedisStore, MongoStore, PostgresStore, MySQLStore
- Inyectar `ctx.user` en `MessageContext` (factory en `buildMessageContext`)
- Sistema de TTL (timer en memory, timestamp en DB con cleanup periódico)

---

### 2. `c.retry()` / `c.fallBack()` en conversaciones async

Reintentar la misma espera sin armar un loop manual.

**Por qué pertenece:** Es parte del runtime de conversaciones. `loopWait` ya tiene `retries` pero no hay forma de reintentar manualmente mid-conversation.

**Evidencia:**
- `bot-wa-games`: `await fallBack()` aparece **15+ veces** en todos los juegos (akinator, hangman, tic-tac-toe).
- `builderbot`: `fallBack(message?)` es API pública central.

```ts
// API propuesta — conversación async
bot.conversation('akinator', async (c, ctx) => {
  for (;;) {
    await ctx.reply(c.question)
    const answer = await c.waitText({
      validate: (v) => /^[1-5]$/.test(v) || 'Opción 1-5',
      retries: Infinity,  // no abortar, seguir reintentando
      retryMessage: '❌ Opción inválida, elegí 1-5',
    })
    // si llega acá, validó
    break
  }
})

// O explícito:
bot.conversation('juego', async (c, ctx) => {
  await ctx.reply('Escribí una letra')
  let letra = await c.waitText()
  while (letra.length > 1) {
    letra = await c.retry('Solo una letra')  // vuelve a esperar y devuelve la nueva respuesta
  }
})
```

> `c.retry()` siempre se espera (`await`) o se retorna: la conversación tiene un único hueco de espera, así que un `c.retry()` sin `await` seguido de otra espera falla con `ConcurrentWaitError`.

**Requiere:** Método `retry()` en `ConversationControls` que resetee el contador de `loopWait` y vuelva a entrar al `wait()`.

---

### 3. Trigger `WELCOME` — primera interacción

Trigger especial que dispara solo la primera vez que un usuario escribe al bot (o después de un `/reset`).

**Por qué pertenece:** Requiere consultar el store antes de matchear. No se puede hacer con un flag manual sin race conditions.

**Evidencia:**
- `bot-wa-games`: `addKeyword(EVENTS.WELCOME)` es el entry point de TODO el bot.
- `builderbot`: `EVENTS.WELCOME` — evento nativo, genera un ref único, el core lo detecta.

```ts
// API propuesta
import { WELCOME } from '@bot-wa/core'

bot.when(WELCOME, async (ctx) => {
  await ctx.reply('🙌 Bienvenido! Escribe "juegos" para ver el menú')
})

// Eventos especiales adicionales (de builderbot):
bot.when(MEDIA, (ctx) => ctx.reply('Recibí tu imagen'))
bot.when(VOICE_NOTE, (ctx) => ctx.reply('Recibí tu audio'))
bot.when(LOCATION, (ctx) => ctx.reply('Recibí tu ubicación'))
bot.when(DOCUMENT, (ctx) => ctx.reply('Recibí tu documento'))
bot.when(CALL, (ctx) => ctx.reply('Te llamaron!'))
```

**Requiere:**
- `WELCOME`: flag en store (`hasInteracted(chatId)`) consultado por el Dispatcher antes de matchear. Se marca después del primer dispatch.
- `MEDIA`/`VOICE_NOTE`/`LOCATION`/`DOCUMENT`: triggers que matchean por `ctx.type` (ya existe `onType` en el Dispatcher, solo falta exponerlos como constantes públicas).
- `CALL`: el evento `CallEvent` ya existe en `InboundEvent`, solo falta exponerlo como trigger.

---

### 4. Composición de flows — `.use(subFlow)` + flows hijos

Incluir un flow dentro de otro y volver al padre al terminar. Reemplaza el patrón de hijos + `gotoFlow(padre)`.

**Por qué pertenece:** Requiere modificar el intérprete de flows. No se puede hacer desde afuera sin strings mágicos.

**Evidencia:**
- `bot-wa-games`: `addKeyword(...).addAnswer(..., handler, [flowGames, flowHelp, flowContact])` — hijos declarados como array, `gotoFlow(flowMain)` para volver.
- `builderbot`: `options.nested` en `TCTXoptions`, `getFlowsChild()` en `FlowClass`, `gotoFlow(flow, step?)`.

```ts
// API propuesta — sub-flow inline
const direccion = flow('direccion')
  .ask('¿Calle?', 'calle')
  .ask('¿Ciudad?', 'ciudad')

flow('pedido')
  .say('Vamos con el envío')
  .use(direccion)  // ejecuta sub-flow, mergea state, vuelve acá
  .say((_ctx, c) => `Envío a ${c.state.calle}, ${c.state.ciudad}`)

// API propuesta — flows hijos (menú → submenú → volver)
flow('menu-juegos')
  .choose('Elegí un juego:', {
    akinator: { label: 'Akinator', then: flowAkinator },
    hangman: { label: 'Ahorcado', then: flowHangman },
    tictactoe: { label: 'Triqui', then: flowTicTacToe },
    volver: { label: '⬅️ Volver', then: flowMain },  // gotoFlow equivalente
  })
```

**Requiere:**
- `.use(subFlow)`: nuevo `CompiledStep` tipo `use` en `FlowBuilder` + manejo en `interpreter.ts` (ejecutar sub-flow inline, mergear state, continuar).
- Flows hijos: ya existe `.choose()` con `then: FlowBuilder` — verificar que el state se mergee correctamente y que `goto` funcione para volver.

---

### 5. Human handoff — pausar bot, atiende humano

El dispatcher ignora un chat hasta que se retoma. El agente humano envía mensajes vía API.

**Por qué pertenece:** Requiere un flag en el Dispatcher + evento + API para enviar mensajes fuera del pipeline.

**Evidencia:**
- `builderbot`: plugin de Chatwoot hace exactamente esto — pausa el bot cuando un agente humano toma el chat en Chatwoot, lo reanuda al cerrar.

```ts
// API propuesta
bot.when('hablar con humano', async (ctx) => {
  await ctx.reply('Te conecto con un agente...')
  ctx.handoff()  // el dispatcher ignora este chat
})

// El agente humano envía:
await bot.sendTo(chatId, 'Hola, soy tu agente')

// Retomar el bot:
bot.resume(chatId)

// Evento para integrar con Chatwoot/cualquier CRM:
bot.on('handoff', ({ chatId, reason }) => {
  chatwootApi.assignConversation(chatId)
})
bot.on('resume', ({ chatId }) => {
  chatwootApi.closeConversation(chatId)
})
```

**Requiere:**
- `Set<ChatId>` de chats en handoff en el Dispatcher (checked antes de matchear).
- `ctx.handoff()` / `bot.resume(chatId)` / `bot.sendTo(chatId, content)`.
- Eventos `handoff` / `resume` en `BotEvents`.

---

### 6. Broadcast con rate limiting integrado

Enviar un mensaje a N chats respetando el rate limiter existente.

**Por qué pertenece:** Requiere acceso al `RateLimiter` interno del provider. Imposible de hacer bien desde afuera sin ban.

```ts
// API propuesta
const results = await bot.broadcast(chatIds, { text: '🎉 Nueva promo!' }, {
  batchSize: 10,
  delayBetween: '2s',
  onProgress: (sent, total) => console.log(`${sent}/${total}`),
  onFail: (chatId, error) => log.error(chatId, error),
})
// → { sent: 480, failed: 20, errors: [{ chatId, error }] }
```

**Requiere:** método en `Bot` que itera sobre `provider.send()` respetando el `RateLimiter` + tracking de resultados.

---

### 7. Blacklist / Whitelist dinámica

Bloquear o permitir números específicos en runtime.

**Por qué pertenece:** Requiere acceso al Dispatcher antes de matchear. Un usuario no puede hacerlo sin tocar el pipeline.

**Evidencia:**
- `builderbot`: `BlackList` class con `add`/`remove`/`checkIf`, soporta whitelist (números con `!` prefix), `dynamicBlacklist.add(phoneNumbers)` en `CoreClass`.

```ts
// API propuesta
bot.blacklist.add('573001234567')
bot.blacklist.add(['573001234567', '573007654321'])
bot.blacklist.remove('573001234567')
bot.blacklist.has('573001234567')  // → true

// Whitelist mode (solo estos números reciben respuesta)
bot.whitelist.add(['573001234567'])
bot.whitelist.enable()

// En runtime desde un flow:
flow('bloquear')
  .ask('¿Número a bloquear?', 'numero')
  .do(async (ctx, c) => {
    bot.blacklist.add(c.state.numero)
    await ctx.reply(`✅ ${c.state.numero} bloqueado`)
  })
```

**Requiere:** `BlackList` class en el Dispatcher, checked antes de matchear. Persistencia opcional vía store.

---

### 8. Idle / Timeout por inactividad

Si el usuario no responde en X tiempo, ejecutar un callback (recordatorio, cancelar flow, etc.).

**Por qué pertenece:** Requiere acceso al runtime de conversaciones y al scheduler.

**Evidencia:**
- `builderbot`: `IdleState` class con `setIdleTime({ from, timeInSeconds, cb })` — interval que dispara callback tras X segundos, `stop(ctxInComing)` para cancelar.
- `bot-wa-games`: el patrón de "si no responde en 2 minutos, cancelar el juego" se implementa a mano en cada flow.

```ts
// API propuesta — en conversación
bot.conversation('juego', async (c, ctx) => {
  c.idle('2m', async () => {
    await ctx.reply('⏰ Te desconecté por inactividad')
    c.end()
  })

  await ctx.reply('Escribe una letra')
  const letra = await c.waitText({ timeout: '30s' })
  c.idleClear()  // cancela el idle si respondió
})

// API propuesta — global (cualquier chat inactivo)
bot.onIdle('10m', async (chatId) => {
  await bot.sendTo(chatId, '¿Sigues ahí?')
})
```

**Requiere:** `IdleState` class integrada en `ConversationRuntime` + evento `idle` en `Bot`.

---

## TIER 2 — DSL y DX (mejora la experiencia de desarrollo)

### 9. Guards en flows

Condición que debe cumplirse para que el flow continúe. Si falla, responde un mensaje y aborta o redirige.

**Por qué pertenece:** Requiere nuevo step en el intérprete de flows.

**Evidencia:** En `bot-wa-games` cada handler valida manualmente: `if (!esHorarioLaboral()) { await flowDynamic(['Fuera de horario']); await gotoFlow(flowMain); return }`.

```ts
// API propuesta
flow('soporte')
  .guard((ctx) => esHorarioLaboral(), 'Fuera de horario, volvé mañana')
  .guard(async (ctx) => !!(await ctx.user.get('registered')), 'Primero /registro')
  .say('¿En qué te ayudo?')

// Guard con redirect:
flow('admin')
  .guard(async (ctx) => await isAdmin(ctx.sender), { redirect: 'no-permiso' })
  .say('Panel de admin')
```

**Requiere:** nuevo `CompiledStep` tipo `guard` en `FlowBuilder` + manejo en `interpreter.ts`.

---

### 10. Validación con schemas (zod) en `ask`/`waitText`

**Por qué pertenece:** Requiere integración en `controls.ts` → `loopWait`.

**Evidencia:** En `bot-wa-games` cada `ask` valida a mano: `if (!option || option < 1 || option > 5) { await flowDynamic(['Opcion no valida']); await fallBack(); return }`.

```ts
import { z } from 'zod'

flow('registro')
  .ask('¿Tu email?', 'email', { schema: z.string().email('Email inválido') })
  .ask('¿Tu edad?', 'edad', { schema: z.coerce.number().min(18, 'Debés ser mayor') })
  .ask('¿Tu teléfono?', 'phone', { schema: z.string().regex(/^\+\d{10,}$/, 'Formato: +57300...') })
  .ask('¿Tu país?', 'pais', {
    schema: z.enum(['CO', 'MX', 'AR', 'ES']),
    otherwise: 'País no soportado. Opciones: CO, MX, AR, ES',
  })
```

**Requiere:** en `controls.ts` → `loopWait`, si `opts.schema` existe, parsear con zod y usar el error message como retry message. Zod como peer dep opcional.

---

### 11. `.media()` completo en flows

**Por qué pertenece:** Requiere extender el step `media` en `FlowBuilder`.

**Evidencia:** En v2 `.media()` solo hace `photo()`. En `bot-wa-games` se envían imágenes, audio (akinator), y se usa `flowDynamic([{ media: url, body: text }])`.

```ts
// API propuesta
flow('demo')
  .media('image', 'https://...')
  .media('video', './demo.mp4', 'Mirá esto')
  .media('audio', './nota.ogg')
  .media('voice', './nota.ogg')  // PTV / voice note
  .media('document', './factura.pdf', 'Tu factura')
  .media('sticker', './sticker.webp')
  .media('location', { lat: 4.71, lng: -74.07 }, 'Bogotá')
```

**Requiere:** extender el step `media` en `FlowBuilder` con parámetro `type` + mapeo a `ctx.photo/video/audio/voice/file/sticker/location`.

---

### 12. Typing indicator automático

**Por qué pertenece:** Requiere integración en `sendThrough()` o `ctx.reply()`.

**Evidencia:** En `bot-wa-games` cada `flowDynamic` es instantáneo. Un bot real debe mostrar "escribiendo...".

```ts
// Config global
const bot = new Bot({
  provider,
  typing: { enabled: true, minMs: 800, maxMs: 3000, charsPerSecond: 20 },
})

// O por reply:
await ctx.replyWithTyping('Hola, déjame pensar...', { msPerChar: 50 })
```

**Requiere:** en `sendThrough()`, llamar `provider.typing(chatId, 'composing')` → delay proporcional → enviar → `provider.typing(chatId, 'paused')`.

---

### 13. i18n nativo del bot

**Por qué pertenece:** Requiere registry de locales + `ctx.t()` en `MessageContext` + detección de idioma.

**Evidencia:** En `bot-wa-games`: `const regionName = { es: 'Español', en: 'Ingles' }` — manual, hardcoded.

```ts
// API propuesta
bot.locale('es', {
  greeting: '¡Hola!',
  farewell: '¡Chau!',
  invalidOption: 'Opción inválida',
  menu: 'Elegí una opción:\n1) Juegos\n2) Ayuda',
})
bot.locale('en', { greeting: 'Hello!', farewell: 'Bye!', ... })

bot.when('hola', (ctx) => ctx.reply(ctx.t('greeting')))
bot.when('menu', (ctx) => ctx.reply(ctx.t('menu')))

// Detección automática: ctx.user.get('lang') > primer mensaje > default
bot.locale({ default: 'es', detect: true })
```

**Requiere:** registry de locales en `Bot` + `ctx.t(key, params?)` en `MessageContext` + detección (store o heurística de primer mensaje).

---

### 14. `ctx.reply` con delay entre mensajes

**Por qué pertenece:** Requiere integración en el pipeline de envío.

**Evidencia:**
- `builderbot`: `FlowDynamicMessage.delay` — cada mensaje en `flowDynamic` puede tener `delay` individual. `ActionPropertiesKeyword.delay` — delay antes de un `addAnswer`.

```ts
// API propuesta
flow('bienvenida')
  .say('Hola!', { delay: '1s' })
  .say('Te explico...', { delay: '2s' })
  .say('Esto es un bot', { delay: '500ms' })

// En conversación:
await ctx.reply('Hola!')
await ctx.reply('Te explico...', { delay: '2s' })  // espera 2s antes de enviar
```

**Requiere:** parámetro `delay` en `say()` / `reply()` que espera antes de enviar.

---

### 15. `endFlow()` / `c.end()` con mensaje de cierre

**Por qué pertenece:** Requiere integración en el runtime de conversaciones.

**Evidencia:**
- `builderbot`: `endFlow(message?)` — termina el flow y opcionalmente envía un mensaje de cierre.

```ts
// API propuesta — en flow
flow('cancelar')
  .say('¿Seguro que querés cancelar?')
  .ask('sí/no', 'confirm')
  .do(async (ctx, c) => {
    if (c.state.confirm === 'sí') {
      await ctx.reply('✅ Cancelado')
      c.end()  // termina la conversación
    } else {
      c.goto('menu')  // vuelve al menú
    }
  })

// En conversación async:
bot.conversation('juego', async (c, ctx) => {
  if (ctx.body === 'cancelar') {
    c.end('✅ Juego cancelado')  // envía mensaje y termina
  }
})
```

**Requiere:** `c.end(farewell?)` ya existe pero solo lanza `ConversationEnded` — falta que envíe el `farewell` antes de terminar.

---

## TIER 3 — Providers y transportes (expandir cobertura)

### 16. Provider de voz (STT/TTS integrado al pipeline)

**Por qué pertenece:** Los audios son el 40%+ de mensajes en WhatsApp. Sin STT, el bot es sordo a audios.

**Evidencia:**
- `builderbot`: `provider-voice` completo con LiveKit + WebRTC, adapters STT (OpenAI Whisper, Deepgram) y TTS (OpenAI, ElevenLabs, Deepgram, Cartesia). `provider-voice-whatsapp` para llamadas de voz WA Business. `provider-voice-sip` para SIP/WebRTC.

```ts
// API propuesta — como plugin (no provider nuevo)
import { voicePlugin } from '@bot-wa/voice'

bot.plug(voicePlugin({
  stt: { provider: 'openai', model: 'whisper-1', apiKey: process.env.OPENAI_API_KEY },
  tts: { provider: 'elevenlabs', voice: 'rachel', apiKey: process.env.ELEVEN_API_KEY },
  autoReply: true,  // si el usuario envía audio, el bot responde con audio
}))

// O manual:
bot.when(VOICE_NOTE, async (ctx) => {
  const text = await ctx.tools.voice.transcribe(ctx.media)
  await ctx.reply(`Dijiste: ${text}`)
  const audio = await ctx.tools.voice.synthesize('Entendido!')
  await ctx.voice(audio)
})
```

**Requiere:** nuevo paquete `@bot-wa/voice` con adapters STT/TTS + plugin que hook en `before('message')` para transcribir audios automáticamente.

---

### 17. Evolution API provider

**Por qué pertenece:** Evolution API es la alternativa self-hosted a Baileys. Muchos usuarios la prefieren por estabilidad.

**Evidencia:**
- `builderbot`: `provider-evolution-api` completo.

```ts
// API propuesta
import { EvolutionProvider } from '@bot-wa/evolution'

const bot = new Bot({
  provider: new EvolutionProvider({
    baseUrl: 'http://localhost:8080',
    apiKey: 'evolution-api-key',
    instance: 'my-instance',
  }),
})
```

**Requiere:** nuevo paquete `@bot-wa/evolution` que implementa `IProvider` sobre la REST API de Evolution.

---

### 18. Twilio provider

**Por qué pertenece:** Twilio es el estándar enterprise de SMS/WhatsApp.

**Evidencia:**
- `builderbot`: `provider-twilio` completo.

```ts
import { TwilioProvider } from '@bot-wa/twilio'

const bot = new Bot({
  provider: new TwilioProvider({
    accountSid: process.env.TWILIO_SID,
    authToken: process.env.TWILIO_TOKEN,
    whatsappFrom: 'whatsapp:+14155238886',
    webhookPath: '/twilio/webhook',
  }),
})
```

**Requiere:** nuevo paquete `@bot-wa/twilio` que implementa `IProvider` sobre Twilio WhatsApp/SMS API.

---

### 19. TikTok provider

**Por qué pertenece:** Bot que responde comentarios de TikTok automáticamente.

**Evidencia:**
- `builderbot`: `provider-tiktok` completo — responde comentarios de videos de TikTok Business.

```ts
import { TikTokProvider } from '@bot-wa/tiktok'

const bot = new Bot({
  provider: new TikTokProvider({
    accessToken: process.env.TIKTOK_TOKEN,
  }),
})

bot.when('comentario', async (ctx) => {
  await ctx.reply('Gracias por tu comentario!')
})
```

**Requiere:** nuevo paquete `@bot-wa/tiktok` que implementa `IProvider` sobre TikTok Business Open API.

---

### 20. Email provider

**Por qué pertenece:** Bot que responde emails automáticamente. Caso de uso enterprise.

**Evidencia:**
- `builderbot`: `provider-email` completo con IMAP/SMTP.

```ts
import { EmailProvider } from '@bot-wa/email'

const bot = new Bot({
  provider: new EmailProvider({
    imap: { host: 'imap.gmail.com', port: 993, user: '...', pass: '...' },
    smtp: { host: 'smtp.gmail.com', port: 465, user: '...', pass: '...' },
  }),
})
```

**Requiere:** nuevo paquete `@bot-wa/email` que implementa `IProvider` sobre IMAP (inbound) + SMTP (outbound).

---

### 21. WPPConnect provider

**Por qué pertenece:** Alternativa a Baileys con diferentes trade-offs (estabilidad, features).

**Evidencia:**
- `builderbot`: `provider-wppconnect` completo.

```ts
import { WPPConnectProvider } from '@bot-wa/wppconnect'

const bot = new Bot({
  provider: new WPPConnectProvider({ session: 'my-bot' }),
})
```

**Requiere:** nuevo paquete `@bot-wa/wppconnect` que implementa `IProvider` sobre WPPConnect.

---

### 22. GoHighLevel provider

**Por qué pertenece:** CRM/Marketing platform con API de mensajería.

**Evidencia:**
- `builderbot`: `provider-gohighlevel` completo.

**Requiere:** nuevo paquete `@bot-wa/gohighlevel`.

---

### 23. Gupshup provider

**Por qué pertenece:** Plataforma de mensajería enterprise India/global.

**Evidencia:**
- `builderbot`: `provider-gupshup` completo.

**Requiere:** nuevo paquete `@bot-wa/gupshup`.

---

## TIER 4 — Manager / Multi-bot / API (infraestructura de producto)

### 24. Flow Registry dinámico (CRUD de flows en runtime)

**Por qué pertenece:** Requiere acceso al `ConversationRuntime` para registrar/desregistrar flows sin restart.

**Evidencia:**
- `builderbot`: `FlowRegistry` class con `register`/`registerDynamic`/`update`/`delete` — crea flows desde JSON config vía API.

```ts
// API propuesta
bot.registerFlow(myFlow)         // registrar en runtime
bot.unregisterFlow('registro')   // desregistrar
bot.replaceFlow('registro', v2)  // hot-swap
bot.listFlows()                  // listar flows activos

// Desde JSON (vía API):
bot.createFlowFromJson({
  id: 'encuesta',
  keyword: 'encuesta',
  steps: [
    { kind: 'say', text: 'Hola!' },
    { kind: 'ask', text: '¿Tu nombre?', stateKey: 'name' },
    { kind: 'say', text: 'Gracias {{name}}' },
  ],
})
```

**Requiere:** métodos en `Bot` que deleguen al `ConversationRuntime` + parser de JSON a `CompiledFlow`.

---

### 25. Manager API completa (REST + OpenAPI + rate limiting)

**Por qué pertenece:** La API actual solo hace `GET /bots` y `POST /bots/:id/start|stop`. Para que el Manager sea útil de verdad.

**Evidencia:**
- `builderbot`: `BotManagerApi` con Polka, `FlowRegistry`, `RateLimiter`, `openApiSpec` (Swagger/OpenAPI 3.0), `PersistenceManager` (guarda configs a disco), endpoints para crear bots dinámicamente, enviar mensajes, gestionar flows, health check, QR codes.

```
# Endpoints propuestos
GET    /health                      → health check global
GET    /bots                        → listar bots
POST   /bots                        → crear bot (con provider + flows)
GET    /bots/:id                    → estado del bot
PUT    /bots/:id                    → actualizar config
DELETE /bots/:id                    → eliminar bot
POST   /bots/:id/start              → iniciar
POST   /bots/:id/stop              → detener
POST   /bots/:id/restart            → reiniciar
GET    /bots/:id/qr                → QR code actual
POST   /bots/:id/send              → enviar mensaje
POST   /bots/:id/trigger            → disparar flow
GET    /bots/:id/conversations      → conversaciones activas
POST   /bots/:id/conversations/:cid/cancel
GET    /bots/:id/messages           → historial paginado
GET    /bots/:id/metrics            → métricas
GET    /flows                       → listar flows registrados
POST   /flows                       → crear flow dinámico
PUT    /flows/:id                   → actualizar flow
DELETE /flows/:id                   → eliminar flow
POST   /webhooks/:botId             → webhook entrante
GET    /docs                        → Swagger UI (OpenAPI spec autogenerada)
```

**Requiere:**
- Extender `http.ts` del manager con todos los endpoints.
- `FlowRegistry` (ver feature #24).
- `RateLimiter` en la API (como builderbot).
- `openApiSpec` autogenerada (como builderbot `swagger.ts`).
- `PersistenceManager` para guardar configs de bots a disco (como builderbot `persistence.ts`).
- Exponer métodos en `Bot`: `sendTo`, `trigger`, `listConversations`, `metrics`.

---

### 26. Multi-tenant con persistencia

**Por qué pertenece:** Para SaaS / plataforma. Cada tenant tiene su bot aislado.

**Evidencia:**
- `builderbot`: `BotManager` con `tenantId`, `TenantConfig`, `autoReconnect` (backoff exponencial), `PersistenceManager` (guarda/recupera configs), sesiones aisladas por tenant.

```ts
// API propuesta
const manager = new BotManager({
  sessionsDir: './sessions',
  autoReconnect: { enabled: true, maxRetries: 5, initialDelay: 1000, maxDelay: 30000 },
  persistence: { dir: './data', autoSave: true },
})

await manager.createBot({
  tenantId: 'acme',
  name: 'Acme Bot',
  provider: new BaileysProvider({ session: 'acme' }),
  flows: [flowMain, flowSupport],
})

// Auto-reconnect en crash
// Auto-restore desde disco en restart
```

**Requiere:** extender `BotManager` con `tenantId`, `autoReconnect`, `PersistenceManager`, sesiones aisladas.

---

### 27. Auto-reconnect con backoff exponencial

**Por qué pertenece:** Requiere acceso al lifecycle del provider.

**Evidencia:**
- `builderbot`: `autoReconnect: { enabled, maxRetries, initialDelay, maxDelay }` en `BotManagerConfig`, `reconnectStates` tracking.

```ts
// API propuesta
const manager = new BotManager({
  autoReconnect: {
    enabled: true,
    maxRetries: 5,
    initialDelay: 1000,   // 1s
    maxDelay: 30000,      // 30s
    backoff: 'exponential', // o 'linear'
  },
})
```

**Requiere:** integración en `BotManager` que escucha `connection: closed` y reintenta con backoff.

---

## TIER 5 — Inteligencia / Context (extender el AI plugin)

### 28. Function calling / Tool use en AI

**Por qué pertenece:** Requiere integración entre el AI plugin y las tools del bot.

```ts
// API propuesta
bot.plug(aiPlugin({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  tools: {
    buscar_producto: async (query: string) => {
      return await db.products.search(query)
    },
    crear_pedido: async (items: string[], cliente: string) => {
      return await db.orders.create({ items, cliente })
    },
  },
}))

// El LLM decide cuándo llamar estas funciones automáticamente
```

**Requiere:** exponer tools del bot como function definitions del LLM en `AIClient`.

---

### 29. RAG (Retrieval Augmented Generation)

**Por qué pertenece:** Requiere indexación + retrieval integrado al AI plugin.

```ts
// API propuesta
bot.plug(aiPlugin({
  provider: 'openai',
  rag: {
    documents: ['./docs/faq.md', './docs/productos.pdf'],
    embeddings: 'openai',  // o 'local'
    chunkSize: 1000,
    topK: 3,
  },
}))

// El bot responde con contexto de los documentos automáticamente
```

**Requiere:** nuevo paquete `@bot-wa/rag` con indexación (embeddings) + retrieval + integración con `AIClient`.

---

### 30. Memoria a largo plazo por usuario

**Por qué pertenece:** Requiere integración con `ctx.user` (feature #1) + AI plugin.

```ts
// API propuesta
bot.plug(aiPlugin({
  provider: 'openai',
  memory: {
    type: 'per-user',
    maxFacts: 50,
    autoExtract: true,  // el LLM extrae hechos automáticamente del chat
  },
}))

// El bot recuerda: "Juan prefiere atención en español", "Juan compró X"
bot.when('hola', async (ctx) => {
  const facts = await ctx.tools.ai.memory(ctx.sender)
  // → ['Prefiere español', 'Compró producto X', 'Es de Bogotá']
})
```

**Requiere:** integración entre `ctx.user` y `AIClient` + extracción automática de hechos.

---

### 31. Contextos de NLU externos (Dialogflow / Dialogflow CX)

**Por qué pertenece:** Requiere integración con el dispatcher para ruteo de intenciones.

**Evidencia:**
- `builderbot`: `contexts-dialogflow` y `contexts-dialogflow-cx` completos.

```ts
// API propuesta
import { dialogflowContext } from '@bot-wa/dialogflow'

bot.useContext(dialogflowContext({
  projectId: 'my-project',
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
}))

// Las intenciones de Dialogflow rutean a flows automáticamente
```

**Requiere:** nuevo paquete `@bot-wa/dialogflow` que implementa un context provider sobre Dialogflow ES/CX.

---

## TIER 6 — Plugins oficiales (paquetes separados)

### 32. Plugin Chatwoot (human handoff + CRM)

**Por qué pertenece:** Integración profunda con el pipeline (handoff, sync de mensajes, contactos).

**Evidencia:**
- `builderbot`: `plugins/chatwoot` completo — sincroniza mensajes bidireccionalmente, pausa el bot cuando un agente toma el chat, reanuda al cerrar, mapea eventos WA a labels de Chatwoot.

```ts
// API propuesta
import { chatwootPlugin } from '@bot-wa/chatwoot'

bot.plug(chatwootPlugin({
  baseUrl: 'https://my.chatwoot.com',
  apiKey: '...',
  accountId: 1,
  inboxId: 2,
  autoHandoff: true,  // si un agente responde, pausa el bot
}))
```

**Requiere:** nuevo paquete `@bot-wa/chatwoot` con API client + plugin que integra con el handoff (feature #5).

---

### 33. Plugin de colas / tickets de soporte

**Por qué pertenece:** Sistema de colas con estados (abierto, en espera, cerrado) requiere acceso al store + dispatcher.

```ts
// API propuesta
import { ticketsPlugin } from '@bot-wa/tickets'

bot.plug(ticketsPlugin({
  workingHours: '9-18',
  queueMessage: 'Estás en cola, posición {{position}}',
  onAssign: async (ticket) => notifyAgent(ticket),
}))

bot.when('soporte', async (ctx) => {
  const ticket = await ctx.tools.tickets.create({
    chatId: ctx.from,
    subject: ctx.body,
    priority: 'normal',
  })
  await ctx.reply(`🎫 Ticket #${ticket.id} creado`)
})
```

**Requiere:** nuevo paquete `@bot-wa/tickets` con store de tickets + plugin.

---

### 34. Plugin de moderación de grupos

**Por qué pertenece:** Requiere acceso a eventos de grupo + dispatcher para ban/kick.

**Evidencia:** En `builderbot` el `BlackList` es del core. La moderación de grupos (anti-spam, filtros, bans) es un plugin natural.

```ts
// API propuesta
import { moderationPlugin } from '@bot-wa/moderation'

bot.plug(moderationPlugin({
  antiSpam: {
    maxMessages: 5,
    windowMs: 10_000,  // 5 mensajes en 10s = spam
    action: 'warn',    // 'warn' | 'mute' | 'kick'
  },
  wordFilter: {
    banned: ['spam', 'estafa'],
    action: 'delete',
  },
  autoKickOnLink: true,  // kick si envía link de grupo ajeno
}))
```

**Requiere:** nuevo paquete `@bot-wa/moderation` con plugin que hook en `before('message')` + eventos `group`.

---

## TIER 7 — Core: completar el contrato IProvider

### 35. Reacciones + edición de mensajes (outbound)

**Por qué pertenece:** El inbound ya las recibe (`InboundReaction`). El contrato `IProvider` ya define `editMessage()`. Falta que el bot las use.

**Evidencia:** `ctx.react(emoji)` ya existe en `MessageContext` pero no todos los providers lo implementan. `ctx.edit()` no existe.

```ts
// API propuesta
await ctx.react('👍')              // reacciona al mensaje del usuario
await ctx.edit('Texto corregido')  // edita el último mensaje del bot
await ctx.edit(ref, 'Texto')      // edita un mensaje específico por ref
```

**Requiere:** `ctx.edit()` en `MessageContext` + implementar `editMessage` en cada provider + `capabilities.reactions` / `capabilities.edit`.

---

### 36. Trigger programático de flows

**Por qué pertenece:** Requiere inyectar un `RuntimeMessage` sintético en el dispatcher.

```ts
// API propuesta
await bot.trigger('recordatorio-cita', {
  chatId: '57300...@s.whatsapp.net',
  data: { cita: 'mañana 3pm', doctor: 'Dr. García' },
})

// Desde el scheduler:
bot.schedule('0 9 * * *', async () => {
  const citas = await db.getCitasForToday()
  for (const cita of citas) {
    await bot.trigger('recordatorio', { chatId: cita.chatId, data: cita })
  }
})
```

**Requiere:** método en `Bot` que inyecta un `RuntimeMessage` sintético en el dispatcher con `data` accesible vía `c.state`.

---

### 37. Métricas integradas del runtime

**Por qué pertenece:** Datos que SOLO el engine conoce.

```ts
// API propuesta
const m = bot.metrics()
// {
//   conversationsStarted: 142, completed: 98, dropped: 30, timedOut: 14,
//   avgDurationMs: 150_000,
//   flowsTriggered: { registro: 45, soporte: 67, akinator: 12 },
//   messagesIn: 1200, messagesOut: 980,
//   activeConversations: 5,
//   uptime: '3d 4h',
// }

// Evento por conversación:
bot.on('conversation:ended', ({ name, durationMs, completed, chatId }) => {
  analytics.track('conversation', { name, durationMs, completed })
})
```

**Requiere:** contadores en `ConversationRuntime`, `Dispatcher`, `HookSystem` + evento `conversation:ended`.

---

### 38. `createTestBot` mejorado — aserciones de conversación

**Por qué pertenece:** Requiere acceso al MockProvider + outbox.

```ts
// API propuesta
const t = createTestBot()
t.send('hola')
await t.expectReply('👋 ¡Hola!')
t.send('registrar')
await t.expectReply(/¿Tu nombre/)
t.send('Juan')
await t.expectReply('✅ Hola Juan')
await t.expectNoReply({ timeout: 1000 })

// Simular media:
t.sendMedia('image', buffer)
await t.expectReply('Recibí tu imagen')

// Simular reacción:
t.sendReaction('👍')
await t.expectReply('Gracias por reaccionar')

// Snapshot de conversación completa:
const transcript = t.transcript()
expect(transcript).toMatchSnapshot()
```

**Requiere:** helper sobre el outbox del MockProvider con matchers de texto/regex/orden + snapshot.

---

## TIER 8 — DX / Tooling / CLI

### 39. Más templates en `create-bot-wa`

**Por qué pertenece:** El CLI ya existe, solo falta contenido.

**Evidencia:**
- `builderbot`: 100+ starters (cada provider × cada DB × JS/TS).
- `bot-wa-games`: caso de uso real de juegos.

```ts
// Templates propuestos
create-bot-wa my-bot --template=games      // bot de juegos (akinator, hangman, triqui)
create-bot-wa my-bot --template=support    // bot de soporte con tickets
create-bot-wa my-bot --template=store      // bot de tienda con catálogo
create-bot-wa my-bot --template=restaurant // bot de restaurante con menú
create-bot-wa my-bot --template=clinic     // bot de clínica con agendamiento
create-bot-wa my-bot --template=ai-full    // AI + NLU + store + scheduler
```

**Requiere:** extender `templates.ts` en `create-bot-wa`.

---

### 40. ESLint plugin propio

**Por qué pertenece:** Reglas específicas de la librería que ningún linter genérico cubre.

**Evidencia:**
- `builderbot`: `eslint-plugin-builderbot` con reglas como "no usar `endFlow` después de `flowDynamic`" (no tiene efecto).

```ts
// Reglas propuestas
// - no-flowDynamic-after-endFlow: flowDynamic seguido de endFlow no tiene efecto
// - no-capture-after-endFlow: capture:true después de endFlow queda esperando
// - require-await-in-handler: handlers async sin await
// - no-string-trigger-empty: addKeyword([]) o ('') no matchea nada
// - prefer-ctx-user-over-globalState: migrar de globalState a ctx.user
```

**Requiere:** nuevo paquete `eslint-plugin-bot-wa` con reglas custom.

---

## ❌ Descartado (no pertenece a la librería)

| Descartado | Razón |
|---|---|
| Plugin de pagos (Stripe, MercadoPago) | `fetch()` en un handler. 10 líneas. |
| Plugin de email SMTP/SendGrid/Resend | `fetch()` en un handler. Cero relación con el runtime. (Nota: el **provider** de email sí pertenece — feature #20 — porque es un transporte, no un plugin) |
| Plugin CRM (HubSpot, Salesforce) | Integración con API externa. |
| Plugin de calendario | Ídem. |
| Dashboard visual / Flow Builder | Producto aparte, no la librería. |
| Docker / Helm / CI | Infraestructura, no funcionalidad del core. |
| Marketplace de plugins | Negocio, no código. |
| Skills de industria (restaurante, clínica) | Son templates (feature #39), no features del engine. |
| Traducción automática | Wrapper de una API externa. Un `fetch()` en un hook `before`. |
| Provider de Sherpa | Fork de Baileys, no aporta nada nuevo sobre Baileys 7. |
| Provider de Venom | Obsoleto, WPPConnect lo reemplazó. |

---

## Orden de ejecución sugerido

```
Fase 1 — Motor del bot (base de todo)
  1. ctx.user + namespaces + TTL          ← base de guards, i18n, handoff, memory
  2. c.retry() / fallBack                 ← DX inmediata, 15+ usos en código real
  3. WELCOME + MEDIA/VOICE/LOCATION triggers ← entry point de todo bot
  4. Composición de flows (.use + hijos)  ← menús anidados, patrón más común
  5. Guards en flows                      ← validación declarativa
  6. Blacklist / Whitlist dinámica        ← moderación básica
  7. Idle / Timeout por inactividad       ← UX de conversaciones
  8. endFlow() con mensaje                ← cierre de flows

Fase 2 — DSL y DX
  9. .media() completo                    ← video/audio/doc en DSL
  10. Zod validation                      ← DX
  11. Typing automático                   ← realismo
  12. i18n                                ← multi-idioma
  13. Delay entre mensajes               ← naturalidad
  14. createTestBot mejorado              ← testing DX

Fase 3 — Providers nuevos
  15. Voice plugin (STT/TTS)              ← audios = 40% de WA
  16. Evolution API provider              ← alternativa self-hosted
  17. Twilio provider                     ← enterprise
  18. Email provider                      ← enterprise
  19. WPPConnect provider                 ← alternativa
  20. TikTok provider                     ← social
  21. GoHighLevel / Gupshup               ← enterprise

Fase 4 — Manager / API
  22. Flow Registry dinámico              ← CRUD de flows en runtime
  23. Manager API completa + OpenAPI     ← multi-bot útil
  24. Multi-tenant con persistencia      ← SaaS
  25. Auto-reconnect con backoff          ← resiliencia

Fase 5 — Inteligencia
  26. Function calling / Tool use         ← AI que ejecuta acciones
  27. RAG                                 ← AI con contexto de documentos
  28. Memoria a largo plazo               ← AI que recuerda usuarios
  29. Dialogflow context                  ← NLU externo

Fase 6 — Plugins oficiales
  30. Chatwoot plugin                    ← human handoff + CRM
  31. Tickets plugin                      ← colas de soporte
  32. Moderation plugin                  ← anti-spam grupos

Fase 7 — Core completar
  33. React/edit outbound                ← completar IProvider
  34. Trigger programático                ← integraciones backend
  35. Métricas del runtime                ← visibilidad

Fase 8 — DX / CLI
  36. Más templates (games, support, store, restaurant, clinic, ai-full)
  37. ESLint plugin propio
```