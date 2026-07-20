# Registration Flow

A complete registration flow with capture, validation and confirmation.

## The flow

```js
const { Bot, flow } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

const register = flow('register')
  .say('📝 *Let us register you*')
  .say('What is your name?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('name', ctx.body)
  })
  .say('What is your email?', { capture: true })
  .validate((body) => {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body)
    return ok ? true : '❌ Invalid email. Try again.'
  })
  .do(async (ctx, { state }) => {
    state.set('email', ctx.body)
  })
  .say(async (ctx, { state }) => {
    return [
      '✅ *Registration complete!*',
      '',
      `👤 Name: ${state.get('name')}`,
      `📧 Email: ${state.get('email')}`,
    ].join('\n')
  })
  .end()

bot.use(register)
bot.start()
```

## How it works

1. User sends "register"
2. Bot says "📝 Let us register you"
3. Bot asks "What is your name?" and **waits**
4. `do` saves the name in `state`
5. Bot asks "What is your email?" and **waits**
6. `validate` checks if it's a valid email
   - Valid → continues
   - Invalid → sends "❌ Invalid email" and **repeats the step**
7. `do` saves the email
8. Bot shows the summary

## Save to database

```js
bot.provide('db', {
  users: new Map(),
  async save(jid, data) { this.users.set(jid, data) },
})

const register = flow('register')
  .say('Name?', { capture: true })
  .do(async (ctx, { state }) => state.set('name', ctx.body))
  .say('Email?', { capture: true })
  .validate((body) => body.includes('@') ? true : '❌ Invalid email')
  .do(async (ctx, { state }) => {
    state.set('email', ctx.body)
    await ctx.tools.db.save(ctx.from, {
      name: state.get('name'),
      email: state.get('email'),
    })
  })
  .say('✅ Registered!')
  .end()
```

## Next steps

- [Shopping flow](./shopping-flow) — branching with choose
- [Flows](/guide/flows) — full DSL guide