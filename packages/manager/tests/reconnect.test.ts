import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { BotManager, computeBackoff, resolveAutoReconnect, type ReconnectingInfo } from '../src/index.js'

class EventBot extends EventEmitter {
  starts = 0
  stops = 0
  failStarts = 0
  async start(): Promise<void> {
    this.starts++
    if (this.failStarts > 0) {
      this.failStarts--
      throw new Error('start failed')
    }
    this.emit('connection', { state: 'ready' })
  }
  async stop(): Promise<void> {
    this.stops++
    this.emit('connection', { state: 'closed' })
  }
  drop(reason = 'transient'): void { this.emit('connection', { state: 'closed', reason }) }
}

afterEach(() => { vi.useRealTimers() })

describe('computeBackoff', () => {
  const base = resolveAutoReconnect({ initialDelay: 100, maxDelay: 1000, jitter: 0, random: () => 0.5 })

  it('grows exponentially and is capped', () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => computeBackoff(n, base))).toEqual([100, 200, 400, 800, 1000, 1000])
  })

  it('grows linearly when asked', () => {
    const linear = { ...base, backoff: 'linear' as const }
    expect([0, 1, 2].map((n) => computeBackoff(n, linear))).toEqual([100, 200, 300])
  })

  it('applies jitter as a bounded reduction', () => {
    const jittered = { ...base, jitter: 0.5, random: () => 1 }
    expect(computeBackoff(1, jittered)).toBe(100)
    expect(computeBackoff(1, { ...jittered, random: () => 0 })).toBe(200)
    for (let i = 0; i < 50; i++) {
      const d = computeBackoff(3, { ...base, jitter: 0.3, random: Math.random })
      expect(d).toBeGreaterThanOrEqual(560)
      expect(d).toBeLessThanOrEqual(800)
    }
  })

  it('validates options', () => {
    expect(() => resolveAutoReconnect({ jitter: 2 })).toThrow(RangeError)
    expect(() => resolveAutoReconnect({ initialDelay: 10, maxDelay: 5 })).toThrow(RangeError)
    expect(resolveAutoReconnect(undefined).enabled).toBe(false)
    expect(resolveAutoReconnect(true).enabled).toBe(true)
    expect(resolveAutoReconnect({ enabled: false }).enabled).toBe(false)
  })
})

describe('BotManager auto-reconnect supervision', () => {
  const opts = { initialDelay: 100, maxDelay: 1000, jitter: 0, graceMs: 500, maxRetries: 3 }

  it('restarts a bot whose connection drops, after the grace period', async () => {
    vi.useFakeTimers()
    const manager = new BotManager({ autoReconnect: opts })
    const bot = new EventBot()
    const events: ReconnectingInfo[] = []
    const reconnected = vi.fn()
    manager.on('reconnecting', (i) => events.push(i))
    manager.on('reconnected', reconnected)
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    expect(bot.starts).toBe(1)

    bot.drop()
    expect(events).toEqual([{ id: 'a', attempt: 1, delayMs: 500, reason: 'transient' }])
    await vi.advanceTimersByTimeAsync(499)
    expect(bot.starts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(bot.starts).toBe(2)
    expect(bot.stops).toBe(1)
    expect(reconnected).toHaveBeenCalledWith({ id: 'a', attempts: 1 })
    expect(manager.isRunning('a')).toBe(true)
    expect(manager.metrics('a')).toMatchObject({ restarts: 1, reconnectAttempts: 0 })
  })

  it('does nothing when the provider heals itself within the grace period', async () => {
    vi.useFakeTimers()
    const manager = new BotManager({ autoReconnect: opts })
    const bot = new EventBot()
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    bot.drop()
    bot.emit('connection', { state: 'ready' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(bot.starts).toBe(1)
  })

  it('never reconnects a session taken over, nor after a manual stop', async () => {
    vi.useFakeTimers()
    const manager = new BotManager({ autoReconnect: opts })
    const bot = new EventBot()
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    bot.drop('sessionTakenOver')
    await vi.advanceTimersByTimeAsync(5000)
    expect(bot.starts).toBe(1)
    await manager.start('a')
    await manager.stop('a')
    await vi.advanceTimersByTimeAsync(5000)
    expect(bot.starts).toBe(1)
  })

  it('backs off exponentially across failed restarts and gives up after maxRetries', async () => {
    vi.useFakeTimers()
    const manager = new BotManager({ autoReconnect: opts })
    const bot = new EventBot()
    const delays: number[] = []
    const failed = vi.fn()
    manager.on('reconnecting', (i) => delays.push(i.delayMs))
    manager.on('reconnectFailed', failed)
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    bot.failStarts = 99
    bot.drop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(delays).toEqual([500, 200, 400])
    expect(bot.starts).toBe(1 + 3)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed.mock.calls[0][0]).toMatchObject({ id: 'a', attempts: 3 })
    expect(manager.isRunning('a')).toBe(false)
  })

  it('is disabled by default', async () => {
    vi.useFakeTimers()
    const manager = new BotManager()
    const bot = new EventBot()
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    bot.drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bot.starts).toBe(1)
  })

  it('tracks the connection state and QR payload', async () => {
    const manager = new BotManager()
    const bot = new EventBot()
    const seen: string[] = []
    manager.on('connection', (c) => seen.push(c.state))
    manager.add(bot, { id: 'a' })
    bot.emit('connection', { state: 'authenticating', authPayload: 'QR-DATA' })
    expect(manager.connection('a')).toMatchObject({ state: 'authenticating', authPayload: 'QR-DATA' })
    bot.emit('connection', { state: 'ready' })
    expect(manager.connection('a')).toMatchObject({ state: 'ready' })
    expect(manager.connection('a')!.authPayload).toBeUndefined()
    expect(seen).toEqual(['authenticating', 'ready'])
  })
})

describe('supervised restart of config-backed bots', () => {
  it('recreates the bot through the factory (fresh instance) on reconnect', async () => {
    vi.useFakeTimers()
    const built: EventBot[] = []
    const { MemoryBotConfigStore } = await import('../src/index.js')
    const manager = new BotManager({
      configStore: new MemoryBotConfigStore(),
      autoReconnect: { initialDelay: 10, maxDelay: 100, jitter: 0, graceMs: 0 },
      factory: () => { const b = new EventBot(); built.push(b); return b },
    })
    await manager.createBot({ id: 'x' })
    expect(built).toHaveLength(1)
    built[0].drop()
    await vi.advanceTimersByTimeAsync(10)
    expect(built).toHaveLength(2)
    expect(manager.get('x')).toBe(built[1])
    expect(built[0].stops).toBe(1)
    expect(built[1].starts).toBe(1)
    expect(manager.connection('x')!.state).toBe('ready')
    expect(manager.getConfig('x')!.desiredState).toBe('running')
    await manager.shutdown()
  })

  it('retries a failed start from createBot()/restore()', async () => {
    vi.useFakeTimers()
    const { MemoryBotConfigStore } = await import('../src/index.js')
    let failures = 2
    const manager = new BotManager({
      configStore: new MemoryBotConfigStore(),
      autoReconnect: { initialDelay: 10, maxDelay: 100, jitter: 0 },
      factory: () => {
        const b = new EventBot()
        b.failStarts = failures > 0 ? 1 : 0
        failures--
        return b
      },
    })
    await manager.createBot({ id: 'y' })
    expect(manager.isRunning('y')).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(manager.isRunning('y')).toBe(true)
    await manager.shutdown()
  })
})
