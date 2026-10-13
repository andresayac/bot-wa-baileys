# Conceptos básicos

Entiende cómo el **Dispatcher** decide qué pasa con cada mensaje entrante, y
las piezas con las que compones un bot.

## El pipeline del Dispatcher

Todo mensaje entrante pasa por el mismo pipeline, en este orden. Lo primero
que **consume** el mensaje gana y detiene el pipeline:

```mermaid
flowchart TD
    A[Entra un mensaje] --> B["hooks before('message')"]
    B --> C{"¿Es un comando? ej. /reset"}
    C -->|Sí| D[Handler del comando]
    C -->|No| E{¿Hay una conversación activa<br/>para este participante?}
    E -->|Sí| F[Continúa el paso de la conversación / flujo]
    E -->|No| R{¿Checkpoint dormido de un<br/>flujo persistente?}
    R -->|Sí| F
    R -->|No| G{¿Coincide con when/onType,<br/>por especificidad?}
    G -->|Sí| H[Se ejecuta el handler]
    G -->|"Sin match / ctx.pass()"| I[onMessage catch-all]
    D --> J["hooks after('message')"]
    F --> J
    H --> J
    I --> J
    J --> K["se emite el evento 'message'"]
```

1. **Los comandos** (`/reset`, `/help`, ...) siempre ganan — incluso sobre
   una conversación activa. Eso es lo que le permite a `/reset` escapar de
   un flujo atascado.
2. **Conversación activa** — si este participante ya inició un `flow` o un
   `bot.conversation` que está esperando una respuesta, el mensaje va ahí.
3. **Reanudación dormida** — si un flujo `.persistent()` quedó guardado como
   checkpoint en el store (p. ej. antes de un reinicio), el flujo se reanuda
   en el paso guardado.
4. **Matchers** registrados con `bot.when(...)`, probados por especificidad
   (una coincidencia exacta de string/`equals` gana sobre un regex amplio o
   un handler de tipo de media como `onImage`).
5. **`bot.onMessage()`** — el catch-all, se ejecuta **solo** si nada de lo
   anterior consumió el mensaje.

Los handlers **consumen por defecto**: una vez que uno se ejecuta, el
pipeline se detiene ahí. Llama a `ctx.pass()` dentro de un handler para
ceder el turno al siguiente handler que coincida en lugar de detenerse —
así es como los handlers de baja especificidad como `onImage`/`onType`
cooperan con un `when` más amplio:

```ts
bot.when(/.+/, async (ctx) => {
  if (ctx.type === 'image') { ctx.pass(); return } // cede el turno al siguiente handler
  await ctx.reply('text received')
})

bot.onImage(async (ctx) => {
  await ctx.reply('image received') // ahora se alcanza, porque el handler de arriba hizo pass
})
```

### 1. Bot + Provider — el centro

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({ provider: new BaileysProvider({ session: 'my-bot' }) })
await bot.start()
```

El `Bot` (de `@bot-wa/core`) es el motor agnóstico de transporte: ejecuta
el Dispatcher, los hooks, los flujos, las conversaciones y el scheduler.
El **provider** es la frontera del transporte — `@bot-wa/baileys` se
conecta a WhatsApp; `@bot-wa/meta` (Cloud API oficial), `@bot-wa/telegram`
y los transportes experimentales de Messenger, Instagram y Discord se
enchufan al mismo motor. Todos los transportes
alimentan al bot con los mismos eventos normalizados.

### 2. when — respuestas simples

```ts
bot.when('hola', async (ctx) => {
  await ctx.reply('👋 Hello!')
})
```

**Cuando** el mensaje coincide con el trigger, ejecuta esta función. La
estrategia de coincidencia por defecto es **igualdad normalizada**:
minúsculas, sin acentos, espacios colapsados — `'hola'` coincide con
"hola"/"Hóla ", pero NO con "/hola" ni "hola amigo". Los triggers aceptan
texto, una lista, un regex, un predicado, o un objeto explícito
`{ pattern, match, scope }`:

```ts
bot.when('hola', handler)
bot.when(['bye', 'goodbye'], handler)
bot.when(/\d{4,}/, handler)
bot.when({ pattern: 'factura', match: 'contains' }, handler) // estilo v1: "contains"
```

### 3. flow / conversation — conversaciones multi-paso

```ts
const register = flow('registrar')
  .ask('Name?', 'name')
  .say((_ctx, c) => `Hi ${c.state.name}`)

bot.use(register)
```

Un **flow** compila a una conversación async real: el bot pregunta, el
usuario responde, `c.state` lo guarda y el flujo continúa — con
validación, reintentos, branching (`choose`) y timeouts. Para tener control
manual total puedes saltarte el DSL y escribir directamente
`bot.conversation(name, async (c, ctx) => {...})`.

### 4. Hooks — middleware (before / after / onError)

```ts
bot.before('message', async (ctx, next) => {
  console.log('📥', ctx.from, ctx.body)
  await next()
})

bot.after('message', async (ctx) => {
  console.log('📤 processed')
})

bot.onError('message', async (ctx, error) => {
  console.error('💥 error:', error)
})
```

Los hooks se ejecutan **antes** o **después** de cada mensaje, como el
middleware de Express. `'message'` es el evento principal de hooks;
`'send'` se dispara en cada envío saliente.

### 5. Plugins — funcionalidad empaquetada

```ts
bot.plug(slashCommandsPlugin, { greeting: 'Hi!' })
```

Un plugin es un paquete reutilizable que puede registrar hooks, handlers y
herramientas. `bot.plug()` devuelve una función `unplug()` que revierte
todo lo que registró.

## El evento `'message'` vs `onMessage()`

Se parecen pero no son lo mismo:

- `bot.on('message', ctx => ...)` se dispara para **todo** mensaje que el
  Dispatcher terminó de procesar — incluyendo los que un comando, una
  conversación activa, o un handler `when` ya consumieron.
- `bot.onMessage(ctx => ...)` es el **catch-all** — solo se ejecuta cuando
  nada más consumió el mensaje.

## Las conversaciones de grupo son por participante por defecto

En un grupo, dos participantes distintos que le hablan al bot en el mismo
chat obtienen **conversaciones independientes** por defecto (indexadas
internamente por `${from}:${sender}`). Usa `conversationScope: 'chat'` si
quieres una única conversación compartida por chat de grupo:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  conversationScope: 'chat',
})
```

## El objeto ctx — tu mejor amigo

```ts
bot.when('hola', async (ctx) => {
  console.log(ctx.body)        // texto del mensaje
  console.log(ctx.from)        // id del chat (opaco; un JID en WhatsApp/Baileys)
  console.log(ctx.sender)      // id del remitente (= from en DMs, participant en grupos)
  console.log(ctx.type)        // 'text', 'image', 'audio', ...
  console.log(ctx.isGroup)     // ¿es un grupo?

  await ctx.reply('text')
  await ctx.photo(url, 'caption')
  await ctx.poll('Question?', ['A', 'B'])
  await ctx.react('👍')

  const db = ctx.tools.db  // herramienta inyectada
})
```

## Ids de chat y remitente

`ctx.from` (chat) y `ctx.sender` (usuario) son **strings opacos** que el
provider resuelve — el core nunca inspecciona su forma. Para el transporte
Baileys resultan ser **JIDs** (Jabber IDs) de WhatsApp:

| Tipo | Formato | Ejemplo |
|---|---|---|
| Usuario | `number@s.whatsapp.net` | `573001234567@s.whatsapp.net` |
| Grupo | `id@g.us` | `120363xxx@g.us` |
| Newsletter | `id@newsletter` | `120363xxx@newsletter` |

No necesitas memorizar esto — `ctx.from` te da el id correcto en cualquier
transporte. Si necesitas la clave nativa del mensaje entrante (para
citarlo/editarlo/borrarlo con llamadas del provider), usa `ctx.ref`
(`{ id, chatId, native? }`).

## Siguientes pasos

- [Mensajes y media](./mensajes) — todos los tipos de respuesta
- [Flujos conversacionales](./flujos) — conversaciones complejas
- [Hooks](./hooks) — middleware y logging
- [Ejemplos](/es/ejemplos/mensajes) — recetas prácticas
