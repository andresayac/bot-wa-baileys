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
      expect(ctx.tools.ai).toBeInstanceOf(AIClient)
      const a = await ctx.tools.ai.ask('algo')
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
  it('unplug removes the catch-all, /reset and ctx.tools.ai', async () => {
    const { bot, chat, unplug } = await botWithAI()
    expect(bot.injectTools.ai).toBeInstanceOf(AIClient)
    unplug()
    expect('ai' in bot.injectTools).toBe(false)
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
    bot.when('q', async (ctx) => {
      const a = await ctx.tools.ai.ask('algo')
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

describe('aiPlugin — one typing indicator per one-shot autoreply', () => {
  async function typingBot(cfg: AIPluginConfig, botTyping: boolean) {
    const t = await createTestBot(botTyping ? { typing: { enabled: true, minMs: 5, maxMs: 10 } } : {})
    const states: string[] = []
    Object.assign(t.provider, { typing: async (_chatId: string, state: string) => { states.push(state) } })
    t.bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: 'IA responde' }), ...cfg }))
    return { ...t, states }
  }

  it('BotConfig.typing on + humanizeTyping: types once (before generating), not again on reply', async () => {
    const { bot, chat, states } = await typingBot({}, true)
    await chat.send('hola')
    await chat.expectReply('IA responde')
    expect(states.filter((s) => s === 'typing')).toHaveLength(1)
    await bot.stop()
  })

  it('humanizeTyping:false leaves the indicator to BotConfig.typing (still once)', async () => {
    const { bot, chat, states } = await typingBot({ humanizeTyping: false }, true)
    await chat.send('hola')
    await chat.expectReply('IA responde')
    expect(states.filter((s) => s === 'typing')).toHaveLength(1)
    await bot.stop()
  })

  it('without BotConfig.typing the autoreply still shows the indicator once', async () => {
    const { bot, chat, states } = await typingBot({}, false)
    await chat.send('hola')
    await chat.expectReply('IA responde')
    expect(states.filter((s) => s === 'typing')).toHaveLength(1)
    await bot.stop()
  })
})

describe('aiPlugin — a failing typing indicator never kills the reply', () => {
  async function failingTypingBot(cfg: AIPluginConfig, mode: 'reject' | 'throw', botTyping = false) {
    const t = await createTestBot(botTyping ? { typing: { enabled: true, minMs: 5, maxMs: 10 } } : {})
    const typing = mode === 'reject'
      ? async () => { throw new Error('400: Request input may be invalid') }
      : () => { throw new Error('sync typing boom') }
    Object.assign(t.provider, { typing })
    t.bot.plug(aiPlugin({ __provider: new MockAIProvider({ reply: 'IA responde' }), errorMessage: 'sin servicio', ...cfg }))
    return t
  }

  for (const mode of ['reject', 'throw'] as const) {
    it(`one-shot autoreply still answers when typing ${mode}s`, async () => {
      const { bot, chat } = await failingTypingBot({}, mode)
      await chat.send('hola')
      await chat.expectReply('IA responde')
      expect(chat.replies()).not.toContain('sin servicio')
      await bot.stop()
    })

    it(`streamed autoreply still answers when typing ${mode}s`, async () => {
      const { bot, chat } = await failingTypingBot({ stream: true }, mode, true)
      await chat.send('hola')
      await chat.expectReply('IA responde')
      expect(chat.replies()).not.toContain('sin servicio')
      await bot.stop()
    })

    it(`tool-enabled autoreply still answers when typing ${mode}s`, async () => {
      const { bot, chat } = await failingTypingBot({ tools: { hora: { description: 'Hora', handler: () => '12:00' } } }, mode, true)
      await chat.send('hola')
      await chat.expectReply('IA responde')
      expect(chat.replies()).not.toContain('sin servicio')
      await bot.stop()
    })
  }
})
