# Getting Started

## Requirements

- **Node.js** 20+ ([download](https://nodejs.org/))
- **pnpm** (recommended) or npm/yarn
- A phone with WhatsApp

::: tip Don't have pnpm?
Install it with:
```bash
npm install -g pnpm
```
:::

::: warning ESM-only package
`@bot-wa/bot-wa-baileys` ships as **pure ESM** — there is no CommonJS build. Your
project needs `"type": "module"` in its `package.json` (or a `.mjs` file
extension). On Node **>= 22.12** you can also `require()` it via Node's
experimental `require(esm)` support, but the examples below use plain `import`.
:::

## Step 1 — Install the framework

```bash
mkdir my-bot
cd my-bot
pnpm init
pnpm add @bot-wa/bot-wa-baileys
```

Then add `"type": "module"` to the generated `package.json` so Node treats
your files as ESM:

```json
{
  "type": "module"
}
```

## Step 2 — Create your bot

Create a `bot.js` file:

```ts
import { Bot } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({
  session: 'my-bot',
  qr: { terminal: true, small: true },
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

## Next steps

- [Your first bot](./first-bot) — a complete bot with commands, media and flows
- [Core concepts](./concepts) — understand how everything works
- [Examples](/examples/messages) — ready-to-copy recipes
