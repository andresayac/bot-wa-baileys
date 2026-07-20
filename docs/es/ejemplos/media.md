# Enviar media

Recetas para enviar fotos, videos, audios, stickers y más.

## Foto

```js
bot.when('foto', async (ctx) => {
  await ctx.photo('https://picsum.photos/400/300', '📸 Foto aleatoria')
})
```

## Sticker

```js
bot.when('sticker', async (ctx) => {
  await ctx.reply('🎨 Generando sticker...')
  try {
    await ctx.sticker('https://picsum.photos/512/512', {
      pack: 'Mi Bot',
      author: 'yo',
    })
  } catch (err) {
    await ctx.reply('❌ No pude generar el sticker: ' + err.message)
  }
})
```

## Audio (nota de voz)

```js
bot.when('audio', async (ctx) => {
  await ctx.reply('🎵 Enviando audio...')
  await ctx.voice('https://example.com/audio.mp3')
})
```

## Video

```js
bot.when('video', async (ctx) => {
  await ctx.video('https://example.com/video.mp4', '🎬 Mi video')
})
```

## Archivo

```js
bot.when('archivo', async (ctx) => {
  await ctx.file('https://example.com/doc.pdf', 'documento.pdf', '📄 Aquí está')
})
```

## Ubicación

```js
bot.when('ubicacion', async (ctx) => {
  await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
})
```

## Contacto

```js
bot.when('contacto', async (ctx) => {
  await ctx.contact('573001234567', 'Soporte Bot')
})
```

## Encuesta

```js
// Selección única
bot.when('encuesta', async (ctx) => {
  await ctx.poll(
    '¿Qué te parece el bot?',
    ['👍 Excelente', '👌 Bueno', '👎 Regular'],
  )
})

// Selección múltiple
bot.when('encuesta-multi', async (ctx) => {
  await ctx.poll(
    '¿Qué te gusta?',
    ['🍕 Pizza', '🍔 Hamburguesa', '🌮 Tacos', '🍜 Ramen'],
    true,  // multiSelect
  )
})
```

## Recibir imagen y devolverla como sticker

```js
bot.onImage(async (ctx) => {
  await ctx.reply('📸 Recibí tu imagen. Convirtiendo a sticker...')
  const media = await ctx.media
  if (media?.buffer) {
    await ctx.sticker(media.buffer, { pack: 'Mi Bot', author: 'yo' })
  }
})
```

## Recibir audio

```js
bot.onAudio(async (ctx) => {
  await ctx.reply('🎵 Recibí tu audio. No puedo transcribirlo todavía.')
})
```

## Recibir sticker

```js
bot.onSticker(async (ctx) => {
  await ctx.reply('🎨 ¡Sticker recibido!')
})
```

## Siguientes pasos

- [Flujo de registro](./flujo-registro) — conversación multi-paso
- [Mensajes](./mensajes) — más recetas de texto