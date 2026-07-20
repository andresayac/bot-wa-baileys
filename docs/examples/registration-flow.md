# Registration Flow

A complete registration flow with `.ask()`, validation and a dynamic summary.

## The flow

```ts
import { Bot, flow } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

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

## How it works

1. User sends "register" and the flow starts
2. `.say('📝 *Let us register you*')` sends a fixed intro message
3. `.ask('What is your name?', 'name')` sends the question, waits for the reply, and stores it in `c.state.name`
4. `.ask('What is your email?', 'email', { validate })` repeats until the reply passes validation — `validate` returns `true` to accept, or an error string to reject and re-ask the same question
5. The final `.say((_ctx, c) => ...)` reads `c.state.name` and `c.state.email` to build the summary dynamically

## Save to a database

Combine `.do()` (run an action without sending a message) with `bot.provide()`
to persist the captured data:

```ts
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
    const { db } = ctx.tools as {
      db: { save(jid: string, data: { name: string; email: string }): Promise<void> }
    }
    await db.save(ctx.from, { name: c.state.name, email: c.state.email })
  })
  .say('✅ Registered!')

bot.use(register)
```

## Next steps

- [Shopping flow](./shopping-flow) — branching with choose
- [Flows](/guide/flows) — full DSL guide
