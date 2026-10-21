# Flujo de registro

Un flujo completo de registro con `.ask()`, validación y un resumen dinámico.

## El flujo

```ts
import { Bot, flow } from '@botmesh/core'
import { BaileysProvider } from '@botmesh/baileys'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo-bot', qr: { terminal: true, small: true } }),
})

const register = flow('register')
  .say('📝 *Let us register you*')
  .ask('What is your name?', 'name')
  .ask('What is your email?', 'email', {
    validate: (body) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Invalid email. Try again.',
  })
  .say((_ctx, c) => [
    '✅ *Registration complete!*',
    '',
    `👤 Name: ${c.state.name}`,
    `📧 Email: ${c.state.email}`,
  ].join('\n'))

bot.use(register)

await bot.start()
```

## Cómo funciona

1. El usuario envía "register" y el flujo arranca
2. `.say('📝 *Let us register you*')` envía un mensaje fijo de introducción
3. `.ask('What is your name?', 'name')` envía la pregunta, espera la
   respuesta y la guarda en `c.state.name`
4. `.ask('What is your email?', 'email', { validate })` repite hasta que la
   respuesta pase la validación — `validate` devuelve `true` para aceptar, o
   un string de error para rechazar y volver a preguntar lo mismo
5. El `.say((_ctx, c) => ...)` final lee `c.state.name` y `c.state.email`
   para construir el resumen de forma dinámica

## Guardar en una base de datos

Combina `.do()` (ejecuta una acción sin enviar mensaje) con `bot.provide()`
para persistir los datos capturados:

```ts
import type { MessageContext } from '@botmesh/core'

bot.provide('db', {
  users: new Map<string, { name: string; email: string }>(),
  async save(jid: string, data: { name: string; email: string }) {
    this.users.set(jid, data)
  },
})

const register = flow('register')
  .ask('Name?', 'name')
  .ask('Email?', 'email', {
    validate: (body) => (body.includes('@') ? true : '❌ Invalid email'),
  })
  .do(async (ctx, c) => {
    // flow steps type ctx as RuntimeMessage; the bot passes its full MessageContext
    const { db } = (ctx as MessageContext).tools as {
      db: { save(jid: string, data: { name: string; email: string }): Promise<void> }
    }
    await db.save(ctx.from, { name: String(c.state.name), email: String(c.state.email) })
  })
  .say('✅ Registered!')

bot.use(register)
```

## Validar con un schema

`schema` acepta cualquier objeto compatible con zod (cualquier cosa con
`safeParse()`). En `c.state` queda el valor **parseado** y tipado, así que
`c.state.edad` es un `number`. Una respuesta rechazada vuelve a preguntar con el
mensaje del schema:

```ts
import { z } from 'zod'

const registro = flow('registro')
  .ask('¿Cómo te llamas?', 'nombre', { schema: z.string().trim().min(2, '❌ Al menos 2 letras') })
  .ask('¿Cuántos años tienes?', 'edad', { schema: z.coerce.number().int().min(18, '❌ Debes ser mayor de edad') })
  .say((_ctx, c) => `✅ ${c.state.nombre}, ${c.state.edad} años`)
```

Para pedir varios campos de una vez (un WhatsApp Flow nativo en la Cloud API),
ve [Formularios](/es/guide/formularios).

## Siguientes pasos

- [Flujo de compra](./flujo-compra) — branching con choose
- [Flujos](/es/guide/flujos) — guía completa del DSL
