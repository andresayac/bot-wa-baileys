# Support Flow with Timeout

A support conversation with an inactivity timeout, built with
`bot.conversation()` for full control over the exchange.

## The conversation

```ts
import { Bot } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({
  provider: new BaileysProvider({
    session: 'demo-bot',
    qr: { terminal: true, small: true },
  }),
  conversation: { timeoutMessage: '⏰ Your support session expired due to inactivity.' },
})

bot.conversation('support', async (c, ctx) => {
  await ctx.reply('🛠️ *Technical support*\nDescribe your issue in one sentence (you have 2 minutes):')
  const issue = await c.waitText({ timeout: '2m', retries: 2 })

  const priority = await c.choose('How urgent is it?', {
    high: 'Urgent 🔴',
    medium: 'Can wait a few hours 🟡',
    low: 'No rush 🟢',
  })

  await ctx.reply(`🎫 Ticket registered ("${issue}", priority: ${priority}). We will contact you soon.`)
})

await bot.start()
```

## How it works

1. User sends "support" and the conversation starts — `ctx` is the message
   that triggered it, `c` is the `ConversationControls` for this conversation
2. `ctx.reply(...)` announces the flow, then `c.waitText({ timeout: '2m', retries: 2 })`
   waits up to 2 minutes for a text reply
3. If the user goes silent for 2 minutes, a `ConversationTimeout` is thrown, the
   conversation ends, and the bot sends the `conversation.timeoutMessage`
   configured on the `Bot`
4. `c.choose(...)` sends a numbered menu built from its `options` and returns
   the chosen KEY (`high`, `medium` or `low`)
5. The bot confirms the ticket with the collected issue and priority

## Handle timeout and cancellation explicitly

`c.waitText` / `c.choose` throw dedicated errors when a conversation ends
early — catch them to customize the reply instead of relying on the global
`conversation.timeoutMessage`:

```ts
import { Bot, ConversationTimeout, ConversationCancelled } from '@bot-wa/core'
import { BaileysProvider } from '@bot-wa/baileys'

const bot = new Bot({
  provider: new BaileysProvider({ session: 'demo-bot', qr: { terminal: true, small: true } }),
})

bot.conversation('support', async (c, ctx) => {
  try {
    await ctx.reply('🛠️ Describe your issue (or send "cancel"):')
    const issue = await c.waitText({ timeout: '2m' })
    await ctx.reply(`✅ Registered: "${issue}". We will contact you.`)
  } catch (err) {
    if (err instanceof ConversationTimeout) {
      await ctx.reply('⏰ Session expired due to inactivity.')
    } else if (err instanceof ConversationCancelled) {
      await ctx.reply('🛑 Session cancelled.')
    } else {
      throw err
    }
  }
})

await bot.start()
```

::: tip Commands always escape
A slash command such as `/reset` (see `slashCommandsPlugin`) always beats an
active conversation — users are never trapped in a flow.
:::

## Next steps

- [Plugin: rate limiter](./rate-limiter) — limit messages
- [Flows](/guide/flows) — full DSL guide
