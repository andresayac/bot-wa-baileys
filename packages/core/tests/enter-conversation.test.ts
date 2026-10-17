import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/index.js'
import { definePlugin } from '../src/index.js'

describe('bot.enterConversation', () => {
  it('starts an inline conversation from a handler without blocking the chat FIFO', async () => {
    const { bot, chat } = await createTestBot()
    let handlerReturned = false
    bot.when('pedir', async (ctx) => {
      bot.enterConversation(async (c) => {
        const name = await c.ask('¿Tu nombre?')
        await c.say(`Hola ${name}`)
      }, ctx)
      handlerReturned = true
    })
    await chat.send('pedir')
    await chat.expectReply('¿Tu nombre?')
    expect(handlerReturned).toBe(true)
    await chat.send('Ana')
    await chat.expectReply('Hola Ana')
  })

  it('enters a registered conversation by name', async () => {
    const { bot, chat } = await createTestBot()
    bot.conversation('encuesta', async (c) => {
      const v = await c.ask('¿Nota?')
      await c.say(`nota=${v}`)
    }, { trigger: 'nunca-coincide-xyz' })
    bot.when('go', async (ctx) => { bot.enterConversation('encuesta', ctx) })
    await chat.send('go')
    await chat.expectReply('¿Nota?')
    await chat.send('5')
    await chat.expectReply('nota=5')
  })

  it('reports an unknown conversation name through the error event instead of crashing', async () => {
    const { bot, chat } = await createTestBot()
    const errors: unknown[] = []
    bot.on('error', (e: { error: unknown }) => errors.push(e.error))
    bot.when('go', async (ctx) => { bot.enterConversation('no-existe', ctx) })
    await chat.send('go')
    await new Promise((r) => setTimeout(r, 20))
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/no-existe/)
  })

  it('is available on the plugin-scoped bot', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(definePlugin({
      name: 'p',
      version: '0.0.0',
      install(pctx) {
        pctx.bot.when('x', async (ctx) => {
          pctx.bot.enterConversation(async (c) => { await c.say(`got ${await c.ask('dime')}`) }, ctx)
        })
      },
    }))
    await chat.send('x')
    await chat.expectReply('dime')
    await chat.send('algo')
    await chat.expectReply('got algo')
  })
})
