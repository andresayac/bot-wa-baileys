# FAQ

## Do I need to scan the QR every time?

**No.** The session is saved in `./sessions/`. You only scan the QR the first
time. If the session is invalidated (you deleted the folder or WhatsApp
unlinked the device), you'll need to scan again.

## Can I use the bot without scanning QR?

Yes, with a **pairing code** (Baileys transport):

```ts
const bot = new Bot({
  provider: new BaileysProvider({
    session: 'my-bot',
    pairingCode: '+57300XXXXXXX', // full international format
  }),
})

// v2 emits the auth artifact (QR string / pairing code) through the 'qr' event:
bot.on('qr', (artifact) => console.log('Auth artifact:', artifact))
```

There is no dedicated `pairing_code` event in v2 — the pairing code arrives
as the `qr` event payload (a string auth artifact the core forwards
verbatim from the provider).

## Does the bot work in groups?

Yes. `when()` handlers work in groups by default. To respond only in private:

```ts
bot.when('hola', async (ctx) => {
  if (ctx.isGroup) return
  await ctx.reply('👋')
})
```

In a group, each participant gets an **independent conversation** by
default when they trigger a flow — two people talking to the bot in the
same group don't share state. Set `conversationScope: 'chat'` if you want
one shared conversation per group instead.

## Why doesn't `bot.when('hi')` match "hi there"?

The default match strategy is **normalized equals**, not "contains" — the
message must equal the trigger exactly after lowercasing, stripping accents
and collapsing spaces. For substring matching, use a `TriggerObject`:

```ts
bot.when({ pattern: 'hi', match: 'contains' }, handler)
```

`match` also accepts `'startsWith'` and `'endsWith'`.

## Can I send buttons?

No — native interactive buttons/lists are dead in the current WhatsApp Web
protocol. Use a numbered menu (`.choose()` in a flow, `c.choose()` in a
conversation) or a real poll:

```ts
await ctx.poll('Confirm your order?', ['Yes', 'No'])
```

## Do flows/conversations survive a restart?

Only if you opt in. `flow(...).persistent()` checkpoints the conversation
after each step, but the default `MemoryStore` lives in memory — a restart
loses those checkpoints unless the store is file-backed:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'my-bot' }),
  storeConfig: { file: './store.json' }, // or use @bot-wa/sqlite-store
})
```

## Can I send messages without someone writing first?

Yes, with `bot.sendText`:

```ts
bot.schedule('0 9 * * *', async () => {
  await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 Good morning!')
})
```

## How do I stop the bot properly?

```ts
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down...')
  await bot.stop()
  process.exit(0)
})
```

## Can I have multiple bots in the same process?

Yes, with different providers/sessions:

```ts
const bot1 = new Bot({ provider: new BaileysProvider({ session: 'bot-1' }) })
const bot2 = new Bot({ provider: new BaileysProvider({ session: 'bot-2' }) })
await bot1.start()
await bot2.start()
```

You can even mix transports — one `Bot` per provider
(e.g. a Baileys bot and a `CloudAPIProvider` bot in the same process).

## Does it work with WhatsApp Business?

Yes. The bot works with both personal and WhatsApp Business accounts.

## Can my account get banned?

WhatsApp can detect excessive automation. To minimize risk:

- Don't send spam or mass messages
- Use `markOnlineOnConnect: false` (a `BaileysProvider` option)
- Respect rate limits (the provider's [built-in limiter](./rate-limiting))
- Don't reply instantly to everything (use human delays)
- Consider the official [Cloud API](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/meta-provider) (`@bot-wa/meta`) for business-critical bots — no ban risk

## Do I need TypeScript?

**No.** All examples work in plain JavaScript — just note the package is
**ESM-only**, so your project needs `"type": "module"` in `package.json`
(or a `.mjs` file) regardless of whether you use TypeScript. TypeScript
gives you autocomplete and type-checking, but it's optional.

## Why do I get `ERR_REQUIRE_ESM` or "require is not defined"?

You're trying to `require('@bot-wa/core')` (or a transport package) from a
CommonJS file. There is no CJS build — switch to `import` (add
`"type": "module"` to your `package.json`, or use a `.mjs` extension).
Node >= 22.12 can also `require()` an ESM package via its experimental
`require(esm)` support.

## Where is the full API reference?

At the [API Reference](/api/) — generated with TypeDoc from the source code.

## Still having problems?

- [Open an issue on GitHub](https://github.com/andresayac/bot-wa-baileys/issues)
- [Check the examples](/examples/messages)
