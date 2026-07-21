# Shopping Flow

A flow with a numbered menu and branching using `.choose()`.

## The flow

```ts
import { Bot, flow } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo-bot', qr: { terminal: true, small: true } }),
})

const catalog: Record<string, string> = {
  electronics: '📱 *Electronics* — iPhone 15 ($999), Samsung S24 ($899), Xiaomi 14 ($599)',
  clothing: '👕 *Clothing* — Shirt ($25), Jeans ($45), Jacket ($80)',
  home: '🏠 *Home* — Lamp ($35), Rug ($60), Glass ($12)',
}

const buy = flow('buy')
  .say('🛒 *What do you want to buy?*')
  .choose('Write the option number', {
    electronics: 'Electronics 📱',
    clothing: 'Clothing 👕',
    home: 'Home 🏠',
  }, 'category')
  .say((_ctx, c) => catalog[c.state.category])
  .say('✅ Thanks for your interest! Anything else?')

bot.use(buy)

await bot.start()
```

## How it works

1. User sends "buy"
2. `.say(...)` sends the intro, then `.choose()` builds a numbered menu from the
   `options` keys (`1) Electronics 📱`, `2) Clothing 👕`, `3) Home 🏠`) and waits
   for a valid number
3. The chosen KEY (`electronics`, `clothing` or `home` — not the number the user
   typed) is stored in `c.state.category`, since `'category'` is the 3rd argument
   to `.choose()`
4. The next `.say()` reads `c.state.category` to print the matching catalog text
5. The flow closes with a thank-you message

## Branch with `then` sub-steps

Instead of reading `c.state` afterwards, each option can run its own `then`
step right when it's picked. Control returns to the parent flow once the
sub-step finishes — there is no separate nested flow to build:

```ts
const buy = flow('buy')
  .say('🛒 *What do you want to buy?*')
  .choose('Write the option number', {
    electronics: {
      label: 'Electronics 📱',
      then: (_ctx, c) => { c.state.summary = '📱 iPhone 15 — $999' },
    },
    clothing: {
      label: 'Clothing 👕',
      then: (_ctx, c) => { c.state.summary = '👕 Shirt — $25' },
    },
    home: {
      label: 'Home 🏠',
      then: (_ctx, c) => { c.state.summary = '🏠 Lamp — $35' },
    },
  })
  .say((_ctx, c) => `${c.state.summary}\n\n✅ Thanks for your interest!`)

bot.use(buy)
```

The chosen key is still available afterwards as `c.state.choice` (the default
`stateKey` when you don't pass one) if you need it later in the chain.

## Give the whole flow a timeout

`.timeout()` sets how long each wait in the flow (including the `.choose()`
menu) waits for a reply. The message sent on timeout is NOT a `.timeout()`
argument — configure it once on the bot:

```ts
const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo-bot' }),
  conversation: { timeoutMessage: '⏰ Session expired due to inactivity.' },
})

const buy = flow('buy')
  .timeout('2m')
  .say('🛒 *What do you want to buy?*')
  .choose('Write the option number', {
    electronics: 'Electronics 📱',
    clothing: 'Clothing 👕',
    home: 'Home 🏠',
  }, 'category')
  .say((_ctx, c) => catalog[c.state.category])

bot.use(buy)
```

## Next steps

- [Support with timeout](./support-flow) — timeout and fallback
- [Flows](/guide/flows) — full DSL guide
