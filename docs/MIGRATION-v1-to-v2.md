# Guía de migración v1 → v2

`@bot-wa/bot-wa-baileys` v2 es un **rewrite del core**, no un parche sobre la v1. Cambian los nombres (`BaileysClass` → `Bot`), pero también cambia el motor por debajo: el viejo "router de mensajes" y el engine de flujos por arrays de pasos desaparecen, reemplazados por un **Dispatcher** con prioridad por especificidad y un **runtime de conversaciones async** sobre el que se compila el DSL declarativo (`flow()`).

Si tu bot v1 es simple (unos cuantos `addKeyword`/respuestas de texto), la migración es mecánica. Si usa flujos con `capture` anidados, botones, o depende de que `bot.on('message')` reciba *todos* los mensajes, lee también la sección de [cambios de comportamiento](#cambios-de-comportamiento-en-v2) — hay diferencias de semántica, no solo de nombres.

## Tabla de cambios

| v1 | v2 |
|---|---|
| `new BaileysClass(opts)` | `new Bot(config)` + `await bot.start()` |
| `bot.on('message', ...)` global | `bot.onMessage()` (catch-all, corre solo si nada más consumió el mensaje) o `bot.when(trigger, handler)` |
| `addKeyword().addAnswer(txt, { capture })` | `flow(trigger).say(txt)` / `.ask(txt, stateKey)` (alias de compatibilidad: `addKeyword = flow`) |
| `sendText/sendImage/sendVideo/sendAudio/sendFile/...` | Conservados en `bot.sendText`/`bot.send` + los helpers de contexto `ctx.reply/photo/video/audio/file/...` |
| Eventos `qr` / `ready` | Iguales: `bot.on('qr', (qr) => ...)`, `bot.on('ready', () => ...)` |
| `auth_failure` | `bot.on('error', ({ error, ctx }) => ...)` |
| `sendButtons` (ya deprecado en v1) | **Eliminado.** Usa `c.choose()` / `.choose()` (menú numerado) o `ctx.poll()` |

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
// v2
import { Bot } from '@bot-wa/bot-wa-baileys'
const bot = new Bot({ session: 'mi-bot' })
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
import { flow } from '@bot-wa/bot-wa-baileys'

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
// v2 — dentro de un flow
bot.use(
  flow('confirmar')
    .choose('¿Confirmas tu pedido?', { si: 'Sí', no: 'No' })
    .say((_ctx, c) => c.state ? '✅ Confirmado' : '')
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
const bot = new Bot({ conversationScope: 'chat' })
```

### e) ESM-only + Node >= 20

El paquete es **ESM puro** (`"type": "module"`, sin build CommonJS). Tu proyecto debe:

- Tener `"type": "module"` en su propio `package.json`, **o**
- Usar extensión `.mjs`, **o**
- Estar en Node **>= 22.12**, donde `require('@bot-wa/bot-wa-baileys')` funciona vía el soporte experimental de Node para `require(esm)`.

Mínimo soportado: **Node >= 20**. Baileys 7 (el motor de transporte) también es ESM-only — es una de las razones por las que la v2 no ofrece un build CJS.

## Ver también

- [README — Quickstart](../README.md#quickstart-30-segundos)
- [`docs/public/llms.txt`](public/llms.txt) — resumen de la API completa en un solo archivo
