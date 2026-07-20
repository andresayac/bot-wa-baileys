# Enviar media

Recetas para enviar fotos, videos, audios, stickers y más. En cualquier lugar
donde veas un argumento `source` (`MediaSource`), puede ser una URL, la ruta
de un archivo local, o un `Buffer`.

## Configuración

```ts
import { Bot } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })
```

## Foto

```ts
bot.when('photo', async (ctx) => {
  await ctx.photo('https://picsum.photos/400/300', '📸 Random photo')
})
```

## Foto desde un archivo local

```ts
bot.when('logo', async (ctx) => {
  await ctx.photo('./assets/logo.png', '🖼️ Our logo')
})
```

## Sticker

```ts
bot.when('sticker', async (ctx) => {
  await ctx.reply('🎨 Generating sticker...')
  try {
    await ctx.sticker('https://picsum.photos/512/512', {
      pack: 'My Bot',
      author: 'me',
    })
  } catch (err) {
    await ctx.reply('❌ Failed: ' + (err as Error).message)
  }
})
```

## Nota de voz

```ts
bot.when('audio', async (ctx) => {
  await ctx.reply('🎵 Sending audio...')
  await ctx.voice('https://example.com/audio.mp3')
})
```

## Video

```ts
bot.when('video', async (ctx) => {
  await ctx.video('https://example.com/video.mp4', '🎬 My video')
})
```

## Archivo

```ts
bot.when('file', async (ctx) => {
  await ctx.file('https://example.com/doc.pdf', 'document.pdf', '📄 Here')
})
```

## Ubicación

```ts
bot.when('location', async (ctx) => {
  await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
})
```

## Contacto

```ts
bot.when('contact', async (ctx) => {
  await ctx.contact('573001234567', 'Support Bot')
})
```

## Encuesta

```ts
bot.when('poll', async (ctx) => {
  await ctx.poll('How is the bot?', ['👍 Great', '👌 Good', '👎 Bad'])
})

// Multi-select
bot.when('poll-multi', async (ctx) => {
  await ctx.poll('What do you like?', ['🍕', '🍔', '🌮'], true)
})
```

## Recibir una imagen y responder con un sticker

`ctx.media` ya es el payload cargado (no es una promesa) — no hace falta
hacerle `await`:

```ts
bot.onImage(async (ctx) => {
  await ctx.reply('📸 Got your image. Converting to sticker...')
  if (ctx.media?.buffer) {
    await ctx.sticker(ctx.media.buffer, { pack: 'My Bot', author: 'me' })
  }
})
```

## Enviar media fuera de un handler — bot.send

`bot.send` recibe un objeto de contenido estilo Baileys y un JID
(`'573001112233@s.whatsapp.net'` para un usuario, `'...@g.us'` para un grupo):

```ts
bot.every('30 minutes', async () => {
  await bot.send('573001112233@s.whatsapp.net', {
    image: { url: 'https://picsum.photos/400/300' },
    caption: '📸 Scheduled photo',
  })
})
```

## Iniciar el bot

```ts
await bot.start()
```

## Siguientes pasos

- [Flujo de registro](./flujo-registro) — conversación multi-paso
- [Mensajes](./mensajes) — más recetas de texto
