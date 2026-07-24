# Guía de migración v1 → v2

`@bot-wa/core` v2 (antes `@bot-wa/bot-wa-baileys`) es un **rewrite del core**, no un parche sobre la v1. Cambian los nombres (`BaileysClass` → `Bot`), pero también cambia el motor por debajo: el viejo "router de mensajes" y el engine de flujos por arrays de pasos desaparecen, reemplazados por un **Dispatcher** con prioridad por especificidad y un **runtime de conversaciones async** sobre el que se compila el DSL declarativo (`flow()`).

Además, la v2 es **agnóstica de transporte**: el core ya no sabe de WhatsApp. Todo lo específico de la conexión (QR, sesión, JIDs, auth) vive en un **provider** que tú construyes e inyectas: `new Bot({ provider: new BaileysProvider({...}) })`. Ver la sección de [reorganización de paquetes](#reorganización-de-paquetes-core-transportes-stores) para el mapa completo.

Si tu bot v1 es simple (unos cuantos `addKeyword`/respuestas de texto), la migración es mecánica. Si usa flujos con `capture` anidados, botones, o depende de que `bot.on('message')` reciba *todos* los mensajes, lee también la sección de [cambios de comportamiento](#cambios-de-comportamiento-en-v2) — hay diferencias de semántica, no solo de nombres.

## Tabla de cambios

| v1 | v2 |
|---|---|
| `new BaileysClass(opts)` | `new Bot({ provider: new BaileysProvider(opts) })` + `await bot.start()` |
| `import { ... } from '@bot-wa/bot-wa-baileys'` | `import { Bot, flow, ... } from '@bot-wa/core'` + `import { BaileysProvider } from '@bot-wa/baileys'` |
| `bot.on('message', ...)` global | `bot.onMessage()` (catch-all, corre solo si nada más consumió el mensaje) o `bot.when(trigger, handler)` |
| `addKeyword().addAnswer(txt, { capture })` | `flow(trigger).say(txt)` / `.ask(txt, stateKey)` (alias de compatibilidad: `addKeyword = flow`) |
| `sendText/sendImage/sendVideo/sendAudio/sendFile/...` | Conservados en `bot.sendText`/`bot.send` + los helpers de contexto `ctx.reply/photo/video/audio/file/...` |
| `bot.send(jid, { image: { url }, caption })` | `bot.send(chatId, { kind: 'image', media: { url }, caption })` — contenido normalizado |
| `ctx.key` / `ctx.rawMessage` | `ctx.ref` (`MessageRef`: `{ id, chatId, native? }`) / `ctx.raw` |
| Hook `before('send')` con payload `{ jid, content, options }` | Payload `{ chatId, content, options }` — `content` es `OutboundContent` |
| Eventos `qr` / `ready` | Iguales: `bot.on('qr', (artifact) => ...)`, `bot.on('ready', () => ...)` |
| `usePairingCode: true, phoneNumber: 'XXX'` + evento `pairing_code` | Opción `pairingCode: '+57300XXXXXXX'` (formato internacional completo) en `BaileysProvider`. **Ya no hay evento `pairing_code`**: el código llega como payload del evento `qr` (el artifact de auth del provider). |
| `auth_failure` | No hay evento `auth_failure` dedicado: los fallos de credenciales llegan como un cierre de conexión → `bot.on('connection', (u) => { if (u.state === 'closed') ... })` (revisa `u.reason`, p.ej. `'sessionInvalid'`). El evento `bot.on('error', ...)` es para errores de procesamiento de mensajes, no de auth. |
| `sendButtons` (ya deprecado en v1) | **Eliminado** como botón nativo en Baileys (degrada a texto numerado). Usa `c.choose()` / `.choose()` (menú numerado) o `ctx.poll()`. Con `@bot-wa/meta` sí hay botones/listas nativos. |
| Sub-APIs `bot.groups/profile/privacy/chats/presence` | **Eliminadas del core** (específicas de WhatsApp). Ver [Sub-APIs](./guide/sub-apis) — acceso directo al socket vía `provider.socket`. |

## Ejemplos antes / después

### 1. Arrancar el bot

```ts
// v1
import { BaileysClass } from '@bot-wa/bot-wa-baileys'
const botBaileys = new BaileysClass({})
botBaileys.on('qr', (qr) => console.log('QR', qr))
botBaileys.on('ready', () => console.log('READY'))
```

```ts
// v2 — el provider lleva las opciones de transporte (sesión, QR, auth)
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
})
bot.on('qr', (qr) => console.log('QR', qr))
bot.on('ready', () => console.log('READY'))
await bot.start()
```

### 2. Flujo con captura de respuesta

```ts
// v1 (estilo bot-whatsapp/BuilderBot)
addKeyword('registrar')
  .addAnswer('¿Cuál es tu nombre?', { capture: true }, async (ctx, { state }) => {
    await state.update({ name: ctx.body })
  })
  .addAnswer('Gracias, {{name}}')
```

```ts
// v2 — flow() compila a un bot.conversation real
import { flow } from '@bot-wa/core'

bot.use(
  flow('registrar')
    .ask('¿Cuál es tu nombre?', 'name')
    .say((_ctx, c) => `Gracias, ${c.state.name}`)
)
```

`addKeyword` sigue existiendo como alias directo de `flow` para no romper la lectura muscular de quien viene de BuilderBot/bot-whatsapp — `addKeyword('registrar').ask(...)` es exactamente lo mismo que `flow('registrar').ask(...)`.

### 3. Eventos

```ts
// v1
botBaileys.on('message', async (message) => {
  await botBaileys.sendText(message.from, 'Hola')
})
```

```ts
// v2 — el catch-all solo corre si nada más (comando/conversación/matcher) consumió el mensaje
bot.onMessage(async (ctx) => {
  await ctx.reply('Hola')
})
// o, si de verdad necesitas ver TODO mensaje procesado (incluidos los de un flow activo):
bot.on('message', (ctx) => console.log('procesado:', ctx.from, ctx.body))
```

### 4. Botones → menú numerado o poll

```ts
// v1 — sendButtons (ya deprecado, y muerto en el protocolo actual de WhatsApp Web)
await botBaileys.sendButtons(jid, 'Elige una opción', [
  { body: 'Sí' }, { body: 'No' },
])
```

```ts
// v2 — dentro de un flow. `choose` guarda la KEY elegida en c.state.choice
// (o en la key que pases como 3er argumento: .choose(prompt, opciones, 'confirmacion')).
bot.use(
  flow('confirmar')
    .choose('¿Confirmas tu pedido?', { si: 'Sí', no: 'No' })
    .say((_ctx, c) => c.state.choice === 'si' ? '✅ Confirmado' : '❌ Cancelado')
)

// o dentro de una conversación async
bot.conversation('confirmar', async (c, ctx) => {
  const respuesta = await c.choose('¿Confirmas tu pedido?', { si: 'Sí', no: 'No' })
  await ctx.reply(respuesta === 'si' ? '✅ Confirmado' : '❌ Cancelado')
})

// alternativa nativa de WhatsApp: encuesta real
await ctx.poll('¿Confirmas tu pedido?', ['Sí', 'No'])
```

## Cambios de comportamiento en v2

Estos NO son solo renombres — cambia el comportamiento observable. Léelos con cuidado antes de dar la migración por "mecánica".

### a) El matching por defecto es `equals` normalizado, no `contains`

En v1 muchos triggers de texto se comportaban como "el mensaje contiene esta palabra". En v2 el default de `bot.when(trigger, ...)` (y del trigger de un `flow(trigger)`) es **igualdad exacta tras normalizar** (minúsculas, sin acentos, espacios colapsados). Si tu bot v1 dependía de "contiene", tienes que pedirlo explícitamente:

```ts
// v1-like: dispara si el texto CONTIENE "factura" en cualquier parte
bot.when({ pattern: 'factura', match: 'contains' }, async (ctx) => { /* ... */ })

// default v2: solo dispara si el mensaje normalizado es EXACTAMENTE "factura"
bot.when('factura', async (ctx) => { /* ... */ })
```

Estrategias disponibles en `TriggerObject.match`: `'equals'` (default) · `'contains'` · `'startsWith'` · `'endsWith'`.

### b) `onImage`/`onType` solo corren si nada más específico ya consumió el mensaje

`onImage`, `onAudio`, `onType(type, ...)`, etc. se registran como matchers de **baja especificidad**. Si tienes un `bot.when(...)` de mayor especificidad que también matchea ese mensaje, ese gana y el handler de media nunca corre — a menos que ese handler llame `ctx.pass()` para ceder el turno al siguiente handler en la cascada:

```ts
bot.when(/.+/, async (ctx) => {
  if (ctx.type === 'image') { ctx.pass(); return } // cede el turno
  await ctx.reply('texto recibido')
})

bot.onImage(async (ctx) => {
  await ctx.reply('imagen recibida') // ahora sí llega aquí
})
```

### c) El evento `'message'` ahora dispara para TODO mensaje procesado

En v2, `bot.on('message', ...)` se emite al final del pipeline del Dispatcher para **cualquier** mensaje que terminó de procesarse — incluidos los que consumió un comando, una conversación activa, o un flow. Ya no es "solo lo que no matcheó nada" (eso es `bot.onMessage()`, el catch-all). Si migras un listener v1 que asumía "solo veo lo no manejado", cámbialo a `bot.onMessage()`.

### d) Las conversaciones son por-participante en grupos, por defecto

En un grupo, dos participantes distintos que le hablan al bot en el mismo chat ahora tienen **conversaciones independientes** (clave interna `${from}:${sender}`). En v1 (y si quieres ese comportamiento en v2) la conversación es una sola por chat. Para volver al modo v1 dentro de un grupo:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  conversationScope: 'chat',
})
```

### e) ESM-only + Node >= 22

Los paquetes son **ESM puros** (`"type": "module"`, sin build CommonJS). Tu proyecto debe:

- Tener `"type": "module"` en su propio `package.json`, **o**
- Usar extensión `.mjs`, **o**
- Estar en Node **>= 22.12**, donde `require('@bot-wa/core')` funciona vía el soporte experimental de Node para `require(esm)`.

Mínimo soportado: **Node >= 22**. Baileys 7 (un transporte, no el core) también es ESM-only — es una de las razones por las que la v2 no ofrece un build CJS.

## Reorganización de paquetes: core, transportes, stores

La v2 separó el motor de los transportes. El paquete `@bot-wa/bot-wa-baileys` de la v1 ya no existe como tal:

| v1 | v2 |
|---|---|
| `@bot-wa/bot-wa-baileys` (todo junto) | `@bot-wa/core` — el motor (`Bot`, `flow`, hooks, plugins, scheduler, `IProvider v2`, testing kit) |
| Conexión WhatsApp embebida | `@bot-wa/baileys` — `BaileysProvider` (WhatsApp Web vía Baileys 7, QR) |
| — | `@bot-wa/meta` — `CloudAPIProvider` (WhatsApp Cloud API oficial, webhook) |
| — | `@bot-wa/telegram` — `TelegramProvider` · `@bot-wa/discord` — `DiscordProvider` |
| `SQLiteStore` incluido | `@bot-wa/sqlite-store` — `SQLiteStore` (peer dep `better-sqlite3`) |
| — | `@bot-wa/redis-store` — `RedisStore` (estado distribuido) |
| `@bot-wa/ai` (anthropic/openai/ollama) | `@bot-wa/ai` + `gemini` + 9 presets OpenAI-compatible: `deepseek`, `qwen`, `glm`, `kimi`, `groq`, `openrouter`, `mistral`, `grok`, `together` |

Reglas prácticas:

- **Todo lo que sea sesión/auth/QR/conexión se movió al provider.** `BotConfig` solo acepta opciones agnósticas (`conversation`, `conversationScope`, `groupMode`, `commandPrefix`, `store`, `debug`, ...).
- **`ctx.key` → `ctx.ref`** (`MessageRef` con `{ id, chatId, native? }`) y **`ctx.rawMessage` → `ctx.raw`** en handlers, hooks y flujos.
- **El contenido de `bot.send` es un tagged union neutral**: `{ kind: 'image', media, caption }` en lugar del objeto estilo Baileys `{ image: { url }, caption }`.
- **Instalación típica**: `pnpm add @bot-wa/core @bot-wa/baileys` (+ `@bot-wa/sqlite-store better-sqlite3` si quieres persistencia, + `@bot-wa/ai` y el SDK del proveedor de IA que uses).

## Desviaciones respecto a la API v1 / BuilderBot

Detalles concretos donde la forma v2 NO coincide 1:1 con lo que quizá esperas de v1 o de bot-whatsapp/BuilderBot:

- **`.timeout(ms)` no lleva mensaje.** En el DSL, `flow(...).timeout('30s')` fija solo la duración del `wait`. El texto que se envía al expirar NO es un parámetro de `.timeout()` — se configura globalmente al crear el bot con `conversation.timeoutMessage`:

  ```ts
  const bot = new Bot({
    provider: new BaileysProvider({ session: 'mi-bot' }),
    conversation: { timeout: '30s', timeoutMessage: '⏰ Se acabó el tiempo.' },
  })
  ```

- **`addKeyword` es el ÚNICO alias de compatibilidad.** `addKeyword` existe como alias directo de `flow`. Los métodos de BuilderBot `.addAnswer(...)` y `.addAction(...)` **no existen** — usa el DSL v2: `.say(text)`, `.ask(text, stateKey)`, `.do(fn)`, `.choose(prompt, opciones, stateKey?)`.

- **`.persistent()` requiere un store con archivo.** Ver la nota de [flujos persistentes](#flujos-persistentes-persistent) más abajo.

## Flujos persistentes (`.persistent()`)

`flow(...).persistent()` solo **sobrevive a reinicios del proceso** si el store está respaldado por algo durable. El store por defecto (`MemoryStore`) vive en memoria: sin `file` (o sin un store real como `SQLiteStore` de `@bot-wa/sqlite-store`), los checkpoints se pierden al reiniciar. Para persistencia real:

```ts
import { Bot, flow } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'
import { SQLiteStore } from '@bot-wa/sqlite-store'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'mi-bot' }),
  store: new SQLiteStore({ file: './data/bot.db' }),
})
bot.use(flow('registrar').persistent().ask('¿Nombre?', 'name').say('listo'))
```

Alternativa sin dependencias: `storeConfig: { file: './store.json' }` (dump JSON del `MemoryStore`). Sin almacenamiento durable, `.persistent()` sigue funcionando dentro de la misma ejecución (checkpoints en memoria) pero un reinicio empieza de cero.

## Ver también

- [README — Quickstart](https://github.com/andresayac/bot-wa-baileys#readme)
- [`docs/public/llms.txt`](public/llms.txt) — resumen de la API completa en un solo archivo
