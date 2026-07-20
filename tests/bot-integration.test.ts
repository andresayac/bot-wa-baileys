import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { flow } from '../src/flows/FlowBuilder.js'

describe('Bot integration (MockProvider)', () => {
  it('when() replies exactly once', async () => {
    const { bot, chat } = await createTestBot()
    bot.when('hola', async (ctx) => { await ctx.reply('👋 ¡Hola!') })
    bot.onMessage(async (ctx) => { await ctx.reply('no entendí') })
    await chat.send('hola')
    await chat.expectReply('👋 ¡Hola!')
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.replies()).toEqual(['👋 ¡Hola!'])
  })

  it('full register flow over the bot', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('registrar')
      .say('📝 Vamos a registrarte')
      .ask('¿Tu nombre?', 'name')
      .say((_c, c) => `✅ Hola ${c.state.name}`))
    await chat.send('registrar')
    await chat.expectReply('¿Tu nombre?')
    await chat.send('Andres')
    await chat.expectReply('✅ Hola Andres')
  })

  it('conversation() with async fn', async () => {
    const { bot, chat } = await createTestBot()
    bot.conversation('soporte', async (c, ctx) => {
      await ctx.reply('Describe tu problema')
      const p = await c.waitText()
      await ctx.reply(`🎫 registrado: ${p}`)
    })
    await chat.send('soporte')
    await chat.expectReply('Describe tu problema')
    await chat.send('no anda nada')
    await chat.expectReply('🎫 registrado: no anda nada')
  })

  it("forwards the provider's pairingCode event as 'pairing_code' (v1 name)", async () => {
    const { bot, provider } = await createTestBot()
    const received = new Promise<string>((resolve) => bot.on('pairing_code', resolve))
    provider.emitTyped('pairingCode', '12345678')
    expect(await received).toBe('12345678')
  })

  it('command /reset escapes an active flow', async () => {
    const { bot, chat } = await createTestBot()
    bot.command('reset', async (ctx) => { bot.abortConversation(ctx.from); await ctx.reply('✅ reiniciado') })
    bot.use(flow('registrar').ask('¿Tu nombre?', 'name').say('nunca llega'))
    await chat.send('registrar')
    await chat.expectReply('¿Tu nombre?')
    await chat.send('/reset')
    await chat.expectReply('✅ reiniciado')
    await chat.send('cualquier cosa')
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.replies()).not.toContain('nunca llega')
  })
})
