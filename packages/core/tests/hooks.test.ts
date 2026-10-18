import { describe, it, expect, vi } from 'vitest'
import { HookSystem } from '../src/hooks/HookSystem.js'
import { createTestBot } from '../src/testing/createTestBot.js'

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
