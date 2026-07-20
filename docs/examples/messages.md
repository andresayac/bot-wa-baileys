# Send Messages

Practical recipes for responding to text messages.

## Respond to text

```js
bot.when('hi', async (ctx) => {
  await ctx.reply('👋 Hello!')
})
```

## Multiple keywords

```js
bot.when(['bye', 'goodbye', 'see you'], async (ctx) => {
  await ctx.reply('👋 See you later!')
})
```

## Regex match

```js
bot.when(/\d{4,}/, async (ctx) => {
  await ctx.reply(`🔢 Detected a long number: "${ctx.body}"`)
})

bot.when(/[\w.]+@[\w.]+\.\w+/, async (ctx) => {
  await ctx.reply(`📧 Detected an email`)
})
```

## Quote the message

```js
bot.when('quote', async (ctx) => {
  await ctx.quote('Replying to your specific message')
})
```

## React with emoji

```js
bot.when('good', async (ctx) => { await ctx.react('👍') })
bot.when('love', async (ctx) => { await ctx.react('❤️') })
```

## Private only

```js
bot.when('private', async (ctx) => {
  if (ctx.isGroup) return
  await ctx.reply('This only works in private chat')
})
```

## Multi-line message

```js
bot.when('info', async (ctx) => {
  await ctx.reply([
    'ℹ️ *Bot info*',
    '',
    '• Version: 2.0.0',
    '• Engine: Baileys 7',
  ].join('\n'))
})
```

## Use sender name

```js
bot.when('who', async (ctx) => {
  const name = ctx.sender.pushName ?? 'unknown'
  await ctx.reply(`👋 Hi ${name}!`)
})
```

## Catch-all

```js
bot.onMessage(async (ctx) => {
  await ctx.reply('🤔 I did not recognize that. Send /help.')
})
```

## Next steps

- [Send media](./media) — photos, stickers, audio
- [Registration flow](./registration-flow) — multi-step conversation