/**
 * Cross-feature checks for the wave-2 features merged together (onIdle × handoff, …).
 * Each feature has its own suite; this file covers how they interact in one Bot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { MemoryStore } from '../src/store/MemoryStore.js'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('onIdle × human handoff (real bot.handoff / bot.resume)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('bot.handoff() cancels the chat idle timer and bot.resume() lets it re-arm', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    const fired: string[] = []
    bot.onIdle(1000, (_ctx, e) => { fired.push(e.chatId) })
    provider.incoming('hola', { from: 'chat-a' }); await settle()
    await bot.handoff('chat-a'); await settle()
    provider.incoming('con el agente', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).toEqual([])
    await bot.resume('chat-a'); await settle()
    provider.incoming('de vuelta', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fired).toEqual(['chat-a'])
    await bot.stop()
  })

  it('a handoff restored from the store at start() (no event) still suspends onIdle', async () => {
    const store = new MemoryStore()
    const first = new Bot({ provider: new MockProvider(), store })
    await first.start()
    await first.handoff('chat-a'); await settle()
    await first.stop()

    const provider = new MockProvider()
    const bot = new Bot({ provider, store })
    await bot.start()
    expect(bot.isHandedOff('chat-a')).toBe(true)
    const fired = vi.fn()
    bot.onIdle(1000, fired)
    provider.incoming('sigo con el agente', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).not.toHaveBeenCalled()
    await bot.stop()
  })
})
