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

> **Estado: implementado** (`@bot-wa/core`, 2026-10). `ctx.user.get/set/update/delete/all/clear` con paths con puntos, `ctx.user.ns(name)` y `{ ttl }`; `bot.user(id)`, `userOf(ctx)`, `bot.purgeExpiredUserData()`; soportado por los 6 stores (métodos opcionales de `IStore` + `test-utils/user-data-conformance.ts`). Guía: `docs/guide/user-data.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10) como `c.retry(message?)`: repite la última espera en conversaciones async y rebobina el flujo en `.do()`; cuenta para `retries`. No hay alias `fallBack`. Guía: `docs/guide/flows.md`.

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
  const letra = await c.waitText()
  if (letra.length > 1) {
    await ctx.reply('Solo una letra')
    c.retry()  // vuelve a esperar
  }
})
```

**Requiere:** Método `retry()` en `ConversationControls` que resetee el contador de `loopWait` y vuelva a entrar al `wait()`.

---

### 3. Trigger `WELCOME` — primera interacción

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `WELCOME`, `MEDIA`, `IMAGE`, `VIDEO`, `AUDIO`, `VOICE_NOTE`, `DOCUMENT`, `STICKER`, `LOCATION`, `CONTACT`, `POLL`, `CALL`, `typeTrigger()` y `bot.resetWelcome()`. Guía: `docs/guide/triggers.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `.use(subFlow)` ejecuta un flujo en línea y vuelve al padre con el estado mezclado; las opciones de `choose()` aceptan `then: subFlow | fn` y `goto` para salir a otra conversación (p. ej. el menú principal). `c.retry()` tras un `.use()` vuelve a ejecutar el sub-flujo. Guía: `docs/guide/flows.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `ctx.handoff()`, `bot.handoff/resume/isHandedOff/getHandoff/listHandoffs`, `bot.sendTo()`, eventos `'handoff'`/`'resume'`, `BotConfig.handoff.allowCommands`, persistido en el store. Guía: `docs/guide/handoff.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `bot.broadcast(chatIds, content, { batchSize, delayBetween, concurrency, maxRetries, onProgress, onFail, signal })` envía por lotes a través del `send()` del provider (y por tanto de su rate limiter), respeta `RateLimitedError.retryAfterMs` pausando a todos los workers y se cancela con `signal` o `bot.stop()`. Devuelve `{ total, sent, failed, skipped, errors, messages, cancelled, pending }` (`sent`/`failed` son contadores). Guía: `docs/guide/messages.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `bot.blacklist` / `bot.whitelist` (`AccessList`, `Whitelist`, `checkAccess`), `bot.exportAccessLists()` / `loadAccessLists()`. Ids exactos (sin normalizar números). Guía: `docs/guide/handoff.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `c.idle(duration, cb)` / `c.idleClear()` dentro de una conversación y `bot.onIdle(duration, handler)` / `bot.clearIdle()` por chat (suspendido durante un handoff). Guía: `docs/guide/flows.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `.guard(check, message | { redirect, message })`; si el predicado falla, se despide (termina la conversación) o redirige a otro flujo. `bot.lint()` comprueba los `redirect` como un `goto`. Guía: `docs/guide/flows.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10) sin depender de zod: `schema` acepta cualquier objeto con `safeParse()` (zod u otra librería compatible) en `.ask()`, `c.ask()` y `c.waitText()`, que resuelven con el valor parseado. El rechazo sin mensaje propio usa `core.wait.invalid` (i18n). Guía: `docs/guide/flows.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `.media(kind, source, caption?, opts?)` para `image`, `video`, `audio`, `voice`, `document`, `sticker` y `location` (opciones `delay`, `filename`, `ptv`, `gifPlayback`, `pack`, `author`); la forma antigua `.media(source, caption?)` sigue enviando una imagen. Guía: `docs/guide/flows.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `BotConfig.typing` (`true` o `{ enabled, minMs, maxMs, charsPerSecond }`, desactivado por defecto) muestra "escribiendo…" antes de las respuestas de texto; por respuesta, `ctx.reply(text, { typing })`. Un indicador que falla nunca hace fallar el envío y no hay espera donde `capabilities.typing` es `false`. Guía: `docs/guide/messages.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `bot.locale(code, messages)` con claves anidadas, `{param}` y plurales; `ctx.t()`, `ctx.lang`, `ctx.langSource`, `ctx.setLang()` (persistido en `ctx.user`), `c.t()`/`c.lang`, `bot.t()`/`bot.langOf()`. Resolución: preferencia del usuario → idioma del provider → `detect` → por defecto. Los textos del core (timeouts, reintentos, validaciones, comandos slash, formularios) están en el catálogo `core.*` con `es` y `en`. Guía: `docs/guide/i18n.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `ctx.reply(text, { delay, typing, cancelIf })` (también en `say`/`answer`/`text`/`quote`), `{ delay }` en `say`/`ask`/`choose`/`media` y un paso `.delay()` en el DSL. Una respuesta pausada se descarta (`skipped`) si el bot se para, el chat pasa a handoff o el flujo se aborta durante la espera. Guías: `docs/guide/messages.md` y `docs/guide/flows.md`.

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

> **Estado: implementado.** `c.end(farewell?)` funciona en conversaciones async, en `.do()` de flujos (también tras un `c.retry()`) y desde callbacks de `c.idle()`.

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

> **Estado: implementado** como plugin, no como provider: `@bot-wa/voice` (privado) con `voicePlugin({ stt, tts, limits, autoTranscribe, autoReplyWithVoice })`. STT: OpenAI-compatible (Whisper) y Deepgram; TTS: OpenAI y ElevenLabs, todo por `secureFetch`. Transcribe las notas de voz en un hook `before('message')` (`ctx.transcript` y `ctx.body`), puede responder con voz a quien escribe con voz y expone `ctx.tools.voice`. Las llamadas de voz en tiempo real (LiveKit/SIP) quedan fuera. Guía: `docs/guide/voice.md`.

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

> **Estado: implementado** (`@bot-wa/evolution`, privado): `EvolutionProvider`, salida REST e ingest de webhooks firmados, identidad canónica de WhatsApp. Guía: `docs/guide/channels.md`.

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

> **Estado: implementado** (`@bot-wa/twilio`, privado): `TwilioProvider` para WhatsApp y SMS sobre Programmable Messaging, webhooks verificados con `X-Twilio-Signature` (los JSON, ligados a `bodySHA256`). Guía: `docs/guide/channels.md`.

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

> **Estado: implementado** (`@bot-wa/tiktok`, privado): `TikTokProvider` con DMs de Business Messaging y respuestas a comentarios de vídeos propios, webhooks firmados. Guía: `docs/guide/channels.md`.

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

> **Estado: implementado** (`@bot-wa/email`, privado): `EmailProvider` con IMAP IDLE de entrada (`imapflow`) y SMTP de salida (`nodemailer`), hilos, detección de mensajes automáticos, rebotes y bucles. Guía: `docs/guide/channels.md`.

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

> **Estado: implementado** (`@bot-wa/wppconnect`, privado): `WPPConnectProvider` sobre la API REST de wppconnect-server, webhook con token e ingest ordenado. Guía: `docs/guide/channels.md`.

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

> **Estado: implementado** (`@bot-wa/gohighlevel`, privado): `GoHighLevelProvider` sobre la Conversations API, webhooks `InboundMessage` con firma verificada. Guía: `docs/guide/channels.md`.

**Por qué pertenece:** CRM/Marketing platform con API de mensajería.

**Evidencia:**
- `builderbot`: `provider-gohighlevel` completo.

**Requiere:** nuevo paquete `@bot-wa/gohighlevel`.

---

### 23. Gupshup provider

> **Estado: implementado** (`@bot-wa/gupshup`, privado): `GupshupProvider` para WhatsApp (API v1 y callbacks v2). Guía: `docs/guide/channels.md`.

**Por qué pertenece:** Plataforma de mensajería enterprise India/global.

**Evidencia:**
- `builderbot`: `provider-gupshup` completo.

**Requiere:** nuevo paquete `@bot-wa/gupshup`.

---

## TIER 4 — Manager / Multi-bot / API (infraestructura de producto)

### 24. Flow Registry dinámico (CRUD de flows en runtime)

> **Estado: implementado.** En el core (`@bot-wa/core`, 2026-10): `bot.registerFlow()`, `unregisterFlow()`, `replaceFlow()` (cambio en caliente), `hasFlow()`, `listFlows()`, `triggerFlow()` y `listConversations()`. En `@bot-wa/manager`: documentos de flujo JSON (`compileFlowDocument`, `validateFlowDocument`, JSON Schema `FLOW_DOCUMENT_SCHEMA`, expresiones acotadas) gestionables por la API REST. Guía: `docs/guide/control-plane.md`.

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

> **Estado: implementado** (`@bot-wa/manager`, privado): `createRestApi()` con la API REST `/v1`, tokens con scopes (`API_SCOPES`), idempotencia (`MemoryIdempotencyStore`), rate limiting (`TokenBucketRateLimiter`) y documento OpenAPI 3.1 (`buildOpenApiDocument()`), sin dependencias (`node:http`). Guía: `docs/guide/control-plane.md`.

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

> **Estado: implementado** (`@bot-wa/manager`, privado): configuración de bots por `tenantId` persistida en un `BotConfigStore` (`FileBotConfigStore`, un JSON por bot con escrituras atómicas, o `MemoryBotConfigStore`) y restaurada al arrancar; ids validados (`SAFE_ID_PATTERN`). Guía: `docs/guide/control-plane.md`.

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

> **Estado: implementado** (`@bot-wa/manager`, privado): `autoReconnect` (por defecto `{ maxRetries: 5, initialDelay: 1000, maxDelay: 30000 }`) con backoff exponencial y eventos de reconexión, más supervisión del estado de conexión de cada bot. Guía: `docs/guide/control-plane.md`.

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

> **Estado: implementado** (`@bot-wa/ai`, 2026-10): `aiPlugin({ tools })` con `defineTool`, esquema JSON o `safeParse`, bucle de varios pasos (`maxSteps`), timeout por herramienta, errores devueltos al modelo, confirmación humana (`confirm: true`, `confirmWith`) por el runtime de conversaciones y eventos de auditoría (`onToolEvent`, `bot.on('ai.tool')`). Anthropic, OpenAI (y presets compatibles), Gemini y Ollama; `MockAIProvider` puede simular llamadas a herramientas. Guía: `docs/guide/ai-tools.md`.

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

> **Estado: implementado**: paquete nuevo `@bot-wa/rag` (privado; `createRag()`, loaders, chunking, embeddings OpenAI-compatible/Ollama/hash local, índice vectorial en memoria con persistencia JSON) y `aiPlugin({ rag })`, que acepta cualquier `AIRetriever` e inyecta los pasajes con citas numeradas (`appendSources`, `rag.timeoutMs`). Guía: `docs/guide/ai-memory-rag.md`.

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

> **Estado: implementado** (`@bot-wa/ai`, 2026-10): `aiPlugin({ memory })` guarda hechos por usuario en `ctx.user` (namespace `ai.memory`), los inyecta en la autorespuesta y, con `autoExtract`, extrae hechos nuevos en segundo plano (`maxFacts`, `ttl` por hecho); `ctx.tools.ai.memory()`, `remember()`, `forget()`; `bot.deleteSubject()` los borra; en grupos no se inyectan salvo `memory.injectInGroups`. Guía: `docs/guide/ai-memory-rag.md`.

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

> **Estado: implementado** (`@bot-wa/dialogflow`, privado): `dialogflowPlugin()` / `dialogflowContext()` con `detectIntent` por REST para ES y CX (JWT de cuenta de servicio, sin SDK de Google) y `whenDialogflowIntent()` para enrutar intents a flujos. Guía: `docs/guide/integrations.md`.

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

> **Estado: implementado** (`@bot-wa/chatwoot`, privado): `chatwootPlugin()` sincroniza los mensajes en ambos sentidos y usa el handoff del core (#5) para que los agentes de Chatwoot tomen y devuelvan la conversación; webhook verificado. Guía: `docs/guide/integrations.md`.

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

> **Estado: implementado** (`@bot-wa/tickets`, privado): `ticketsPlugin()` y `ctx.tools.tickets` (`TicketDesk`) con colas, posición en cola, prioridades, horario de atención y persistencia en el store. Guía: `docs/guide/integrations.md`.

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

> **Estado: implementado** (`@bot-wa/moderation`, privado): `moderationPlugin()` con ventanas anti-spam, filtros de palabras/regex, filtro de enlaces de invitación con lista permitida exacta y acciones warn/mute/kick/delete. Guía: `docs/guide/integrations.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `ctx.edit(content)` edita la última respuesta del propio contexto y `ctx.edit(ref, content)` un mensaje concreto (nativo con `provider.editMessage`; si no, envía un mensaje nuevo; pasa por los hooks de `send`); `ctx.react(emoji, target?)` resuelve `skipped` donde no hay reacciones; `ctx.supports(feature)` informa `native`/`degraded`/`unsupported`. Guía: `docs/guide/messages.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `bot.trigger(name, { chatId, userId?, isGroup?, data?, ifActive?, body? })` arranca un flujo o conversación registrado con `c.state` sembrado desde `data`, pasando por las listas de acceso, el handoff y la cola FIFO del chat. `bot.triggerFlow()` es un wrapper sobre él. Guía: `docs/guide/messages.md`.

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

> **Estado: implementado** (`@bot-wa/core`, 2026-10): `bot.metrics()` / `bot.resetMetrics()`, eventos `'conversation:started'` y `'conversation:ended'` (`outcome`, `completed`, `durationMs`…) y exportador Prometheus sin dependencias `toPrometheus(snapshot, { prefix, labels })`. Guía: `docs/guide/messages.md`.

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

> **Estado: parcial** (`@bot-wa/core/testing`). Ya existen `createTestBot()` con `chat.send()`, `chat.expectReply()` y `chat.replies()`, `MockProvider.call()`, el kit de caos (`createTestBot(config, { chaos })`, `withChaos`) y `assertStableIdentity`. Faltan `expectNoReply` y `sendMedia`/`sendReaction` en el chat de test. El snapshot de conversación completa lo cubren los golden transcripts (`recordTranscript` + `assertTranscript`, ver la sección de ideas implementadas). Guía: `docs/guide/testing.md`.

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

> **Estado: implementado** (`create-bot-wa`, 2026-10): plantillas de caso de uso `games`, `support`, `store`, `restaurant`, `clinic` y `ai-full`, además de `baileys`, `meta`, `telegram` y `ai`. Todas usan la API v2, `defineBot` y `npm run dev`, y cada proyecto generado incluye un `AGENTS.md` para agentes de código.

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

> **Estado: implementado** (`eslint-plugin-bot-wa`, privado): reglas `no-v1-api`, `no-await-runtime-enter`, `no-async-plugin-install`, `no-empty-trigger`, `require-timeout-on-ask` y `prefer-ctx-user-over-global-state`, con configuraciones flat `recommended` y `strict`. Complementa a `bot.lint()`, que valida el grafo de flujos en runtime. Guía: `docs/guide/eslint.md`.

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

## ✅ Implementado a partir del análisis (fuera del catálogo)

Ideas que salieron del análisis de bots reales y de los fallos de entrega/identidad, sin número propio en el catálogo:

| Idea | Estado y API |
|---|---|
| **MockProvider adversario** (caos) | `ChaosProvider` / `withChaos` y `createTestBot(config, { chaos })` en `@bot-wa/core/testing`: duplicados, reordenación, latencia, fallos de envío tipados, desconexiones con replay y alias de identidad, deterministas por `seed`. Guía: `docs/guide/testing.md`. |
| **Contrato de identidad verificable** | `assertStableIdentity`, `checkIdentityContract` y `recordEvents` en `@bot-wa/core/testing`; usado por `baileys-provider/tests/identity-contract.test.ts`. |
| **Idempotencia de entrada** | `BotConfig.dedupe` (activado por defecto): descarta re-entregas por `chatId` + id; contrato de ids de entrada documentado en `IProvider`. Guía: `docs/guide/concepts.md`. |
| **Describe / lint de flujos** | `bot.describe()` (Mermaid o JSON), `bot.lint()` con 13 reglas, `describeFlows` / `lintFlows` sin Bot. Guía: `docs/guide/flow-tools.md`. |
| **`bot-wa dev`** (simulador en la terminal) | CLI `bot-wa dev src/bot.js` con recarga en caliente, `defineBot` + `isMainModule`, API programática en `@bot-wa/core/dev`; `create-bot-wa` genera `npm run dev`. Guía: `docs/guide/dev-simulator.md`. |
| **Ingress de webhooks** (`@bot-wa/server`, privado) | `createIngress()` + adaptadores `serveNode`/`createNodeHandler` (`node:http`, Express, Fastify) y `serveFetch`/`createFetchHandler` (Hono, runtimes con `fetch`): body crudo para verificar firmas, límite de tamaño (413), timeouts, límite de concurrencia y endpoints de salud. Guía: `docs/guide/server.md`. |
| **Ventana de 24 h de WhatsApp + pricing** (`@bot-wa/meta`) | Opción `sessionWindow` / `SessionWindowManager` con `SessionWindowStore` enchufable: reabre un chat cerrado con una plantilla aprobada y reintenta el envío original cuando el usuario responde; estado por número de negocio (`forScope()`). Los estados llevan `pricing`/`conversation` normalizados en `DeliveryStatus.platformData` y `provider.usage` agrega uso y coste estimado. Guía: `docs/guide/session-window.md`. |
| **Streaming de respuestas** (`ctx.stream`) | `ctx.stream()` en el core: borradores nativos (Telegram), edición progresiva donde hay `editMessage` o trozos por frases como degradación; los envíos llevan `stream: 'draft' \| 'edit' \| 'message'` en los hooks de `send`. `@bot-wa/ai` lo usa para las respuestas en vivo. Guía: `docs/guide/streaming.md`. |
| **Golden transcripts** | `recordTranscript`/`RecordingProvider`, `transcriptFromStore`, `redactTranscript` (placeholders estables), formato JSON versionado y `replayTranscript`/`assertTranscript` en `@bot-wa/core/testing` con diffs y tolerancias; `@bot-wa/deployments` los usa como gate de publicación (`goldenTranscriptGate`). Guía: `docs/guide/golden-transcripts.md`. |
| **Estado tipado en flujos** | `flow<S>()`; `.ask(…, 'key', { schema })`, `choose` y `.use()` infieren las claves de `c.state`; `FlowStateOf<typeof f>`. Guía: `docs/guide/flows.md`. |
| **`AGENTS.md` en los proyectos generados** | `create-bot-wa` escribe un `AGENTS.md` con la API v2 vigente, los modismos v1 que no existen (`addAnswer`, `capture`, `flowDynamic`…) y los comandos del proyecto; exportado como `agentsMd()`. |
| **Formularios nativos / WhatsApp Flows** | `flow().form({ id, title, fields })` con campos `text`, `number`, `email`, `date`, `select`, `multiselect` y `optin`: en `@bot-wa/meta` se envía como WhatsApp Flow estático si hay uno mapeado (`config.flows`, `provider.publishForm()`, `nativeId`); en el resto de canales (o sin mapeo) se pregunta campo a campo. Textos localizables (`core.form.*`). Guía: `docs/guide/forms.md`. |

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