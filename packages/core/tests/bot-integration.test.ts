import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'

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

  it('registrations survive stop()/start() — restarted bot is not deaf (I2)', async () => {
    const { bot, chat } = await createTestBot()
    bot.when('hola', async (ctx) => { await ctx.reply('👋 sigo viva') })
    await bot.stop()
    await bot.start()
    await chat.send('hola')
    await chat.expectReply('👋 sigo viva')
  })

  it('two anonymous regex flows each enter their OWN flow (I4)', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow(/^rojo$/).say('elegiste ROJO'))
    bot.use(flow(/^azul$/).say('elegiste AZUL'))
    await chat.send('rojo')
    await chat.expectReply('elegiste ROJO')
    await chat.send('azul')
    await chat.expectReply('elegiste AZUL')
  })

  it('before("send") hook can mutate outgoing content (I3)', async () => {
    const { bot, chat } = await createTestBot()
    bot.before('send', async (payload: any, next) => {
      if (typeof payload.content.text === 'string') payload.content.text = payload.content.text.toUpperCase()
      await next()
    })
    bot.when('hola', async (ctx) => { await ctx.reply('hola mundo') })
    await chat.send('hola')
    await chat.expectReply('HOLA MUNDO')
  })

  it('before("send") abort skips the send and flags skipped (I3)', async () => {
    const { bot, provider } = await createTestBot()
    bot.before('send', async (payload: any) => { payload.abort() })
    const sent = await bot.send('user@s.whatsapp.net', { kind: 'text', text: 'no debe salir' })
    expect(sent.skipped).toBe(true)
    expect(provider.outbox).toHaveLength(0)
  })

  it('no "error" listener + conversation goto to a missing target does not crash (C2)', async () => {
    const rejections: unknown[] = []
    const onRej = (e: unknown) => rejections.push(e)
    process.on('unhandledRejection', onRej)
    try {
      const { bot, chat } = await createTestBot()   // deliberately NO bot.on('error', ...)
      bot.conversation('roto', async (c) => { c.goto('no-existe') })
      await chat.send('roto')
      await new Promise((r) => setTimeout(r, 50))
      expect(rejections).toHaveLength(0)             // process still alive, nothing unhandled
    } finally {
      process.off('unhandledRejection', onRej)
    }
  })

  it('persistent flow resumes across a bot restart with restored state (I6)', async () => {
    const store = new MemoryStore({})
    const persistent = () => flow('registrar').persistent()
      .say('bienvenido')
      .ask('¿nombre?', 'name')
      .ask('¿email?', 'email')
      .say((_c, c) => `fin ${c.state.name}/${c.state.email}`)

    const first = await createTestBot({ store })
    first.bot.use(persistent())
    await first.chat.send('registrar')
    await first.chat.expectReply('¿nombre?')
    await first.chat.send('Andres')
    await first.chat.expectReply('¿email?')          // pending question when we "restart"
    await first.bot.stop()

    const second = await createTestBot({ store })     // same store = restart
    second.bot.use(persistent())
    await second.chat.send('hola?')                   // wakes the dormant checkpoint
    await second.chat.expectReply('¿email?')          // re-ask the pending question
    await second.chat.send('a@b.co')
    await second.chat.expectReply('fin Andres/a@b.co')// state restored + completion
  })
})
