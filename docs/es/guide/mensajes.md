# Mensajes y media

Todo lo que puedes enviar y recibir con el bot.

## Enviar texto

```js
bot.when('hola', async (ctx) => {
  await ctx.reply('👋 ¡Hola!')
  await ctx.say('¿Cómo estás?')        // alias de reply
  await ctx.text('texto')              // alias
  await ctx.answer('texto')            // alias
  await ctx.quote('respondiendo a tu mensaje')  // citando el mensaje original
})
```

::: tip reply vs quote
`reply` envía texto plano. `quote` envía texto citando el mensaje original
(aparece como "respondiendo a...").
:::

## Enviar foto

```js
// Desde una URL
await ctx.photo('https://picsum.photos/400/300', '📸 caption opcional')

// Desde un archivo local
await ctx.photo('./foto.jpg', 'caption')

// Desde un Buffer
await ctx.photo(buffer, 'caption')
```

## Enviar video

```js
await ctx.video('https://example.com/video.mp4', 'caption')
await ctx.video(url, 'caption', { gifPlayback: true })  // GIF
await ctx.video(url, 'caption', { ptv: true })           // video circular
```

## Enviar audio y nota de voz

```js
await ctx.audio(url)   // audio normal
await ctx.voice(url)   // nota de voz (PTT — push to talk)
```

::: warning Audio debe ser OGG Opus
WhatsApp requiere que las notas de voz estén en formato OGG Opus. El framework
transcodifica automáticamente con ffmpeg.
:::

## Enviar archivo

```js
await ctx.file(url, 'documento.pdf', 'caption opcional')
```

## Enviar sticker

```js
await ctx.sticker(url, {
  pack: 'Mi paquete',
  author: 'Mi nombre',
})
```

El framework genera el sticker automáticamente con sharp.

## Enviar ubicación

```js
await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
//                    lat      lng        nombre
```

## Enviar contacto

```js
await ctx.contact('573001234567', 'Soporte Bot')
//                   teléfono        nombre
```

## Enviar encuesta

```js
// Encuesta de selección única
await ctx.poll('¿Qué prefieres?', ['Opción A', 'Opción B', 'Opción C'])

// Encuesta de selección múltiple
await ctx.poll('¿Qué te gusta?', ['🍕 Pizza', '🍔 Hamburguesa', '🌮 Tacos'], true)
//                                                                                  ^^^^
//                                                                              multiSelect = true
```

## Reaccionar a un mensaje

```js
await ctx.react('👍')
await ctx.react('❤️')
await ctx.react('😂')
```

## Responder con typing simulado

```js
await ctx.replyWithTyping('Escribiendo lentamente...')
// Simula "escribiendo..." antes de enviar, con delay por carácter
```

## Recibir media

Para **recibir** imágenes, audios, stickers, etc., usa los handlers tipados:

```js
bot.onImage(async (ctx) => {
  await ctx.reply('📸 ¡Recibí tu imagen!')
})

bot.onAudio(async (ctx) => {
  await ctx.reply('🎵 Recibí tu audio')
})

bot.onVideo(async (ctx) => {
  await ctx.reply('🎬 Recibí tu video')
})

bot.onSticker(async (ctx) => {
  await ctx.reply('🎨 ¡Sticker recibido!')
})

bot.onDocument(async (ctx) => {
  await ctx.reply('📄 Recibí tu archivo')
})

bot.onLocation(async (ctx) => {
  await ctx.reply('📍 Recibí tu ubicación')
})

bot.onContact(async (ctx) => {
  await ctx.reply('👤 Recibí tu contacto')
})

bot.onPoll(async (ctx) => {
  await ctx.reply('📊 Recibí tu encuesta')
})
```

## Acceder al contenido del media

```js
bot.onImage(async (ctx) => {
  // ctx.media se llena automáticamente al acceder
  const media = await ctx.media
  if (media) {
    console.log(media.mimetype)  // 'image/jpeg'
    console.log(media.buffer)    // Buffer con los bytes
    console.log(media.filename)  // nombre si está disponible
  }
})
```

## Siguientes pasos

- [Flujos conversacionales](./flujos) — conversaciones multi-paso
- [Ejemplos de media](/es/ejemplos/media) — recetas completas