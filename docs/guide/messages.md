# Messages & Media

Everything you can send and receive.

## Reply helpers (inside a handler)

All of these target `ctx.from` and return `Promise<SentMessage>`. `reply`,
`say`, `answer` and `text` are all equivalent aliases:

```ts
await ctx.reply('👋 Hello!')
await ctx.say('How are you?')          // alias
await ctx.answer('👍')                  // alias
await ctx.text('plain text')            // alias
await ctx.quote('replying to your message')     // quotes the inbound message
await ctx.replyWithTyping('typing this out...') // shows "typing…" before sending
```

## Send photo

```ts
await ctx.photo('https://picsum.photos/400/300', '📸 caption')
await ctx.photo('./photo.jpg', 'caption')  // local file
await ctx.photo(buffer, 'caption')          // Buffer
```

## Send video

```ts
await ctx.video(url, 'caption')
await ctx.video(url, 'caption', { gifPlayback: true })  // GIF
await ctx.video(url, 'caption', { ptv: true })           // circular video
```

## Send audio & voice

```ts
await ctx.audio(url)   // audio
await ctx.voice(url)   // voice note (PTT)
```

## Send file

```ts
await ctx.file(url, 'document.pdf', 'caption')
```

## Send sticker

```ts
await ctx.sticker(url, { pack: 'My Pack', author: 'me' })
```

## Send location

```ts
await ctx.location(4.7110, -74.0721, 'Bogotá, Colombia 🇨🇴')
```

## Send contact

```ts
await ctx.contact('573001234567', 'Support Bot')
```

## Buttons: normalized, degraded per transport

`ctx.buttons(text, buttons)` sends normalized button content. How it lands
depends on the provider:

- **`@bot-wa/baileys`** — native interactive buttons are dead in the
  current WhatsApp Web protocol, so buttons degrade to a **numbered text
  menu**. A numbered menu (`.choose()` in a flow, or `c.choose()` in a
  conversation — see [Flows](./flows)) or a real poll usually reads better.
- **`@bot-wa/meta`** (Cloud API) — native interactive buttons/lists/templates.
- **`@bot-wa/telegram`** — native inline keyboards.

```ts
await ctx.buttons('Choose one', [
  { id: 'a', title: 'Option A' },
  { id: 'b', title: 'Option B' },
])

// Polls are native on Baileys and Telegram. The Cloud API has no polls:
// there, ctx.poll() rejects with UnsupportedContentError — use buttons.
await ctx.poll('What do you prefer?', ['Option A', 'Option B'])

// Multi select
await ctx.poll('What do you like?', ['🍕 Pizza', '🍔 Burger'], true)
```

If a provider cannot honor a content kind at all, `send` rejects with a
typed `UnsupportedContentError` from `@bot-wa/core`.

## React

```ts
await ctx.react('👍')
await ctx.react('❤️')
```

## Other actions

```ts
await ctx.markRead()   // mark the inbound message as read
await ctx.typing()     // show "typing…"
await ctx.recording()  // show "recording audio…"
await ctx.delete()     // delete the inbound message (if allowed)
```

Actions degrade to a no-op on providers that lack the capability.

## Receive media

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

`onImage`/`onAudio`/etc. are low-specificity matchers: a more specific
`bot.when(...)` that also matches wins first, unless it calls `ctx.pass()`.

## Access media content

`ctx.media` is a plain field (not a promise) present whenever the inbound
message carries media:

```ts
bot.onImage(async (ctx) => {
  if (ctx.media) {
    console.log(ctx.media.mimetype)  // 'image/jpeg'
    console.log(ctx.media.buffer)    // Buffer
    console.log(ctx.media.size)      // bytes
  }
})
```

## The full `MessageContext`

Besides the reply helpers, every handler receives data fields on `ctx`:
`ctx.body`, `ctx.from` (chat id), `ctx.sender` (user id; = `from` in DMs,
participant in groups), `ctx.senderInfo`, `ctx.pushName`, `ctx.chat`
(`{ id, kind, name?, isGroup, isBroadcast, participants? }`), `ctx.type`,
`ctx.isGroup` / `ctx.isPrivate` / `ctx.isFromMe`, `ctx.mentions`,
`ctx.quoted?`, `ctx.media?`, `ctx.timestamp`, `ctx.tools` (DI registry),
`ctx.raw` (provider-native payload), `ctx.ref` (the message reference —
`{ id, chatId, native? }`, replaces v1's `ctx.key`).

## Sending outside a handler

To message someone without waiting for them to write first — e.g. from a
[scheduled task](./scheduler) — use the bot instance directly. Content is
the transport-neutral tagged union (`{ kind, ... }`):

```ts
await bot.sendText('573001234567@s.whatsapp.net', '🌅 Good morning!')
await bot.send('573001234567@s.whatsapp.net', {
  kind: 'image',
  media: { url },
  caption: 'hi',
})
await bot.broadcast(
  ['573001234567@s.whatsapp.net', '573001112233@s.whatsapp.net'],
  { kind: 'text', text: 'Announcement!' },
)
```

## Next steps

- [Conversation flows](./flows) — multi-step conversations
- [Examples](/examples/media) — full media recipes
