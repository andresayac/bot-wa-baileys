import { describe, it, expect } from 'vitest'
import { createTestBot } from '@bot-wa/core/testing'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { LazyProvider } from '../src/providers/LazyProvider.js'
import type { AIProvider } from '../src/types.js'
import { AIClient } from '../src/AIClient.js'
import { aiPlugin } from '../src/plugin.js'
import type { AIPluginConfig } from '../src/plugin.js'

async function botWithAI(cfg: AIPluginConfig = {}, mock: AIProvider = new MockAIProvider({ reply: 'IA responde' })) {
  const { bot, chat } = await createTestBot()
  const unplug = bot.plug(aiPlugin({ __provider: mock, persona: 'ACME', ...cfg }))
  return { bot, chat, mock, unplug }
}

/**
 * `bot.conversation` types its ctx as the transport-neutral `RuntimeMessage`
 * (no `tools`), although at runtime it is the full MessageContext. Narrow it at
 * runtime to the AIClient the plugin injected as `ctx.tools.ai`.
 */
function aiToolOf(ctx: object): AIClient {
  const tools: unknown = 'tools' in ctx ? ctx.tools : undefined
  expect(tools, 'ctx.tools').toBeTypeOf('object')
  const ai: unknown = typeof tools === 'object' && tools !== null && 'ai' in tools ? tools.ai : undefined
  expect(ai, 'ctx.tools.ai').toBeInstanceOf(AIClient)
  if (!(ai instanceof AIClient)) throw new Error('ctx.tools.ai is not an AIClient')
  return ai
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
      const a = await aiToolOf(ctx).ask('algo')
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
  it('unplug removes the catch-all and /reset', async () => {
    const { chat, unplug } = await botWithAI()
    unplug()
    await chat.send('x')
    await chat.send('/reset')
    await new Promise((r) => setTimeout(r, 30))
    expect(chat.replies().filter((r) => r.includes('IA responde'))).toHaveLength(0)
    expect(chat.replies().filter((r) => r.includes('reiniciada'))).toHaveLength(0)
  })
  it('autoReply:false does not register the catch-all but still provides ai', async () => {
    const { bot, chat } = await botWithAI({ autoReply: false })
    await chat.send('x')
    await new Promise((r) => setTimeout(r, 30))
    expect(chat.replies().filter((r) => r.includes('IA responde'))).toHaveLength(0)
    bot.conversation('q', async (c, ctx) => {
      const a = await aiToolOf(ctx).ask('algo')
      await ctx.reply(`ai dijo: ${a}`)
    })
    await chat.send('q')
    await chat.expectReply('ai dijo: IA responde')
  })
  it('provider that fails to resolve → each message replies errorMessage, no crash', async () => {
    const rejections: unknown[] = []
    const onRej = (e: unknown) => rejections.push(e)
    process.on('unhandledRejection', onRej)
    try {
      const failing = new LazyProvider(async () => { throw new Error('no SDK installed') })
      const { chat } = await botWithAI({ errorMessage: 'sin servicio' }, failing)
      await chat.send('hola'); await chat.expectReply('sin servicio')
      await chat.send('otra'); await chat.expectReply('sin servicio')
      await new Promise((r) => setTimeout(r, 10))
    } finally {
      process.off('unhandledRejection', onRej)
    }
    expect(rejections).toHaveLength(0)
  })
})
