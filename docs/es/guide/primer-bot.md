# Tu primer bot

Vamos a crear un bot completo con comandos, media y un flujo conversacional.

## El bot completo

```ts
import { Bot, flow, slashCommandsPlugin } from '@bot-wa/bot-wa-baileys'

// 1. Crear el bot
const bot = new Bot({
  session: 'demo-bot',
  sessionsDir: './sessions',
  qr: { terminal: true, small: true },
  markOnlineOnConnect: false,
  ignoreNewsletters: true,
  ignoreBroadcasts: true,
})

// 2. Eventos de conexión
bot.on('ready', () => console.log('✅ Bot ready!'))
bot.on('qr', () => console.log('📱 Scan the QR with your WhatsApp'))

// 3. Comandos slash integrados (/start, /help, /reset, /cancel, /id, /ping)
bot.plug(slashCommandsPlugin, {
  greeting: '🤖 Hi! I am a bot. Send /help to see my commands.',
})

// 4. Respuestas simples
bot.when('hola', async (ctx) => {
  await ctx.reply('👋 Hello! Send "registrar" to try the registration flow.')
})

bot.when('info', async (ctx) => {
  await ctx.reply('ℹ️ I am a bot built with bot-wa-baileys v2')
})

// 5. Media
bot.when('photo', async (ctx) => {
  await ctx.photo('https://picsum.photos/400/300', '📸 Here is a photo')
})

bot.when('sticker', async (ctx) => {
  await ctx.sticker('https://picsum.photos/512/512', {
    pack: 'My Bot',
    author: 'me',
  })
})

// 6. Flujo de registro
const register = flow('registrar')
  .say('📝 *Let us register you*')
  .ask('What is your name?', 'name')
  .ask('What is your email?', 'email', {
    validate: (body) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Invalid email, try again',
  })
  .say((_ctx, c) => `✅ Registration complete!\n👤 ${c.state.name}\n📧 ${c.state.email}`)

bot.use(register)

// 7. Catch-all
bot.onMessage(async (ctx) => {
  await ctx.reply('🤔 I did not recognize that. Send /help for commands.')
})

// 8. Iniciar
await bot.start()
```

## Qué hace cada parte

### 1. Crear el bot

`session` es el nombre de tu sesión. Se guarda en `./sessions/demo-bot/`.
Si cierras y vuelves a abrir, **no necesitas escanear el QR de nuevo**.

### 2. Eventos de conexión

Eventos que se disparan cuando el bot se conecta o muestra el QR.

### 3. Comandos slash

Instala `/start`, `/help`, `/reset`, `/cancel`, `/id`, `/ping` — 6 comandos
gratis. Los comandos siempre ganan sobre una conversación activa, así que
`/reset` (o `/cancel`) siempre puede escapar de un flujo atascado.

### 4. Respuestas simples

`bot.when(trigger, handler)` compara por **igualdad normalizada por
defecto** (minúsculas, sin acentos, espacios colapsados) — `'hola'`
coincide solo con un "hola"/"Hóla " exacto, no con "hola amigo". Usa
`{ pattern: 'hola', match: 'contains' }` si quieres coincidencia por
subcadena.

### 5. Media

```ts
await ctx.photo(url, 'caption')
await ctx.sticker(url, { pack, author })
await ctx.voice(url)
await ctx.location(lat, lng, name)
await ctx.contact(phone, name)
await ctx.poll(question, options)
```

### 6. Flujos

Conversaciones multi-paso. `flow('registrar')` compila a una conversación
real: `.ask(text, key)` envía `text`, espera la respuesta, y la guarda en
`c.state[key]`. La forma función de `.say((ctx, c) => ...)` puede leer todo
lo capturado hasta ahora vía `c.state`.

### 7. Catch-all

`bot.onMessage()` se ejecuta solo cuando nada más (un comando, una
conversación activa, o un matcher `when`/flow) ya consumió el mensaje.

## Ejecutar

```bash
node bot.js
```

Escanea el QR y prueba enviando: `hola`, `photo`, `sticker`, `registrar`.

## Siguientes pasos

- [Conceptos básicos](./conceptos) — entiende cómo funciona internamente
- [Flujos conversacionales](./flujos) — conversaciones complejas
- [Ejemplos](/es/ejemplos/mensajes) — más recetas
