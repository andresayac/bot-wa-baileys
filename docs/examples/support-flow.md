# Support Flow with Timeout

A support flow with inactivity timeout and fallback for unexpected input.

## The flow

```js
const { Bot, flow } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

const support = flow('support')
  .say('🛠️ *Technical support*')
  .say('Describe your issue in one sentence', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('issue', ctx.body)
  })
  .say(async (ctx, { state }) => {
    return `✅ Your issue "${state.get('issue')}" was registered. We will contact you soon.`
  })
  .timeout(60000, '⏰ Your support session expired due to inactivity.')
  .fallback(async (ctx) => {
    await ctx.reply('🤔 I did not understand. Please describe your issue or send "cancel".')
  })
  .end()

bot.use(support)
bot.start()
```

## How it works

1. User sends "support"
2. Bot says "🛠️ Technical support"
3. Bot asks to describe the issue and **waits**
4. `do` saves the issue in `state`
5. Bot confirms the registration
6. **If the user takes more than 60s** → bot sends "⏰ Session expired" and ends
7. **If the user sends something unexpected** → bot sends "🤔 I did not understand" and repeats

## Add cancel option

```js
const support = flow('support')
  .say('🛠️ *Technical support*')
  .say('Describe your issue or send "cancel"', { capture: true })
  .validate((body) => {
    if (body.toLowerCase() === 'cancel') return '🛑 Session cancelled.'
    return true
  })
  .do(async (ctx, { state }) => {
    if (ctx.body.toLowerCase() !== 'cancel') {
      state.set('issue', ctx.body)
    }
  })
  .say(async (ctx, { state }) => {
    const issue = state.get('issue')
    return issue
      ? `✅ Registered: "${issue}". We will contact you.`
      : '👋 Session ended.'
  })
  .timeout(60000, '⏰ Session expired.')
  .fallback(async (ctx) => {
    await ctx.reply('🤔 I did not understand. Describe your issue or "cancel".')
  })
  .end()
```

## Next steps

- [Plugin: rate limiter](./rate-limiter) — limit messages
- [Flows](/guide/flows) — full DSL guide