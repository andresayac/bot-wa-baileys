# Your First Bot

Let's build a complete bot with commands, media and a conversation flow.

## The complete bot

```js
const { Bot, flow, slashCommandsPlugin } = require('@bot-wa/bot-wa-baileys')

// 1. Create the bot
const bot = new Bot({
  session: 'demo-bot',
  sessionsDir: './sessions',
  qr: { terminal: true, small: true },
  markOnlineOnConnect: false,
  ignoreNewsletters: true,
  ignoreBroadcasts: true,
})

// 2. Connection events
bot.on('ready', () => console.log('✅ Bot ready!'))
bot.on('qr', () => console.log('📱 Scan the QR with your WhatsApp'))

// 3. Built-in slash commands (/start, /help, /reset, /id, /ping)
bot.plug(slashCommandsPlugin, {
  greeting: '🤖 Hi! I am a bot. Send /help to see my commands.',
})

// 4. Simple responses
bot.when('hi', async (ctx) => {
  await ctx.reply('👋 Hello! What is your name?')
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

// 6. Registration flow
const register = flow('register')
  .say('📝 *Let us register you*')
  .say('What is your name?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('name', ctx.body)
  })
  .say('What is your email?', { capture: true })
  .validate((body) => {
    return body.includes('@') ? true : '❌ Invalid email, try again'
  })
  .say(async (ctx, { state }) => {
    return `✅ Registration complete!\n👤 ${state.get('name')}`
  })
  .end()

bot.use(register)

// 7. Catch-all
bot.onMessage(async (ctx) => {
  await ctx.reply('🤔 I did not recognize that. Send /help for commands.')
})

// 8. Start
bot.start()
```

## What each part does

### 1. Create the bot

`session` is your session name. It's saved in `./sessions/demo-bot/`.
If you close and reopen, **you don't need to scan the QR again**.

### 2. Connection events

Events that fire when the bot connects or shows the QR.

### 3. Slash commands

Installs `/start`, `/help`, `/reset`, `/id`, `/ping` — 5 commands for free.

### 4. Simple responses

When someone sends a message containing "hi", the bot responds.
Matching is **case-insensitive** and by **substring**.

### 5. Media

```js
await ctx.photo(url, 'caption')
await ctx.sticker(url, { pack, author })
await ctx.voice(url)
await ctx.location(lat, lng, name)
await ctx.contact(phone, name)
await ctx.poll(question, options)
```

### 6. Flows

Multi-step conversations. The user answers step by step and the bot
stores information between steps.

### 7. Catch-all

Runs when no `when()` or flow matches. It's the fallback.

## Run

```bash
node bot.js
```

Scan the QR and try sending: `hi`, `photo`, `sticker`, `register`.

## Next steps

- [Core concepts](./concepts) — understand how it works internally
- [Conversation flows](./flows) — complex conversations
- [Examples](/examples/messages) — more recipes