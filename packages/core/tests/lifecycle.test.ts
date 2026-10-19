import { describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'

describe('Bot lifecycle', () => {
  it('rolls back a failed provider start and can be started again', async () => {
    const provider = new MockProvider()
    const store = new MemoryStore()
    const originalStart = provider.start.bind(provider)
    provider.start = vi.fn()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockImplementation(originalStart)
    provider.stop = vi.fn(provider.stop.bind(provider))
    store.stop = vi.fn(store.stop.bind(store))
    const bot = new Bot({ provider, store })

    await expect(bot.start()).rejects.toThrow('provider down')
    expect(provider.stop).toHaveBeenCalledOnce()
    expect(store.stop).toHaveBeenCalledOnce()

    await expect(bot.start()).resolves.toBeUndefined()
    await bot.stop()
  })

  it('serializes concurrent start calls', async () => {
    const provider = new MockProvider()
    const originalStart = provider.start.bind(provider)
    provider.start = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await originalStart()
    })
    const bot = new Bot({ provider })

    await Promise.all([bot.start(), bot.start(), bot.start()])

    expect(provider.start).toHaveBeenCalledOnce()
    await bot.stop()
  })

  it('debug logging does not require pino-pretty', () => {
    expect(() => new Bot({ provider: new MockProvider(), debug: true })).not.toThrow()
  })

  it('default logger shows warn/error (plugin failures stay visible); debug: true lowers it to debug', () => {
    const quiet = new Bot({ provider: new MockProvider() })
    expect((quiet.logger as unknown as { level: string }).level).toBe('warn')
    expect((quiet.logger as unknown as { isLevelEnabled(l: string): boolean }).isLevelEnabled('warn')).toBe(true)
    expect((quiet.logger as unknown as { isLevelEnabled(l: string): boolean }).isLevelEnabled('info')).toBe(false)
    const verbose = new Bot({ provider: new MockProvider(), debug: true })
    expect((verbose.logger as unknown as { level: string }).level).toBe('debug')
  })

  it('turns inbound persistence failures into bot error events', async () => {
    const provider = new MockProvider()
    const store = new MemoryStore()
    store.saveMessage = vi.fn(async () => { throw new Error('store unavailable') })
    const bot = new Bot({ provider, store })
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    await bot.start()

    provider.incoming('hello')
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toBeInstanceOf(Error)

    await bot.stop()
  })
})
