# Tu primer bot

Vamos a crear un bot completo con comandos, media y un flujo conversacional.
Al final tendrás un bot que responde a texto, envía imágenes, genera stickers
y tiene una conversación de registro.

## El bot completo

```js
const { Bot, flow, slashCommandsPlugin } = require('@bot-wa/bot-wa-baileys')

// 1. Crear el bot
const bot = new Bot({
  session: 'demo-bot',
  sessionsDir: './sessions',
  qr: { terminal: true, small: true },
  markOnlineOnConnect: false,    // no robar notificaciones del teléfono
  ignoreNewsletters: true,
  ignoreBroadcasts: true,
})

// 2. Eventos de conexión
bot.on('ready', () => console.log('✅ ¡Bot listo!'))
bot.on('qr', () => console.log('📱 Escanea el QR con tu WhatsApp'))

// 3. Comandos slash integrados (/start, /help, /reset, /id, /ping)
bot.plug(slashCommandsPlugin, {
  greeting: '🤖 ¡Hola! Soy un bot. Envía /help para ver mis comandos.',
})

// 4. Respuestas simples
bot.when('hola', async (ctx) => {
  await ctx.reply('👋 ¡Hola! ¿Cómo te llamas?')
})

bot.when('info', async (ctx) => {
  await ctx.reply('ℹ️ Soy un bot hecho con bot-wa-baileys v2')
})

// 5. Media
bot.when('foto', async (ctx) => {
  await ctx.photo('https://picsum.photos/400/300', '📸 Aquí tienes una foto')
})

bot.when('sticker', async (ctx) => {
  await ctx.sticker('https://picsum.photos/512/512', {
    pack: 'Mi Bot',
    author: 'yo',
  })
})

// 6. Flujo de registro
const registro = flow('registrar')
  .say('📝 *Vamos a registrarte*')
  .say('¿Cuál es tu nombre?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('nombre', ctx.body)
  })
  .say('¿Cuál es tu email?', { capture: true })
  .validate((body) => {
    return body.includes('@') ? true : '❌ Email inválido, intenta de nuevo'
  })
  .say(async (ctx, { state }) => {
    return `✅ ¡Registro completo!\n👤 ${state.get('nombre')}`
  })
  .end()

bot.use(registro)

// 7. Mensaje por defecto (cuando no reconoce nada)
bot.onMessage(async (ctx) => {
  await ctx.reply('🤔 No reconocí eso. Envía /help para ver mis comandos.')
})

// 8. Iniciar
bot.start()
```

## Qué hace cada parte

### 1. Crear el bot

```js
const bot = new Bot({ session: 'demo-bot', ... })
```

`session` es el nombre de tu sesión. Se guarda en `./sessions/demo-bot/`.
Si cierras y vuelves a abrir, **no necesitas escanear el QR de nuevo**.

### 2. Eventos de conexión

```js
bot.on('ready', () => console.log('✅'))
bot.on('qr', () => console.log('📱'))
```

Eventos que se disparan cuando el bot se conecta o cuando muestra el QR.

### 3. Comandos slash

```js
bot.plug(slashCommandsPlugin, { greeting: '...' })
```

Instala el plugin de comandos `/start`, `/help`, `/reset`, `/id`, `/ping`.
Tu bot ya tiene 5 comandos sin escribir nada.

### 4. Respuestas simples

```js
bot.when('hola', async (ctx) => {
  await ctx.reply('👋 ¡Hola!')
})
```

Cuando alguien envía un mensaje que contiene "hola", el bot responde.
El matching es **case-insensitive** y por **subcadena** ("hola" coincide con
"holaa", "holaaa", "¡hola!").

### 5. Media

```js
await ctx.photo(url, 'caption')     // enviar foto
await ctx.sticker(url, { pack, author })  // generar sticker
await ctx.voice(url)                 // enviar nota de voz
await ctx.location(lat, lng, name)   // enviar ubicación
await ctx.contact(phone, name)       // enviar contacto
await ctx.poll(question, options)    // enviar encuesta
```

### 6. Flujos

Los flujos son conversaciones multi-paso. El usuario responde paso a paso
y el bot guarda información entre pasos.

### 7. Mensaje por defecto

```js
bot.onMessage(async (ctx) => {
  await ctx.reply('🤔 no reconocí eso')
})
```

Se ejecuta cuando ningún `when()` ni flujo coincide. Es el "catch-all".

## Ejecutar

```bash
node bot.js
```

Escanea el QR y prueba enviando: `hola`, `foto`, `sticker`, `registrar`.

## Siguientes pasos

- [Conceptos básicos](./conceptos) — entiende cómo funciona internamente
- [Flujos conversacionales](./flujos) — crea conversaciones complejas
- [Ejemplos](/es/ejemplos/mensajes) — más recetas