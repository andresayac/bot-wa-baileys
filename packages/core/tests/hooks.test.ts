import { describe, it, expect, vi } from 'vitest'
import { HookSystem } from '../src/hooks/HookSystem.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import type { InboundEvent } from '../src/core/provider.js'
import type { HookEvent } from '../src/core/types.js'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

describe('HookSystem.runBefore', () => {
  it('resolves true when every hook calls next()', async () => {
    const hooks = new HookSystem()
    const order: string[] = []
    hooks.register('message', 'before', async (_c: unknown, next: () => Promise<void>) => { order.push('a'); await next() })
    hooks.register('message', 'before', async (_c: unknown, next: () => Promise<void>) => { order.push('b'); await next() })
    expect(await hooks.runBefore('message', { abort() {} })).toBe(true)
    expect(order).toEqual(['a', 'b'])
  })

  it('resolves true with no hooks', async () => {
    expect(await new HookSystem().runBefore('message', { abort() {} })).toBe(true)
  })

  it('a hook that returns without next() stops the chain AND the event', async () => {
    const hooks = new HookSystem()
    const later = vi.fn()
    hooks.register('message', 'before', () => { /* no next() */ }, 10)
    hooks.register('message', 'before', later, 0)
    expect(await hooks.runBefore('message', { abort() {} })).toBe(false)
    expect(later).not.toHaveBeenCalled()
  })

  it('the last hook returning without next() also stops the event', async () => {
    const hooks = new HookSystem()
    hooks.register('message', 'before', async (_c: unknown, next: () => Promise<void>) => { await next() }, 10)
    hooks.register('message', 'before', () => { /* no next() */ }, 0)
    expect(await hooks.runBefore('message', { abort() {} })).toBe(false)
  })

  it('abort() stops the event', async () => {
    const hooks = new HookSystem()
    hooks.register('message', 'before', (c: { abort(): void }) => { c.abort() })
    expect(await hooks.runBefore('message', { abort() {} })).toBe(false)
  })
})

describe('before("message") without next()', () => {
  it('is not routed', async () => {
    const { bot, provider } = await createTestBot()
    const handler = vi.fn()
    bot.before('message', () => { /* filter: no next() */ })
    bot.when('hola', handler)
    provider.incoming('hola')
    await tick()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('provider events: before-hook abort() suppresses after-hooks and bot.on', () => {
  const cases: Array<{ hook: HookEvent; event: InboundEvent }> = [
    { hook: 'reaction', event: { kind: 'reaction', reaction: { ref: { id: 'm1', chatId: 'c1' }, emoji: '👍', senderId: 'u1' } } },
    { hook: 'poll', event: { kind: 'poll-vote', vote: { ref: { id: 'm1', chatId: 'c1' }, senderId: 'u1', options: [] } } },
    { hook: 'group', event: { kind: 'group', event: { chatId: 'g1', action: 'add', participants: ['u1'] } } },
    { hook: 'presence', event: { kind: 'presence', event: { chatId: 'c1', presences: {} } } },
    { hook: 'status', event: { kind: 'status', status: { ref: { id: 'm1', chatId: 'c1' }, status: 'read', timestamp: 1 } } },
    { hook: 'call', event: { kind: 'call', event: { id: 'call-1', from: 'u1', status: 'offer' } } },
  ]

  for (const { hook, event } of cases) {
    it(`${hook}: aborted → no after-hook, no event`, async () => {
      const { bot, provider } = await createTestBot()
      const after = vi.fn()
      const listener = vi.fn()
      bot.before(hook, (p: { abort(): void }) => { p.abort() })
      bot.after(hook, after)
      bot.on(hook, listener)
      provider['emitEvent'](event)
      await tick()
      expect(after).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
    })

    it(`${hook}: passed → after-hook and event`, async () => {
      const { bot, provider } = await createTestBot()
      const after = vi.fn()
      const listener = vi.fn()
      bot.before(hook, async (_p: unknown, next: () => Promise<void>) => { await next() })
      bot.after(hook, after)
      bot.on(hook, listener)
      provider['emitEvent'](event)
      await tick()
      expect(after).toHaveBeenCalledOnce()
      expect(listener).toHaveBeenCalledOnce()
    })
  }
})
