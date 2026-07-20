# Flujo de compra

Un flujo con un menú numerado y branching usando `.choose()`.

## El flujo

```ts
import { Bot, flow } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

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

## Cómo funciona

1. El usuario envía "buy"
2. `.say(...)` envía la introducción, y luego `.choose()` construye un menú
   numerado a partir de las claves de `options` (`1) Electronics 📱`,
   `2) Clothing 👕`, `3) Home 🏠`) y espera un número válido
3. La CLAVE elegida (`electronics`, `clothing` o `home` — no el número que
   escribió el usuario) se guarda en `c.state.category`, ya que `'category'`
   es el tercer argumento de `.choose()`
4. El siguiente `.say()` lee `c.state.category` para mostrar el texto del
   catálogo correspondiente
5. El flujo cierra con un mensaje de agradecimiento

## Ramificar con sub-pasos `then`

En lugar de leer `c.state` después, cada opción puede ejecutar su propio
paso `then` justo en el momento en que se elige. El control vuelve al flujo
padre en cuanto termina el sub-paso — no hay que construir un flujo anidado
aparte:

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

La clave elegida sigue estando disponible después como `c.state.choice` (el
`stateKey` por defecto cuando no pasas uno) si la necesitas más adelante en
la cadena.

## Ponerle un timeout a todo el flujo

`.timeout()` define cuánto tiempo espera cada `wait` del flujo (incluido el
menú de `.choose()`) por una respuesta. El mensaje que se envía al expirar
NO es un argumento de `.timeout()` — se configura una sola vez en el bot:

```ts
const bot = new Bot({
  session: 'demo-bot',
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

## Siguientes pasos

- [Soporte con timeout](./flujo-soporte) — timeout y fallback
- [Flujos](/es/guide/flujos) — guía completa del DSL
