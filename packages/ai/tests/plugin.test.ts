import { describe, it, expect } from 'vitest'
import { createTestBot } from '@bot-wa/bot-wa-baileys/testing'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { aiPlugin } from '../src/plugin.js'

async function botWithAI(cfg = {}, mock = new MockAIProvider({ reply: 'IA responde' })) {
  const { bot, chat } = await createTestBot()
  bot.plug(aiPlugin({ __provider: mock, persona: 'ACME', ...cfg } as any))
  return { bot, chat, mock }
}

describe('aiPlugin', () => {
  it('auto-replies to unhandled messages', async () => {
    const { chat } = await botWithAI()
    await chat.send('cualquier cosa')
    await chat.expectReply('IA responde')
  })
  it('does NOT reply when a when() handler consumed the message', async () => {
    const { bot, chat } = await botWithAI()
    bot.when('hola', async (ctx) => { await ctx.reply('handler gana') })
    await chat.send('hola')
    await chat.expectReply('handler gana')
    await new Promise((r) => setTimeout(r, 30))
    expect(chat.replies().filter((r) => r.includes('IA responde'))).toHaveLength(0)
  })
  it('exposes ctx.tools.ai.ask inside a conversation', async () => {
    const { bot, chat } = await botWithAI({ autoReply: false })
    bot.conversation('q', async (c, ctx) => {
      const a = await (ctx.tools as any).ai.ask('algo')
      await ctx.reply(`ai dijo: ${a}`)
    })
    await chat.send('q')
    await chat.expectReply('ai dijo: IA responde')
  })
  it('remembers context across turns', async () => {
    const mock = new MockAIProvider({ reply: (i) => `n=${i.messages.length}` })
    const { chat } = await botWithAI({}, mock)
    await chat.send('uno'); await chat.expectReply('n=1')
    await chat.send('dos'); await chat.expectReply('n=3')
  })
  it('/reset clears AI context', async () => {
    const mock = new MockAIProvider({ reply: (i) => `n=${i.messages.length}` })
    const { chat } = await botWithAI({}, mock)
    await chat.send('uno'); await chat.expectReply('n=1')
    await chat.send('/reset'); await chat.expectReply(/.*/)
    await chat.send('otra vez'); await chat.expectReply('n=1')
  })
  it('provider error falls back to errorMessage, no crash', async () => {
    const mock = new MockAIProvider()
    mock.generate = async () => { throw new Error('boom') }
    const { chat } = await botWithAI({ errorMessage: 'sin servicio' }, mock)
    await chat.send('hola')
    await chat.expectReply('sin servicio')
  })
})
