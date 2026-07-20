# Conversation Flows

Flows are multi-step conversations. The bot asks, the user answers, the bot
stores and continues.

## Basic flow

```js
const { flow } = require('@bot-wa/bot-wa-baileys')

const greet = flow('hi')
  .say('👋 Hello! What is your name?', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('name', ctx.body)
  })
  .say(async (ctx, { state }) => `Nice to meet you, ${state.get('name')}!`)
  .end()

bot.use(greet)
```

## DSL methods

### say — send a message

```js
flow.say('text')                              // fixed text
flow.say('text', { capture: true })           // wait for answer
flow.say(async (ctx, { state }) => `Hi`)      // dynamic text
flow.say([{ media: url, caption: 'photo' }])   // media
```

### do — run an action

```js
flow.do(async (ctx, { state }) => {
  state.set('key', ctx.body)
})
```

### validate — validate input

```js
flow
  .say('Email?', { capture: true })
  .validate((body) => {
    if (body.includes('@')) return true
    return '❌ Invalid email, try again'
  })
```

If validation fails, the bot sends the error and **repeats the step**.

### choose — branching (menu)

```js
flow
  .say('1️⃣ Electronics\n2️⃣ Clothing', { capture: true })
  .choose({
    '1': flow().say('📱 iPhone — $999').end(),
    '2': flow().say('👕 Shirt — $25').end(),
  })
```

### timeout — inactivity expiration

```js
flow
  .say('Describe your issue', { capture: true })
  .timeout(60000, '⏰ Session expired due to inactivity')
```

### fallback — when it doesn't understand

```js
flow
  .say('Describe your issue', { capture: true })
  .fallback(async (ctx) => {
    await ctx.reply('🤔 I did not understand. Please describe your issue.')
  })
```

### persistent — survive restarts

```js
flow.persistent()
```

## State — memory between steps

```js
state.set('key', value)   // save
state.get('key')           // read
state.has('key')           // exists?
state.delete('key')        // delete
state.clear()              // clear all
state.all()                // everything as object
```

## Complete example: registration

```js
const register = flow('register')
  .say('📝 *Let us register you*')
  .say('Name?', { capture: true })
  .do(async (ctx, { state }) => state.set('name', ctx.body))
  .say('Email?', { capture: true })
  .validate((body) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body) ? true : '❌ Invalid email')
  .do(async (ctx, { state }) => state.set('email', ctx.body))
  .say(async (ctx, { state }) => {
    return `✅ ${state.get('name')} <${state.get('email')}>`
  })
  .end()

bot.use(register)
```

## Next steps

- [Flow examples](/examples/registration-flow) — full recipes
- [Hooks](./hooks) — intercept messages
- [Plugins](./plugins) — package functionality