# Messages & Media

Everything you can send and receive.

## Send text

```js
await ctx.reply('👋 Hello!')
await ctx.say('How are you?')        // alias
await ctx.quote('replying to your message')  // quoting
```

## Send photo

```js
await ctx.photo('https://picsum.photos/400/300', '📸 caption')
await ctx.photo('./photo.jpg', 'caption')  // local file
await ctx.photo(buffer, 'caption')          // Buffer
```

## Send video

```js
await ctx.video(url, 'caption')
await ctx.video(url, 'caption', { gifPlayback: true })  // GIF
await ctx.video(url, 'caption', { ptv: true })           // circular video
```

## Send audio & voice

```js
await ctx.audio(url)   // audio
await ctx.voice(url)   // voice note (PTT)
```

## Send file

```js
await ctx.file(url, 'document.pdf', 'caption')
```

## Send sticker

```js
await ctx.sticker(url, { pack: 'My Pack', author: 'me' })
```

## Send location

```js
await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
```

## Send contact

```js
await ctx.contact('573001234567', 'Support Bot')
```

## Send poll

```js
// Single select
await ctx.poll('What do you prefer?', ['Option A', 'Option B'])

// Multi select
await ctx.poll('What do you like?', ['🍕 Pizza', '🍔 Burger'], true)
```

## React

```js
await ctx.react('👍')
await ctx.react('❤️')
```

## Receive media

```js
bot.onImage(async (ctx) => { await ctx.reply('📸 Got your image!') })
bot.onAudio(async (ctx) => { await ctx.reply('🎵 Got your audio') })
bot.onVideo(async (ctx) => { await ctx.reply('🎬 Got your video') })
bot.onSticker(async (ctx) => { await ctx.reply('🎨 Got your sticker!') })
bot.onDocument(async (ctx) => { await ctx.reply('📄 Got your file') })
bot.onLocation(async (ctx) => { await ctx.reply('📍 Got your location') })
bot.onContact(async (ctx) => { await ctx.reply('👤 Got your contact') })
bot.onPoll(async (ctx) => { await ctx.reply('📊 Got your poll') })
```

## Access media content

```js
bot.onImage(async (ctx) => {
  const media = await ctx.media
  if (media) {
    console.log(media.mimetype)  // 'image/jpeg'
    console.log(media.buffer)     // Buffer
  }
})
```

## Next steps

- [Conversation flows](./flows) — multi-step conversations
- [Examples](/examples/media) — full media recipes