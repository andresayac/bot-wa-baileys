import { describe, it, expect, vi } from 'vitest'
import { createTestBot } from '../src/testing/createTestBot.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { isPlugin } from '../src/plugins/definePlugin.js'
import type { ConversationTarget, StopOptions } from '../src/index.js'

describe('API coherence: bot.send accepts a plain string', () => {
  it('sends a string as text, like sendTo and broadcast', async () => {
    const { bot, provider } = await createTestBot()
    await bot.send('u1', 'hola')
    await bot.sendTo('u1', 'chao')
    expect(provider.outbox.map((m) => m.content)).toEqual([
      { kind: 'text', text: 'hola' },
      { kind: 'text', text: 'chao' },
    ])
    await bot.stop()
  })

  it('still runs the before("send") hooks with normalized content', async () => {
    const { bot, provider } = await createTestBot()
    const seen: unknown[] = []
    bot.before('send', async (payload: { content: unknown }, next) => { seen.push(payload.content); await next() })
    await bot.send('u1', 'hola')
    expect(seen).toEqual([{ kind: 'text', text: 'hola' }])
    expect(provider.outbox).toHaveLength(1)
    await bot.stop()
  })
})

describe('API coherence: bot.stop({ timeout }) takes a duration', () => {
  it('accepts a duration string for the drain timeout', async () => {
    const { bot } = await createTestBot()
    const opts: StopOptions = { drain: true, timeout: '2s' }
    await expect(bot.stop(opts)).resolves.toBeUndefined()
  })

  it('rejects an invalid duration before tearing the bot down', async () => {
    const { bot, provider } = await createTestBot()
    await expect(bot.stop({ drain: true, timeout: 'soon' })).rejects.toThrow(/Invalid duration/)
    await bot.send('u1', 'still running')
    expect(provider.outbox).toHaveLength(1)
    await bot.stop()
  })
})

describe('API coherence: onError takes a priority like before/after', () => {
  it('runs higher-priority error hooks first', async () => {
    const { bot, provider } = await createTestBot()
    const order: string[] = []
    bot.on('error', () => {})
    bot.onError('message', async () => { order.push('low') }, 0)
    bot.onError('message', async () => { order.push('high') }, 10)
    bot.when('boom', () => { throw new Error('boom') })
    provider.incoming('boom', { from: 'u1' })
    await vi.waitFor(() => expect(order).toHaveLength(2))
    expect(order).toEqual(['high', 'low'])
    await bot.stop()
  })
})

describe('API coherence: ConversationTarget', () => {
  it('abortConversation and inspectConversation take the same target shape', async () => {
    const { bot } = await createTestBot()
    const target: ConversationTarget = { from: 'u1', sender: 'u1', isGroup: false }
    expect(bot.inspectConversation(target)).toBeUndefined()
    expect(bot.abortConversation(target)).toBe(false)
    await bot.stop()
  })
})

describe('API coherence: MemoryStore.autoSaveInterval takes a duration', () => {
  it('accepts a duration string', () => {
    expect(() => new MemoryStore({ autoSaveInterval: '30s' })).not.toThrow()
  })

  it('fails fast on an invalid duration', () => {
    expect(() => new MemoryStore({ autoSaveInterval: 'often' })).toThrow(/Invalid duration/)
  })
})

describe('API coherence: isPlugin narrows unknown', () => {
  it('returns a boolean for any input', () => {
    expect(isPlugin({ name: 'p', install() {} })).toBe(true)
    expect(isPlugin(null)).toBe(false)
    expect(isPlugin(undefined)).toBe(false)
    expect(isPlugin('plugin')).toBe(false)
    expect(isPlugin({ name: 'p' })).toBe(false)
  })
})

describe('API coherence: error classes carry their own name', async () => {
  const errors = await import('../src/conversations/errors.js')
  const provider = await import('../src/core/provider.js')
  it('conversation control errors', () => {
    expect(new errors.ConversationTimeout().name).toBe('ConversationTimeout')
    expect(new errors.ConversationCancelled().name).toBe('ConversationCancelled')
    expect(new errors.RetriesExceeded().name).toBe('RetriesExceeded')
    expect(new errors.ConversationEnded().name).toBe('ConversationEnded')
    expect(new errors.ConversationGoto('x').name).toBe('ConversationGoto')
    expect(String(new errors.ConversationTimeout())).toBe('ConversationTimeout: conversation timeout')
  })
  it('the ProviderError base', () => {
    expect(new provider.ProviderError('x').name).toBe('ProviderError')
    expect(new provider.RateLimitedError(5).name).toBe('RateLimitedError')
  })
})

describe('API coherence: plugin-scoped hooks', () => {
  it('bot.hook() and bot.onError(priority) inside a plugin are removed on unplug', async () => {
    const { bot, provider } = await createTestBot()
    const seen: string[] = []
    bot.on('error', () => {})
    const unplug = bot.plug({
      name: 'p',
      version: '1.0.0',
      install({ bot: b }) {
        b.hook('message', 'before', async (_ctx: unknown, next: () => Promise<void>) => { seen.push('hook'); await next() })
        b.onError('message', async () => { seen.push('low') }, 0)
        b.onError('message', async () => { seen.push('high') }, 10)
      },
    })
    bot.when('boom', () => { throw new Error('boom') })
    provider.incoming('boom', { from: 'u1' })
    await vi.waitFor(() => expect(seen).toEqual(['hook', 'high', 'low']))
    unplug()
    seen.length = 0
    bot.when('hi', async (ctx) => { await ctx.reply('ok') })
    provider.incoming('hi', { from: 'u1' })
    await vi.waitFor(() => expect(provider.outbox).toHaveLength(1))
    expect(seen).toEqual([])
    await bot.stop()
  })
})
