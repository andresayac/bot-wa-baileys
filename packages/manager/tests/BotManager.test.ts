/**
 * BotManager — unit tests. Uses fake bots ({ start, stop } stubs with
 * isStarted tracking) — no real Bot/transport, fully hermetic.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { BotManager, type ManagerErrorInfo, type StartStopOutcome } from '../src/index.js'

interface FakeBot {
  calls: string[]
  isStarted: boolean
  start: () => Promise<void>
  stop: () => Promise<void>
}

function fakeBot(): FakeBot {
  const bot: FakeBot = {
    calls: [],
    isStarted: false,
    start: async () => {
      bot.calls.push('start')
      bot.isStarted = true
    },
    stop: async () => {
      bot.calls.push('stop')
      bot.isStarted = false
    },
  }
  return bot
}

function failingStartBot(message = 'boom'): FakeBot {
  const bot = fakeBot()
  bot.start = async () => {
    bot.calls.push('start:fail')
    throw new Error(message)
  }
  return bot
}

function failingStopBot(message = 'stop-fail'): FakeBot {
  const bot = fakeBot()
  bot.stop = async () => {
    bot.calls.push('stop:fail')
    throw new Error(message)
  }
  return bot
}

describe('BotManager — registry', () => {
  let manager: BotManager

  beforeEach(() => {
    manager = new BotManager()
  })

  it('add() assigns auto ids bot-N', () => {
    expect(manager.add(fakeBot())).toBe('bot-1')
    expect(manager.add(fakeBot())).toBe('bot-2')
    expect(manager.size).toBe(2)
  })

  it('add() honors an explicit id', () => {
    expect(manager.add(fakeBot(), { id: 'sales' })).toBe('sales')
    expect(manager.has('sales')).toBe(true)
  })

  it('add() throws on duplicate id', () => {
    manager.add(fakeBot(), { id: 'dup' })
    expect(() => manager.add(fakeBot(), { id: 'dup' })).toThrow(/already registered/)
  })

  it('auto ids never collide with explicit ids', () => {
    manager.add(fakeBot(), { id: 'bot-1' })
    // counter starts at 0 → tries bot-1 (taken) → yields bot-2
    expect(manager.add(fakeBot())).toBe('bot-2')
  })

  it('get() returns the bot instance or undefined', () => {
    const bot = fakeBot()
    manager.add(bot, { id: 'a' })
    expect(manager.get('a')).toBe(bot)
    expect(manager.get('nope')).toBeUndefined()
  })

  it('has() reflects registration', () => {
    manager.add(fakeBot(), { id: 'x' })
    expect(manager.has('x')).toBe(true)
    expect(manager.has('y')).toBe(false)
  })

  it('list() reports id/running/meta for every bot', () => {
    manager.add(fakeBot(), { id: 'a', meta: { tenant: 'acme' } })
    manager.add(fakeBot(), { id: 'b' })
    expect(manager.list()).toEqual([
      { id: 'a', running: false, meta: { tenant: 'acme' } },
      { id: 'b', running: false, meta: undefined },
    ])
  })

  it('status() snapshots one bot; undefined when unknown', () => {
    manager.add(fakeBot(), { id: 'a', meta: { n: 1 } })
    expect(manager.status('a')).toEqual({ id: 'a', running: false, meta: { n: 1 } })
    expect(manager.status('zz')).toBeUndefined()
  })

  it('entries() exposes createdAt and the bot instance', () => {
    const bot = fakeBot()
    const before = Date.now()
    manager.add(bot, { id: 'a' })
    const [entry] = manager.entries()
    expect(entry.id).toBe('a')
    expect(entry.bot).toBe(bot)
    expect(entry.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('remove() returns false for unknown ids', async () => {
    expect(await manager.remove('ghost')).toBe(false)
  })

  it('remove() unregisters and emits removed', async () => {
    manager.add(fakeBot(), { id: 'a' })
    const removed: string[] = []
    manager.on('removed', (id) => removed.push(id))
    expect(await manager.remove('a')).toBe(true)
    expect(manager.has('a')).toBe(false)
    expect(manager.size).toBe(0)
    expect(removed).toEqual(['a'])
  })

  it('remove() stops a running bot first', async () => {
    const bot = fakeBot()
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    expect(await manager.remove('a')).toBe(true)
    expect(bot.calls).toEqual(['start', 'stop'])
    expect(bot.isStarted).toBe(false)
    expect(manager.isRunning('a')).toBe(false)
  })

  it('remove() still unregisters when stop() fails (error emitted)', async () => {
    const bot = failingStopBot()
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    const errors: ManagerErrorInfo[] = []
    manager.on('error', (info) => errors.push(info))
    expect(await manager.remove('a')).toBe(true)
    expect(manager.has('a')).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0].id).toBe('a')
  })
})

describe('BotManager — lifecycle', () => {
  let manager: BotManager

  beforeEach(() => {
    manager = new BotManager()
  })

  it('start() runs the bot and tracks running state', async () => {
    const bot = fakeBot()
    manager.add(bot, { id: 'a' })
    expect(manager.isRunning('a')).toBe(false)
    await manager.start('a')
    expect(manager.isRunning('a')).toBe(true)
    expect(bot.isStarted).toBe(true)
    expect(manager.status('a')?.running).toBe(true)
  })

  it('start() is idempotent for a running bot', async () => {
    const bot = fakeBot()
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    await manager.start('a')
    expect(bot.calls).toEqual(['start'])
  })

  it('stop() clears running state', async () => {
    const bot = fakeBot()
    manager.add(bot, { id: 'a' })
    await manager.start('a')
    await manager.stop('a')
    expect(manager.isRunning('a')).toBe(false)
    expect(bot.isStarted).toBe(false)
  })

  it('stop() is a no-op when not running', async () => {
    const bot = fakeBot()
    manager.add(bot, { id: 'a' })
    await manager.stop('a')
    expect(bot.calls).toEqual([])
  })

  it('start()/stop() throw for unknown ids', async () => {
    await expect(manager.start('ghost')).rejects.toThrow(/not registered/)
    await expect(manager.stop('ghost')).rejects.toThrow(/not registered/)
  })

  it('start() failure re-throws and emits error, bot stays stopped', async () => {
    const bot = failingStartBot('kaboom')
    manager.add(bot, { id: 'bad' })
    const errors: ManagerErrorInfo[] = []
    manager.on('error', (info) => errors.push(info))
    await expect(manager.start('bad')).rejects.toThrow('kaboom')
    expect(manager.isRunning('bad')).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0].id).toBe('bad')
    expect((errors[0].error as Error).message).toBe('kaboom')
  })

  it('stop() failure re-throws, bot stays marked running', async () => {
    const bot = failingStopBot('stuck')
    manager.add(bot, { id: 'bad' })
    await manager.start('bad')
    await expect(manager.stop('bad')).rejects.toThrow('stuck')
    expect(manager.isRunning('bad')).toBe(true)
  })

  it('startAll() starts in parallel and collects failures without throwing', async () => {
    const good = fakeBot()
    const bad = failingStartBot('nope')
    manager.add(good, { id: 'good' })
    manager.add(bad, { id: 'bad' })
    const results = await manager.startAll()
    expect(results.good).toBe('ok')
    expect(results.bad).toBeInstanceOf(Error)
    expect((results.bad as Error).message).toBe('nope')
    expect(manager.isRunning('good')).toBe(true)
    expect(manager.isRunning('bad')).toBe(false)
  })

  it('stopAll() stops in parallel and collects failures without throwing', async () => {
    const good = fakeBot()
    const bad = failingStopBot('wont-die')
    manager.add(good, { id: 'good' })
    manager.add(bad, { id: 'bad' })
    await manager.startAll()
    const results = await manager.stopAll()
    expect(results.good).toBe('ok')
    expect(results.bad).toBeInstanceOf(Error)
    expect((results.bad as Error).message).toBe('wont-die')
    expect(manager.isRunning('good')).toBe(false)
    expect(manager.isRunning('bad')).toBe(true)
  })

  it('startAll()/stopAll() on an empty manager return {}', async () => {
    await expect(manager.startAll()).resolves.toEqual({})
    await expect(manager.stopAll()).resolves.toEqual({})
  })

  it('results map wraps non-Error rejections', async () => {
    const bot = fakeBot()
    bot.start = async () => {
      throw 'string-failure'
    }
    manager.add(bot, { id: 'a' })
    const results: Record<string, StartStopOutcome> = await manager.startAll()
    expect(results.a).toBeInstanceOf(Error)
    expect((results.a as Error).message).toBe('string-failure')
  })

  it('unhandled error events do not crash (safety listener)', async () => {
    // No 'error' listener attached beyond the manager's own safety net:
    // startAll must simply collect the failure.
    manager.add(failingStartBot(), { id: 'bad' })
    const results = await manager.startAll()
    expect(results.bad).toBeInstanceOf(Error)
  })
})

describe('BotManager — events', () => {
  it('emits added/started/stopped/removed with ids', async () => {
    const manager = new BotManager()
    const events: Array<[string, unknown]> = []
    manager.on('added', (id) => events.push(['added', id]))
    manager.on('started', (id) => events.push(['started', id]))
    manager.on('stopped', (id) => events.push(['stopped', id]))
    manager.on('removed', (id) => events.push(['removed', id]))

    const bot = fakeBot()
    const id = manager.add(bot, { id: 'e' })
    await manager.start(id)
    await manager.stop(id)
    await manager.remove(id)

    expect(events).toEqual([
      ['added', 'e'],
      ['started', 'e'],
      ['stopped', 'e'],
      ['removed', 'e'],
    ])
  })

  it('emits error with { id, error } on start failure', async () => {
    const manager = new BotManager()
    const errors: ManagerErrorInfo[] = []
    manager.on('error', (info) => errors.push(info))
    manager.add(failingStartBot('zap'), { id: 'z' })
    await manager.startAll()
    expect(errors).toHaveLength(1)
    expect(errors[0].id).toBe('z')
    expect((errors[0].error as Error).message).toBe('zap')
  })

  it('supports once()/off() with typed listeners', async () => {
    const manager = new BotManager()
    const seen: string[] = []
    const listener = (id: string) => seen.push(id)
    manager.once('added', listener)
    manager.add(fakeBot(), { id: 'a' })
    manager.add(fakeBot(), { id: 'b' })
    expect(seen).toEqual(['a'])

    manager.on('added', listener)
    manager.off('added', listener)
    manager.add(fakeBot(), { id: 'c' })
    expect(seen).toEqual(['a'])
  })
})
