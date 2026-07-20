# Mensajes y media

Todo lo que puedes enviar y recibir.

## Helpers de respuesta (dentro de un handler)

Todos estos apuntan a `ctx.from` y devuelven `Promise<SentMessage>`.
`reply`, `say`, `answer` y `text` son alias equivalentes:

```ts
await ctx.reply('👋 Hello!')
await ctx.say('How are you?')          // alias
await ctx.answer('👍')                  // alias
await ctx.text('plain text')            // alias
await ctx.quote('replying to your message')     // cita el mensaje entrante
await ctx.replyWithTyping('typing this out...') // muestra "escribiendo…" antes de enviar
```

## Enviar foto

```ts
await ctx.photo('https://picsum.photos/400/300', '📸 caption')
await ctx.photo('./photo.jpg', 'caption')  // archivo local
await ctx.photo(buffer, 'caption')          // Buffer
```

## Enviar video

```ts
await ctx.video(url, 'caption')
await ctx.video(url, 'caption', { gifPlayback: true })  // GIF
await ctx.video(url, 'caption', { ptv: true })           // video circular
```

## Enviar audio y nota de voz

```ts
await ctx.audio(url)   // audio
await ctx.voice(url)   // nota de voz (PTT)
```

## Enviar archivo

```ts
await ctx.file(url, 'document.pdf', 'caption')
```

## Enviar sticker

```ts
await ctx.sticker(url, { pack: 'My Pack', author: 'me' })
```

## Enviar ubicación

```ts
await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
```

## Enviar contacto

```ts
await ctx.contact('573001234567', 'Support Bot')
```

## Sin botones nativos — usa un menú o una encuesta

Los botones/listas interactivos nativos están muertos en el protocolo
actual de WhatsApp Web, así que no existe `ctx.buttons()`. Usa un menú
numerado (`.choose()` en un flow, o `c.choose()` en una conversación — ver
[Flujos](./flujos)) o una encuesta real de WhatsApp:

```ts
// Selección única
await ctx.poll('What do you prefer?', ['Option A', 'Option B'])

// Selección múltiple
await ctx.poll('What do you like?', ['🍕 Pizza', '🍔 Burger'], true)
```

## Reaccionar

```ts
await ctx.react('👍')
await ctx.react('❤️')
```

## Otras acciones

```ts
await ctx.markRead()   // marca el mensaje entrante como leído
await ctx.typing()     // muestra "escribiendo…"
await ctx.recording()  // muestra "grabando audio…"
await ctx.delete()     // elimina el mensaje entrante (si está permitido)
```

## Recibir media

```ts
bot.onImage(async (ctx) => { await ctx.reply('📸 Got your image!') })
bot.onAudio(async (ctx) => { await ctx.reply('🎵 Got your audio') })
bot.onVideo(async (ctx) => { await ctx.reply('🎬 Got your video') })
bot.onSticker(async (ctx) => { await ctx.reply('🎨 Got your sticker!') })
bot.onDocument(async (ctx) => { await ctx.reply('📄 Got your file') })
bot.onLocation(async (ctx) => { await ctx.reply('📍 Got your location') })
bot.onContact(async (ctx) => { await ctx.reply('👤 Got your contact') })
bot.onPoll(async (ctx) => { await ctx.reply('📊 Got your poll') })
```

`onImage`/`onAudio`/etc. son matchers de baja especificidad: un
`bot.when(...)` más específico que también coincida gana primero, a menos
que llame a `ctx.pass()`.

## Acceder al contenido del media

`ctx.media` es un campo plano (no una promesa) presente siempre que el
mensaje entrante trae media:

```ts
bot.onImage(async (ctx) => {
  if (ctx.media) {
    console.log(ctx.media.mimetype)  // 'image/jpeg'
    console.log(ctx.media.buffer)    // Buffer
    console.log(ctx.media.size)      // bytes
  }
})
```

## El `MessageContext` completo

Además de los helpers de respuesta, cada handler recibe campos de datos en
`ctx`: `ctx.body`, `ctx.from` (id del chat), `ctx.sender` (JID; = `from` en
DMs, participant en grupos), `ctx.senderInfo`, `ctx.pushName`, `ctx.chat`
(`{ id, name?, isGroup, isBroadcast, participants? }`), `ctx.type`,
`ctx.isGroup` / `ctx.isPrivate` / `ctx.isFromMe`, `ctx.mentions`,
`ctx.quoted?`, `ctx.media?`, `ctx.timestamp`, `ctx.tools` (registro de DI),
`ctx.rawMessage`, `ctx.key`.

## Enviar fuera de un handler

Para escribirle a alguien sin esperar a que escriba primero — p. ej. desde
una [tarea programada](./scheduler) — usa la instancia del bot directamente:

```ts
await bot.sendText('573001234567@s.whatsapp.net', '🌅 Good morning!')
await bot.send('573001234567@s.whatsapp.net', { image: { url }, caption: 'hi' })
await bot.broadcast(
  ['573001234567@s.whatsapp.net', '573001112233@s.whatsapp.net'],
  { text: 'Announcement!' },
)
```

## Siguientes pasos

- [Flujos conversacionales](./flujos) — conversaciones multi-paso
- [Ejemplos](/es/ejemplos/media) — recetas de media completas
