# Flujo de compra

Un flujo con menú de opciones y branching usando `choose`.

## El flujo

```js
const { Bot, flow } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

const comprar = flow('comprar')
  // 1. Mostrar menú
  .say([
    '🛒 *¿Qué quieres comprar?*',
    '',
    '1️⃣ Electrónica',
    '2️⃣ Ropa',
    '3️⃣ Hogar',
  ].join('\n'))

  // 2. Pedir opción (capturar)
  .say('Escribe el número de opción', { capture: true })

  // 3. Branching según la opción
  .choose({
    '1': flow()
      .say('📱 *Electrónica* — Tenemos:')
      .say([
        '• iPhone 15 — $999',
        '• Samsung S24 — $899',
        '• Xiaomi 14 — $599',
      ].join('\n'))
      .end(),

    '2': flow()
      .say('👕 *Ropa* — Tenemos:')
      .say([
        '• Camiseta — $25',
        '• Jeans — $45',
        '• Chaqueta — $80',
      ].join('\n'))
      .end(),

    '3': flow()
      .say('🏠 *Hogar* — Tenemos:')
      .say([
        '• Lámpara — $35',
        '• Alfombra — $60',
        '• Vaso — $12',
      ].join('\n'))
      .end(),
  })

  // 4. Cierre
  .say('✅ ¡Gracias por tu interés! ¿Algo más?')
  .end()

bot.use(comprar)

bot.start()
```

## Cómo funciona

1. El usuario envía "comprar"
2. El bot muestra el menú con 3 categorías
3. El usuario escribe "1", "2" o "3"
4. `choose` toma el camino correspondiente
5. El bot muestra los productos de esa categoría
6. El bot cierra con "¡Gracias!"

## Añadir opción inválida

```js
const comprar = flow('comprar')
  .say('1️⃣ Electrónica\n2️⃣ Ropa\n3️⃣ Hogar')
  .say('Escribe el número', { capture: true })
  .validate((body) => {
    if (!['1', '2', '3'].includes(body.trim())) {
      return '❌ Opción inválida. Escribe 1, 2 o 3.'
    }
    return true
  })
  .choose({
    '1': flow().say('📱 iPhone 15 — $999').end(),
    '2': flow().say('👕 Camiseta — $25').end(),
    '3': flow().say('🏠 Lámpara — $35').end(),
  })
  .end()
```

## Sub-flujos más complejos

```js
const comprar = flow('comprar')
  .say('1️⃣ Electrónica\n2️⃣ Ropa')
  .say('Elige categoría', { capture: true })
  .choose({
    '1': flow()
      .say('📱 ¿Qué quieres ver?\n1️⃣ iPhone\n2️⃣ Samsung')
      .say('Elige', { capture: true })
      .choose({
        '1': flow().say('iPhone 15 — $999').end(),
        '2': flow().say('Samsung S24 — $899').end(),
      })
      .end(),
    '2': flow()
      .say('👕 ¿Qué quieres ver?\n1️⃣ Camiseta\n2️⃣ Jeans')
      .say('Elige', { capture: true })
      .choose({
        '1': flow().say('Camiseta — $25').end(),
        '2': flow().say('Jeans — $45').end(),
      })
      .end(),
  })
  .end()
```

## Siguientes pasos

- [Soporte con timeout](./flujo-soporte) — timeout y fallback
- [Flujos](/es/guide/flujos) — guía completa del DSL