# Send Media

Recipes for sending photos, videos, audio, stickers and more. Everywhere you
see a `source` argument (`MediaSource`), it can be a URL string, a local file
path string, or a `Buffer`.

## Setup

```ts
import { Bot } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo-bot', qr: { terminal: true, small: true } }),
})
```

## Photo

```ts
bot.when('photo', async (ctx) => {
  await ctx.photo('https://picsum.photos/400/300', '📸 Random photo')
})
```

## Photo from a local file

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

## Voice note

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

## File

```ts
bot.when('file', async (ctx) => {
  await ctx.file('https://example.com/doc.pdf', 'document.pdf', '📄 Here')
})
```

## Location

```ts
bot.when('location', async (ctx) => {
  await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
})
```

## Contact

```ts
bot.when('contact', async (ctx) => {
  await ctx.contact('573001234567', 'Support Bot')
})
```

## Poll

```ts
bot.when('poll', async (ctx) => {
  await ctx.poll('How is the bot?', ['👍 Great', '👌 Good', '👎 Bad'])
})

// Multi-select
bot.when('poll-multi', async (ctx) => {
  await ctx.poll('What do you like?', ['🍕', '🍔', '🌮'], true)
})
```

## Receive an image, reply with a sticker

Inbound media is downloaded on demand: `loadMediaOf(ctx)` fetches the bytes
once and leaves them on `ctx.media` (see
[Access media content](/guide/messages#access-media-content)):

```ts
import { loadMediaOf } from '@botmesh/core'

bot.onImage(async (ctx) => {
  await ctx.reply('📸 Got your image. Converting to sticker...')
  const media = await loadMediaOf(ctx, { maxBytes: 5 * 1024 * 1024 })
  if (media) {
    await ctx.sticker(media.buffer, { pack: 'My Bot', author: 'me' })
  }
})
```

## Send media outside a handler — bot.send

`bot.send` takes a transport-neutral content object (`{ kind, ... }`) and a
chat id (`'573001112233@s.whatsapp.net'` for a WhatsApp user, `'...@g.us'`
for a group):

```ts
bot.every('30 minutes', async () => {
  await bot.send('573001112233@s.whatsapp.net', {
    kind: 'image',
    media: { url: 'https://picsum.photos/400/300' },
    caption: '📸 Scheduled photo',
  })
})
```

## Start the bot

```ts
await bot.start()
```

## Next steps

- [Registration flow](./registration-flow) — multi-step conversation
- [Messages](./messages) — more text recipes
