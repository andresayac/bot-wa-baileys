# Getting Started

## Requirements

- **Node.js** 20+ ([download](https://nodejs.org/))
- **pnpm** (recommended) or npm/yarn
- A phone with WhatsApp (for the Baileys transport)

::: tip Don't have pnpm?
Install it with:
```bash
npm install -g pnpm
```
:::

::: warning ESM-only packages
`@bot-wa/core` and the transport packages ship as **pure ESM** — there is
no CommonJS build. Your project needs `"type": "module"` in its
`package.json` (or a `.mjs` file extension). On Node **>= 22.12** you can
also `require()` them via Node's experimental `require(esm)` support, but
the examples below use plain `import`.
:::

## Step 1 — Install the framework

The engine (`@bot-wa/core`) is transport-agnostic: you pair it with a
**provider** package. For WhatsApp over Baileys 7 (unofficial, QR login):

```bash
mkdir my-bot
cd my-bot
pnpm init
pnpm add @bot-wa/core @bot-wa/baileys
```

Other transports behind the same `IProvider` contract:

| Transport | Package | Notes |
|---|---|---|
| WhatsApp (Baileys 7) | `@bot-wa/baileys` | Unofficial, QR login — what this guide uses |
| WhatsApp Cloud API | `@bot-wa/meta` | Official Meta API, webhook-based, no ban risk |
| Telegram | `@bot-wa/telegram` | Bot API, long-poll or webhook |
| Discord | `@bot-wa/discord` | Gateway websocket + REST |

Then add `"type": "module"` to the generated `package.json` so Node treats
your files as ESM:

```json
{
  "type": "module"
}
```

## Step 2 — Create your bot

Create a `bot.js` file. In v2, constructing a bot **requires a provider** —
WhatsApp session/auth options live on the provider, not on the bot:

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({
  provider: new BaileysProvider({
    session: 'my-bot',
    qr: { terminal: true, small: true },
  }),
})

bot.on('ready', () => console.log('✅ Bot connected!'))

bot.when('hola', async (ctx) => {
  await ctx.reply('👋 Hello! I am your bot.')
})

await bot.start()
```

## Step 3 — Run and scan the QR

```bash
node bot.js
```

You'll see a QR code in your terminal. Open it on your phone:

1. Open **WhatsApp**
2. Go to **Settings → Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code

Done! Your bot is connected. Send "hola" (exactly, that's the default
matching mode) from another phone and you'll get a reply.

::: warning Don't scan with the same phone
The QR is scanned with the phone that **will be the bot**, not the one sending messages.
:::

## Other transports, same bot code

Only the provider changes — `when`/`flow`/hooks/plugins are identical on
every transport. For the official WhatsApp Cloud API:

```ts
import { Bot } from '@bot-wa/core'
import { CloudAPIProvider } from '@bot-wa/meta'

const bot = new Bot({
  provider: new CloudAPIProvider({
    accessToken: process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    verifyToken: process.env.META_VERIFY_TOKEN,
  }),
})
```

(The Cloud API is webhook-based: POST inbound payloads to
`provider.ingest(body, headers)` from your HTTP server.) See
[`@bot-wa/telegram`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/telegram-provider)
and [`@bot-wa/discord`](https://github.com/andresayac/bot-wa-baileys/tree/main/packages/discord-provider)
for the other transports.

## Next steps

- [Your first bot](./first-bot) — a complete bot with commands, media and flows
- [Core concepts](./concepts) — understand how everything works
- [Examples](/examples/messages) — ready-to-copy recipes
