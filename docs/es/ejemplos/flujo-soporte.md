# Soporte con timeout

Una conversación de soporte con timeout por inactividad, construida con
`bot.conversation()` para tener control total sobre el intercambio.

## La conversación

```ts
import { Bot } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({
  session: 'demo-bot',
  qr: { terminal: true, small: true },
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

## Cómo funciona

1. El usuario envía "support" y la conversación arranca — `ctx` es el
   mensaje que la disparó, `c` es el `ConversationControls` de esta
   conversación
2. `ctx.reply(...)` anuncia el flujo, y luego
   `c.waitText({ timeout: '2m', retries: 2 })` espera hasta 2 minutos por
   una respuesta de texto
3. Si el usuario no responde en 2 minutos, se lanza un `ConversationTimeout`,
   la conversación termina, y el bot envía el `conversation.timeoutMessage`
   configurado en el `Bot`
4. `c.choose(...)` envía un menú numerado construido a partir de sus
   `options` y devuelve la CLAVE elegida (`high`, `medium` o `low`)
5. El bot confirma el ticket con el problema y la prioridad recolectados

## Manejar el timeout y la cancelación explícitamente

`c.waitText` / `c.choose` lanzan errores dedicados cuando una conversación
termina antes de tiempo — captúralos para personalizar la respuesta en vez
de depender del `conversation.timeoutMessage` global:

```ts
import { Bot, ConversationTimeout, ConversationCancelled } from '@bot-wa/bot-wa-baileys'

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

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

::: tip Los comandos siempre escapan
Un comando slash como `/reset` (ver `slashCommandsPlugin`) siempre gana sobre
una conversación activa — los usuarios nunca quedan atrapados en un flujo.
:::

## Siguientes pasos

- [Plugin: rate limiter](./rate-limiter) — limitar mensajes
- [Flujos](/es/guide/flujos) — guía completa del DSL
