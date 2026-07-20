# FAQ

## Do I need to scan the QR every time?

**No.** The session is saved in `./sessions/`. You only scan the QR the first
time. If the session is invalidated (you deleted the folder or WhatsApp
unlinked the device), you'll need to scan again.

## Can I use the bot without scanning QR?

Yes, with **pairing code**:

```js
const bot = new Bot({
  session: 'my-bot',
  pairingCode: '+57300XXXXXXX',
})
```

## Does the bot work in groups?

Yes. `when()` handlers work in groups by default. To respond only in private:

```js
bot.when('hi', async (ctx) => {
  if (ctx.isGroup) return
  await ctx.reply('👋')
})
```

## Can I send messages without someone writing first?

Yes, with `bot.sendText`:

```js
bot.schedule('0 9 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 Good morning!')
})
```

## How do I stop the bot properly?

```js
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down...')
  await bot.stop()
  process.exit(0)
})
```

## Can I have multiple bots in the same process?

Yes, with different sessions:

```js
const bot1 = new Bot({ session: 'bot-1' })
const bot2 = new Bot({ session: 'bot-2' })
await bot1.start()
await bot2.start()
```

## Does it work with WhatsApp Business?

Yes. The bot works with both personal and WhatsApp Business accounts.

## Can my account get banned?

WhatsApp can detect excessive automation. To minimize risk:

- Don't send spam or mass messages
- Use `markOnlineOnConnect: false`
- Respect rate limits
- Don't reply instantly to everything (use human delays)

## Do I need TypeScript?

**No.** All examples work in plain JavaScript. TypeScript gives you
autocomplete and type-checking, but it's optional.

## Where is the full API reference?

At the [API Reference](/api/) — generated with TypeDoc from the source code.

## Still having problems?

- [Open an issue on GitHub](https://github.com/andresayac/bot-wa-baileys/issues)
- [Check the examples](/examples/messages)