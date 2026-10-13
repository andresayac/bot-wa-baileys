# Send Messages

Practical recipes for responding to text messages.

## Setup

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo-bot', qr: { terminal: true, small: true } }),
})
```

## Respond to text

```ts
bot.when('hi', async (ctx) => {
  await ctx.reply('👋 Hello!')
})
```

## Multiple keywords

```ts
bot.when(['bye', 'goodbye', 'see you'], async (ctx) => {
  await ctx.reply('👋 See you later!')
})
```

## Regex match

```ts
bot.when(/\d{4,}/, async (ctx) => {
  await ctx.reply(`🔢 Detected a long number: "${ctx.body}"`)
})

bot.when(/[\w.]+@[\w.]+\.\w+/, async (ctx) => {
  await ctx.reply('📧 Detected an email')
})
```

## Match "contains" instead of exact

By default a string trigger only matches when the (normalized) message
**equals** it — `bot.when('invoice', ...)` does NOT match "check my invoice
please". Use a `TriggerObject` with `match: 'contains'` for the old
"contains" behavior:

```ts
bot.when({ pattern: 'invoice', match: 'contains' }, async (ctx) => {
  await ctx.reply('🧾 I see you mentioned an invoice')
})
```

`match` also supports `'startsWith'` and `'endsWith'`.

## Quote the message

```ts
bot.when('quote', async (ctx) => {
  await ctx.quote('Replying to your specific message')
})
```

## React with emoji

```ts
bot.when('good', async (ctx) => { await ctx.react('👍') })
bot.when('love', async (ctx) => { await ctx.react('❤️') })
```

## Private only

```ts
bot.when('private', async (ctx) => {
  if (ctx.isGroup) return
  await ctx.reply('This only works in private chat')
})
```

## Multi-line message

```ts
bot.when('info', async (ctx) => {
  await ctx.reply([
    'ℹ️ *Bot info*',
    '',
    '• Version: 2.0.0',
    '• Engine: Baileys 7',
  ].join('\n'))
})
```

## Use sender info

```ts
bot.when('who', async (ctx) => {
  const name = ctx.senderInfo?.pushName ?? ctx.pushName ?? 'friend'
  await ctx.reply(`👋 Hi ${name}!`)
})
```

## No native buttons — use a poll

WhatsApp Web killed native buttons, so on Baileys a quick yes/no is best
done with a real poll (see [Send media](./media) for more poll options). On
the official Cloud API (`@bot-wa/meta`) it's the other way round: native
buttons work and polls don't, so use `ctx.buttons()` there.

```ts
bot.when('confirm', async (ctx) => {
  await ctx.poll('Do you confirm your order?', ['Yes', 'No'])
})
```

For a menu that branches into different logic per option, use
`flow().choose()` or `c.choose()` instead — see the
[Shopping flow](./shopping-flow) recipe.

## Catch-all

```ts
bot.onMessage(async (ctx) => {
  await ctx.reply('🤔 I did not recognize that. Send /help.')
})
```

## Start the bot

```ts
await bot.start()
```

## Next steps

- [Send media](./media) — photos, stickers, audio
- [Registration flow](./registration-flow) — multi-step conversation
