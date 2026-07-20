# Soporte con timeout

Un flujo de soporte técnico con timeout por inactividad y fallback para
cuando el usuario envía algo inesperado.

## El flujo

```js
const { Bot, flow } = require('@bot-wa/bot-wa-baileys')

const bot = new Bot({ session: 'demo-bot', qr: { terminal: true, small: true } })

const soporte = flow('soporte')
  // 1. Bienvenida
  .say('🛠️ *Soporte técnico*')

  // 2. Pedir descripción del problema
  .say('Describe tu problema en una frase', { capture: true })

  // 3. Guardar el problema
  .do(async (ctx, { state }) => {
    state.set('problema', ctx.body)
  })

  // 4. Confirmar
  .say(async (ctx, { state }) => {
    return `✅ Tu problema "${state.get('problema')}" fue registrado. Te contactaremos pronto.`
  })

  // 5. Timeout: si el usuario no responde en 60s
  .timeout(60000, '⏰ Tu sesión de soporte caducó por inactividad.')

  // 6. Fallback: si el usuario envía algo inesperado
  .fallback(async (ctx) => {
    await ctx.reply('🤔 No entendí eso. Por favor describe tu problema o envía "cancelar".')
  })
  .end()

bot.use(soporte)

bot.start()
```

## Cómo funciona

1. El usuario envía "soporte"
2. El bot dice "🛠️ Soporte técnico"
3. El bot pide que describa el problema y **espera**
4. El `do` guarda el problema en `state`
5. El bot confirma el registro
6. **Si el usuario tarda más de 60s** → el bot envía "⏰ Tu sesión caducó" y termina
7. **Si el usuario envía algo inesperado** → el bot envía "🤔 No entendí" y repite

## Añadir opción de cancelar

```js
const soporte = flow('soporte')
  .say('🛠️ *Soporte técnico*')
  .say('Describe tu problema o envía "cancelar"', { capture: true })
  .validate((body) => {
    if (body.toLowerCase() === 'cancelar') {
      return '🛑 Sesión cancelada.'
    }
    return true
  })
  .do(async (ctx, { state }) => {
    if (ctx.body.toLowerCase() !== 'cancelar') {
      state.set('problema', ctx.body)
    }
  })
  .say(async (ctx, { state }) => {
    const problema = state.get('problema')
    return problema
      ? `✅ Registrado: "${problema}". Te contactaremos.`
      : '👋 Sesión terminada.'
  })
  .timeout(60000, '⏰ Sesión caducada por inactividad.')
  .fallback(async (ctx) => {
    await ctx.reply('🤔 No entendí. Describe tu problema o "cancelar".')
  })
  .end()
```

## Escalar a un agente

```js
bot.provide('tickets', {
  counter: 0,
  async create(problema, jid) {
    this.counter++
    return { id: this.counter, problema, jid, estado: 'abierto' }
  },
})

const soporte = flow('soporte')
  .say('🛠️ *Soporte técnico*')
  .say('Describe tu problema', { capture: true })
  .do(async (ctx, { state }) => {
    state.set('problema', ctx.body)
    const ticket = await ctx.tools.tickets.create(ctx.body, ctx.from)
    state.set('ticketId', ticket.id)
  })
  .say(async (ctx, { state }) => {
    return [
      `✅ Ticket #${state.get('ticketId')} creado.`,
      `📝 Problema: "${state.get('problema')}"`,
      '📞 Te contactaremos pronto.',
    ].join('\n')
  })
  .timeout(60000, '⏰ Sesión caducada.')
  .fallback(async (ctx) => {
    await ctx.reply('🤔 No entendí. Describe tu problema.')
  })
  .end()
```

## Siguientes pasos

- [Plugin: rate limiter](./rate-limiter) — limitar mensajes
- [Flujos](/es/guide/flujos) — guía completa del DSL