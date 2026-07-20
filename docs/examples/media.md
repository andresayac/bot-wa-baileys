# Send Media

Recipes for sending photos, videos, audio, stickers and more.

## Photo

```js
bot.when('photo', async (ctx) => {
  await ctx.photo('https://picsum.photos/400/300', '📸 Random photo')
})
```

## Sticker

```js
bot.when('sticker', async (ctx) => {
  await ctx.reply('🎨 Generating sticker...')
  try {
    await ctx.sticker('https://picsum.photos/512/512', {
      pack: 'My Bot',
      author: 'me',
    })
  } catch (err) {
    await ctx.reply('❌ Failed: ' + err.message)
  }
})
```

## Voice note

```js
bot.when('audio', async (ctx) => {
  await ctx.reply('🎵 Sending audio...')
  await ctx.voice('https://example.com/audio.mp3')
})
```

## Video

```js
bot.when('video', async (ctx) => {
  await ctx.video('https://example.com/video.mp4', '🎬 My video')
})
```

## File

```js
bot.when('file', async (ctx) => {
  await ctx.file('https://example.com/doc.pdf', 'document.pdf', '📄 Here')
})
```

## Location

```js
bot.when('location', async (ctx) => {
  await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
})
```

## Contact

```js
bot.when('contact', async (ctx) => {
  await ctx.contact('573001234567', 'Support Bot')
})
```

## Poll

```js
bot.when('poll', async (ctx) => {
  await ctx.poll('How is the bot?', ['👍 Great', '👌 Good', '👎 Bad'])
})

// Multi-select
bot.when('poll-multi', async (ctx) => {
  await ctx.poll('What do you like?', ['🍕', '🍔', '🌮'], true)
})
```

## Receive image, return as sticker

```js
bot.onImage(async (ctx) => {
  await ctx.reply('📸 Got your image. Converting to sticker...')
  const media = await ctx.media
  if (media?.buffer) {
    await ctx.sticker(media.buffer, { pack: 'My Bot', author: 'me' })
  }
})
```

## Next steps

- [Registration flow](./registration-flow) — multi-step conversation
- [Messages](./messages) — more text recipes