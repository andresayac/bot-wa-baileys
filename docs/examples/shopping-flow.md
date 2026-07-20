# Shopping Flow

A flow with a menu and branching using `choose`.

## The flow

```js
const { Bot, flow } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

const buy = flow('buy')
  .say([
    '🛒 *What do you want to buy?*',
    '',
    '1️⃣ Electronics',
    '2️⃣ Clothing',
    '3️⃣ Home',
  ].join('\n'))
  .say('Write the option number', { capture: true })
  .choose({
    '1': flow()
      .say('📱 *Electronics* — We have:')
      .say(['• iPhone 15 — $999', '• Samsung S24 — $899', '• Xiaomi 14 — $599'].join('\n'))
      .end(),
    '2': flow()
      .say('👕 *Clothing* — We have:')
      .say(['• Shirt — $25', '• Jeans — $45', '• Jacket — $80'].join('\n'))
      .end(),
    '3': flow()
      .say('🏠 *Home* — We have:')
      .say(['• Lamp — $35', '• Rug — $60', '• Glass — $12'].join('\n'))
      .end(),
  })
  .say('✅ Thanks for your interest! Anything else?')
  .end()

bot.use(buy)
bot.start()
```

## How it works

1. User sends "buy"
2. Bot shows the menu with 3 categories
3. User writes "1", "2" or "3"
4. `choose` takes the corresponding path
5. Bot shows the products of that category
6. Bot closes with "Thanks!"

## Add invalid option handling

```js
const buy = flow('buy')
  .say('1️⃣ Electronics\n2️⃣ Clothing\n3️⃣ Home')
  .say('Choose', { capture: true })
  .validate((body) => {
    if (!['1', '2', '3'].includes(body.trim())) {
      return '❌ Invalid option. Write 1, 2 or 3.'
    }
    return true
  })
  .choose({
    '1': flow().say('📱 iPhone — $999').end(),
    '2': flow().say('👕 Shirt — $25').end(),
    '3': flow().say('🏠 Lamp — $35').end(),
  })
  .end()
```

## Next steps

- [Support with timeout](./support-flow) — timeout and fallback
- [Flows](/guide/flows) — full DSL guide