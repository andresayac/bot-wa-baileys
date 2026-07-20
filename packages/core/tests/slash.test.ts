import { describe, it, expect } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { slashCommandsPlugin } from '../src/plugins/slashCommands.js'
import { flow } from '../src/flows/FlowBuilder.js'

describe('slashCommandsPlugin', () => {
  it('replies to /help and /ping, NOT to plain text', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(slashCommandsPlugin, { greeting: 'soy el bot' })
    await chat.send('/help')
    await chat.expectReply('soy el bot')
    await chat.send('/ping')
    await chat.expectReply('pong')
    await chat.send('hola sin slash')
    await new Promise((r) => setTimeout(r, 30))
    expect(chat.replies().filter((r) => r.includes('Comando desconocido'))).toHaveLength(0)
  })

  it('unknown /command answers help hint', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(slashCommandsPlugin)
    await chat.send('/nadaqueverseñor')
    await chat.expectReply('Comando desconocido')
  })

  it('/reset aborts an active flow', async () => {
    const { bot, chat } = await createTestBot()
    bot.plug(slashCommandsPlugin)
    bot.use(flow('registrar').ask('¿nombre?', 'n').say('fin'))
    await chat.send('registrar')
    await chat.expectReply('¿nombre?')
    await chat.send('/reset')
    await chat.expectReply('reiniciada')
    await chat.send('registrar')
    await chat.expectReply('¿nombre?') // se puede volver a entrar
  })

  it('unplug removes everything the plugin registered', async () => {
    const { bot, chat } = await createTestBot()
    const unplug = bot.plug(slashCommandsPlugin)
    unplug()
    await chat.send('/ping')
    await new Promise((r) => setTimeout(r, 30))
    expect(chat.replies()).toHaveLength(0)
  })

  it('/reset aborts an active flow in a GROUP chat (participant-scoped)', async () => {
    const { bot, provider } = await createTestBot()
    bot.plug(slashCommandsPlugin)
    bot.use(flow('registrar').ask('¿nombre?', 'n').say('fin'))

    const groupJid = 'g@g.us'
    const sender = 'u1@s.whatsapp.net'
    const send = (text: string) => {
      provider.incoming(text, { from: groupJid, sender, isGroup: true })
      return new Promise((r) => setTimeout(r, 0))
    }
    const textOf = (m: { content: { kind: string; text?: string } }) => (m.content.kind === 'text' ? m.content.text ?? '' : '')
    const repliesTo = (jid: string) => provider.outbox.filter((m) => m.chatId === jid).map(textOf)

    await send('registrar')
    expect(repliesTo(groupJid).some((r) => r.includes('¿nombre?'))).toBe(true)

    await send('/reset')
    expect(repliesTo(groupJid).some((r) => r.includes('reiniciada'))).toBe(true)

    // se puede volver a entrar: aparece un SEGUNDO '¿nombre?'
    await send('registrar')
    expect(repliesTo(groupJid).filter((r) => r.includes('¿nombre?'))).toHaveLength(2)
  })
})
