import { afterEach, describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import type { ScheduledRun } from '../src/core/types.js'
import { MemoryLeaseProvider } from '../src/coordination/lease.js'
import { cronNextRun } from '../src/scheduler/cron.js'
import { MemoryScheduleStore, type ScheduleStore } from '../src/scheduler/ScheduleStore.js'
import { Scheduler } from '../src/scheduler/Scheduler.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'

const T0 = new Date(2026, 0, 5, 8, 0, 0, 0).getTime() // a Monday, 08:00 local
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

/** A pino-like logger that records calls by level. */
function recordingLogger() {
  const calls: Record<string, unknown[][]> = { warn: [], error: [], info: [] }
  const logger = {
    warn: (...a: unknown[]) => { calls.warn.push(a) },
    error: (...a: unknown[]) => { calls.error.push(a) },
    info: (...a: unknown[]) => { calls.info.push(a) },
    debug: () => {},
    child: () => logger,
  }
  return { logger: logger as never, calls }
}

function useClock(at = T0) {
  vi.useFakeTimers()
  vi.setSystemTime(at)
}

const settle = () => vi.advanceTimersByTimeAsync(0)

afterEach(() => {
  vi.useRealTimers()
})

describe('cronNextRun(expr, from)', () => {
  it('is pure for a given `from` and strictly after it', () => {
    const from = new Date(2026, 0, 5, 8, 59, 30)
    expect(cronNextRun('0 9 * * *', from)?.getTime()).toBe(new Date(2026, 0, 5, 9, 0).getTime())
    const at9 = new Date(2026, 0, 5, 9, 0, 0)
    expect(cronNextRun('0 9 * * *', at9)?.getTime()).toBe(new Date(2026, 0, 6, 9, 0).getTime())
    expect(cronNextRun('*/15 * * * *', at9)?.getTime()).toBe(new Date(2026, 0, 5, 9, 15).getTime())
  })
})

describe('Scheduler: in-memory API unchanged', () => {
  it('start() returns undefined without durable tasks (no async work)', () => {
    const s = new Scheduler()
    s.every(1000, () => {})
    expect(s.start()).toBeUndefined()
    s.stop()
  })

  it('plain tasks are not durable', () => {
    const s = new Scheduler()
    const t = s.every(1000, () => {})
    expect(t.durable).toBeUndefined()
    t.cancel()
  })
})

describe('Scheduler: durable tasks', () => {
  it('runs an interval task drift-free and persists the next slot', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const s = new Scheduler({ store })
    const runs: ScheduledRun[] = []
    const task = s.every('10s', { id: 'beat' }, (run) => { runs.push(run) })
    expect(task.durable).toBe(true)
    await s.start()
    expect((await store.get('beat'))?.nextRunAt).toBe(T0 + 10 * SEC)

    await vi.advanceTimersByTimeAsync(10 * SEC)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ taskId: 'beat', missed: false, fencingToken: 1 })
    expect(runs[0].scheduledAt.getTime()).toBe(T0 + 10 * SEC)
    expect(runs[0].occurrenceKey).toBe(`beat@${new Date(T0 + 10 * SEC).toISOString()}`)
    expect(await store.get('beat')).toMatchObject({ nextRunAt: T0 + 20 * SEC, lastStatus: 'ok', fencingToken: 1 })
    expect(task.nextRun?.getTime()).toBe(T0 + 20 * SEC)

    await vi.advanceTimersByTimeAsync(20 * SEC)
    expect(runs.map((r) => r.scheduledAt.getTime() - T0)).toEqual([10 * SEC, 20 * SEC, 30 * SEC])
    s.stop()
  })

  it('a restart keeps the stored nextRunAt instead of re-planning from now', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const first = new Scheduler({ store })
    first.every('1h', { id: 'hourly' }, () => {})
    await first.start()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    first.stop()

    await vi.advanceTimersByTimeAsync(10 * MIN)
    const second = new Scheduler({ store })
    const fn = vi.fn()
    second.every('1h', { id: 'hourly' }, fn)
    await second.start()
    expect((await store.get('hourly'))?.nextRunAt).toBe(T0 + HOUR)

    await vi.advanceTimersByTimeAsync(40 * MIN - 1)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledOnce()
    expect((fn.mock.calls[0][0] as ScheduledRun).scheduledAt.getTime()).toBe(T0 + HOUR)
    second.stop()
  })

  it('stop() pauses without deleting the stored schedule; cancel() deletes it', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const s = new Scheduler({ store })
    const task = s.every('1m', { id: 'x' }, () => {})
    await s.start()
    s.stop()
    expect(await store.get('x')).not.toBeNull()
    task.cancel()
    await settle()
    expect(await store.get('x')).toBeNull()
  })

  async function missedSetup(policy: 'skip' | 'run-once' | 'catch-up', maxCatchUp?: number) {
    useClock()
    const store = new MemoryScheduleStore()
    // The task was last planned for T0 + 1m; the process comes back at T0 + 3m30s.
    await store.register({ id: 'job', kind: 'interval', spec: String(MIN), nextRunAt: T0 + MIN }, T0)
    vi.setSystemTime(T0 + 3 * MIN + 30 * SEC)
    const { logger, calls } = recordingLogger()
    const s = new Scheduler({ store })
    const runs: ScheduledRun[] = []
    s.every('1m', { id: 'job', missed: policy, maxCatchUp }, (run) => { runs.push(run) })
    await s.start(logger)
    await settle()
    await settle()
    return { s, store, runs, calls }
  }

  it("missed: 'skip' runs nothing and waits for the next slot after now", async () => {
    const { s, store, runs } = await missedSetup('skip')
    expect(runs).toHaveLength(0)
    expect((await store.get('job'))?.nextRunAt).toBe(T0 + 4 * MIN)
    await vi.advanceTimersByTimeAsync(30 * SEC)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ missed: false })
    expect(runs[0].scheduledAt.getTime()).toBe(T0 + 4 * MIN)
    s.stop()
  })

  it("missed: 'run-once' runs the first missed slot once, flagged missed", async () => {
    const { s, store, runs } = await missedSetup('run-once')
    expect(runs).toHaveLength(1)
    expect(runs[0].missed).toBe(true)
    expect(runs[0].scheduledAt.getTime()).toBe(T0 + MIN)
    expect((await store.get('job'))?.nextRunAt).toBe(T0 + 4 * MIN)
    s.stop()
  })

  it("missed: 'catch-up' runs every missed slot in order with its own occurrence key", async () => {
    const { s, store, runs } = await missedSetup('catch-up')
    expect(runs.map((r) => r.scheduledAt.getTime() - T0)).toEqual([MIN, 2 * MIN, 3 * MIN])
    expect(runs.every((r) => r.missed)).toBe(true)
    expect(new Set(runs.map((r) => r.occurrenceKey)).size).toBe(3)
    // One claim covers the whole catch-up (no other replica can interleave).
    expect(runs.map((r) => r.fencingToken)).toEqual([1, 1, 1])
    expect((await store.get('job'))?.nextRunAt).toBe(T0 + 4 * MIN)
    s.stop()
  })

  it("missed: 'catch-up' is capped by maxCatchUp and logs the overflow", async () => {
    const { s, store, runs, calls } = await missedSetup('catch-up', 2)
    expect(runs.map((r) => r.scheduledAt.getTime() - T0)).toEqual([MIN, 2 * MIN])
    expect((await store.get('job'))?.nextRunAt).toBe(T0 + 4 * MIN)
    expect(calls.warn.some((a) => String(a[1]).includes('maxCatchUp'))).toBe(true)
    s.stop()
  })

  it('a one-shot delay keeps its run time across restarts and leaves a tombstone', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const a = new Scheduler({ store })
    a.delay('10m', { id: 'remind' }, () => {})
    await a.start()
    await vi.advanceTimersByTimeAsync(4 * MIN)
    a.stop()

    const b = new Scheduler({ store })
    const fn = vi.fn()
    const task = b.delay('10m', { id: 'remind' }, fn)
    await b.start()
    expect(task.runAt?.getTime()).toBe(T0 + 10 * MIN)
    await vi.advanceTimersByTimeAsync(6 * MIN)
    expect(fn).toHaveBeenCalledOnce()
    expect((await store.get('remind'))?.nextRunAt).toBeNull()
    b.stop()

    // Next boot: the tombstone keeps it from firing again.
    const c = new Scheduler({ store })
    const again = vi.fn()
    c.delay('10m', { id: 'remind' }, again)
    await c.start()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(again).not.toHaveBeenCalled()
    c.stop()
    await c.forget('remind')
    expect(await store.get('remind')).toBeNull()
  })

  it('two schedulers sharing a store run each slot exactly once', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const seen: number[] = []
    const make = () => {
      const s = new Scheduler({ store })
      s.every('10s', { id: 'shared' }, (run) => { seen.push(run.scheduledAt.getTime()) })
      return s
    }
    const a = make()
    const b = make()
    await a.start()
    await b.start()
    await vi.advanceTimersByTimeAsync(60 * SEC)
    expect(seen.map((t) => t - T0)).toEqual([10, 20, 30, 40, 50, 60].map((n) => n * SEC))
    a.stop()
    b.stop()
  })

  it('an occurrence claimed by a crashed process runs once its lease expires', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    await store.register({ id: 'job', kind: 'interval', spec: String(MIN), nextRunAt: T0 }, T0)
    // A process claimed T0's occurrence and died without completing it.
    const ghost = await store.claimDue('job', 'ghost', T0, 5 * SEC)
    expect(ghost?.fencingToken).toBe(1)

    const s = new Scheduler({ store, tickMs: 1000 })
    const runs: ScheduledRun[] = []
    s.every('1m', { id: 'job' }, (run) => { runs.push(run) })
    await s.start()
    await vi.advanceTimersByTimeAsync(4 * SEC)
    expect(runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2 * SEC)
    expect(runs).toHaveLength(1)
    expect(runs[0].scheduledAt.getTime()).toBe(T0)
    expect(runs[0].fencingToken).toBe(2)
    expect((await store.get('job'))?.nextRunAt).toBe(T0 + MIN)
    s.stop()
  })

  it('a stale complete is logged, and a failed renewal aborts the run signal', async () => {
    useClock()
    const inner = new MemoryScheduleStore()
    const store: ScheduleStore = {
      get: (id) => inner.get(id),
      register: (r, n) => inner.register(r, n),
      claimDue: (...a) => inner.claimDue(...a),
      renew: async () => false,
      complete: async () => false,
      delete: (id) => inner.delete(id),
      list: () => inner.list(),
    }
    const { logger, calls } = recordingLogger()
    const s = new Scheduler({ store })
    let signal: AbortSignal | undefined
    s.every('10s', { id: 'slow', leaseMs: '3s' }, async (run) => {
      signal = run.signal
      await new Promise((r) => setTimeout(r, 5 * SEC))
    })
    await s.start(logger)
    await vi.advanceTimersByTimeAsync(10 * SEC)
    await vi.advanceTimersByTimeAsync(1 * SEC)
    expect(signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(5 * SEC)
    expect(calls.warn.some((a) => String(a[1]).includes('lease lost'))).toBe(true)
    s.stop()
  })

  it('a handler error is logged, recorded and does not stop the schedule', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const { logger, calls } = recordingLogger()
    const s = new Scheduler({ store })
    let n = 0
    s.every('10s', { id: 'boom' }, () => { n++; if (n === 1) throw new Error('boom') })
    await s.start(logger)
    await vi.advanceTimersByTimeAsync(10 * SEC)
    expect((await store.get('boom'))?.lastStatus).toBe('error')
    expect(calls.error.some((a) => String(a[1]).includes('scheduled task failed'))).toBe(true)
    await vi.advanceTimersByTimeAsync(10 * SEC)
    expect(n).toBe(2)
    expect((await store.get('boom'))?.lastStatus).toBe('ok')
    s.stop()
  })

  it('stop() aborts the signal of a running handler', async () => {
    useClock()
    const s = new Scheduler({ store: new MemoryScheduleStore() })
    let signal: AbortSignal | undefined
    s.every('10s', { id: 'long' }, async (run) => {
      signal = run.signal
      await new Promise((r) => setTimeout(r, 60 * SEC))
    })
    await s.start()
    await vi.advanceTimersByTimeAsync(10 * SEC)
    expect(signal?.aborted).toBe(false)
    s.stop()
    expect(signal?.aborted).toBe(true)
  })

  it('a spec change between deploys re-plans from now', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    await store.register({ id: 'job', kind: 'interval', spec: String(HOUR), nextRunAt: T0 + HOUR }, T0)
    vi.setSystemTime(T0 + 30 * MIN)
    const s = new Scheduler({ store })
    s.every('2h', { id: 'job', missed: 'catch-up' }, () => {})
    await s.start()
    expect(await store.get('job')).toMatchObject({ spec: String(2 * HOUR), nextRunAt: T0 + 30 * MIN + 2 * HOUR })
    s.stop()
  })

  it('logs orphans once and never runs them', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    await store.register({ id: 'gone', kind: 'interval', spec: '1000', nextRunAt: T0 - HOUR }, T0 - HOUR)
    const { logger, calls } = recordingLogger()
    const s = new Scheduler({ store })
    await s.start(logger)
    await vi.advanceTimersByTimeAsync(10 * SEC)
    const orphanLogs = calls.warn.filter((a) => String(a[1]).includes('orphan'))
    expect(orphanLogs).toHaveLength(1)
    expect(orphanLogs[0][0]).toMatchObject({ taskId: 'gone' })
    expect((await store.get('gone'))?.fencingToken).toBe(0)
    s.stop()
  })

  it('runs cron tasks on their local-time slots', async () => {
    useClock()
    const s = new Scheduler({ store: new MemoryScheduleStore() })
    const slots: number[] = []
    s.cron('0 9 * * *', { id: 'morning' }, (run) => { slots.push(run.scheduledAt.getTime()) })
    await s.start()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(slots).toEqual([new Date(2026, 0, 5, 9, 0).getTime()])
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(slots).toHaveLength(2)
    s.stop()
  })

  it('a task registered while running is activated', async () => {
    useClock()
    const s = new Scheduler({ store: new MemoryScheduleStore() })
    await s.start()
    const fn = vi.fn()
    s.every('5s', { id: 'late' }, fn)
    await vi.advanceTimersByTimeAsync(5 * SEC)
    expect(fn).toHaveBeenCalledOnce()
    s.stop()
  })

  it('warns once when durable tasks have no persistent store', async () => {
    useClock()
    const { logger, calls } = recordingLogger()
    const s = new Scheduler()
    s.every('5s', { id: 'mem' }, () => {})
    await s.start(logger)
    expect(calls.warn.filter((a) => String(a[0]).includes('in-memory ScheduleStore'))).toHaveLength(1)
    s.stop()
  })

  it('retries registration after a store failure', async () => {
    useClock()
    const inner = new MemoryScheduleStore()
    let failures = 1
    const store: ScheduleStore = Object.assign(Object.create(inner) as ScheduleStore, {
      register: async (r: Parameters<ScheduleStore['register']>[0], n: number) => {
        if (failures-- > 0) throw new Error('store down')
        return inner.register(r, n)
      },
    })
    const s = new Scheduler({ store, tickMs: 1000 })
    await s.start()
    const fn = vi.fn()
    s.every('10s', { id: 'retry' }, fn)
    await vi.advanceTimersByTimeAsync(3 * SEC)
    expect(await inner.get('retry')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(15 * SEC)
    expect(fn).toHaveBeenCalled()
    s.stop()
  })

  it('with a lease provider, only the leader claims occurrences', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const lease = new MemoryLeaseProvider()
    const claims = { a: 0, b: 0 }
    const spy = (name: 'a' | 'b'): ScheduleStore => Object.assign(Object.create(store) as ScheduleStore, {
      claimDue: (...args: Parameters<ScheduleStore['claimDue']>) => { claims[name]++; return store.claimDue(...args) },
    })
    const fn = vi.fn()
    const a = new Scheduler({ store: spy('a'), lease, owner: 'a' })
    const b = new Scheduler({ store: spy('b'), lease, owner: 'b' })
    a.every('10s', { id: 'led' }, fn)
    b.every('10s', { id: 'led' }, fn)
    await a.start()
    await b.start()
    await vi.advanceTimersByTimeAsync(30 * SEC)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(claims.a).toBeGreaterThan(0)
    expect(claims.b).toBe(0)

    // The leader stops (releasing the lease): the follower takes over.
    a.stop()
    await vi.advanceTimersByTimeAsync(20 * SEC)
    expect(fn).toHaveBeenCalledTimes(5)
    expect(claims.b).toBeGreaterThan(0)
    b.stop()
  })

  describe('validation', () => {
    it('rejects duplicate ids, bad options and a missing handler', () => {
      const s = new Scheduler()
      const t = s.every('1m', { id: 'dup' }, () => {})
      expect(() => s.every('1m', { id: 'dup' }, () => {})).toThrow(TypeError)
      t.cancel()
      expect(() => s.every('1m', { id: 'dup' }, () => {})).not.toThrow()
      expect(() => s.every('1m', { id: '' }, () => {})).toThrow(TypeError)
      expect(() => s.every('1m', { id: 'p', missed: 'later' as never }, () => {})).toThrow(TypeError)
      expect(() => s.every('1m', { id: 'q', maxCatchUp: 0 }, () => {})).toThrow(RangeError)
      expect(() => s.every(0, { id: 'r' }, () => {})).toThrow(RangeError)
      expect(() => s.cron('0 9 * * mon', { id: 's' }, () => {})).toThrow(TypeError)
      expect(() => s.every('1m', { id: 'u' }, undefined as never)).toThrow(TypeError)
    })

    it('rejects a scheduler store that is not a ScheduleStore', () => {
      expect(() => new Scheduler({ store: {} as never })).toThrow(/scheduler.store must implement ScheduleStore/)
      expect(() => new Bot({ provider: new MockProvider(), scheduler: { store: { get() {} } as never } })).toThrow(TypeError)
    })
  })
})

describe('Bot: durable scheduler wiring', () => {
  it('scopes task ids by the store namespace and runs durable tasks after start', async () => {
    useClock()
    const schedules = new MemoryScheduleStore()
    const bot = new Bot({ provider: new MockProvider(), botId: 'shop', scheduler: { store: schedules } })
    const fn = vi.fn()
    bot.every('10s', { id: 'report' }, fn)
    await bot.start()
    const ids = (await schedules.list()).map((r) => r.id)
    expect(ids).toEqual(['local|default|shop|mock|default|report'])
    await vi.advanceTimersByTimeAsync(10 * SEC)
    expect(fn).toHaveBeenCalledOnce()
    expect((fn.mock.calls[0][0] as ScheduledRun).taskId).toBe('report')
    await bot.stop()
    expect(await schedules.list()).toHaveLength(1)
  })

  it('a schedule store failure rejects start() and rolls the provider and store back', async () => {
    const provider = new MockProvider()
    provider.stop = vi.fn(provider.stop.bind(provider))
    const store = new MemoryStore()
    store.stop = vi.fn(store.stop.bind(store))
    const schedules = new MemoryScheduleStore()
    schedules.list = async () => { throw new Error('schedules down') }
    const bot = new Bot({ provider, store, scheduler: { store: schedules } })
    bot.every('10s', { id: 'x' }, () => {})
    await expect(bot.start()).rejects.toThrow('schedules down')
    expect(provider.stop).toHaveBeenCalledOnce()
    expect(store.stop).toHaveBeenCalledOnce()
  })

  it('stop() releases the scheduler leader lease before the store closes', async () => {
    useClock()
    const order: string[] = []
    const lease = new MemoryLeaseProvider()
    const release = lease.release.bind(lease)
    lease.release = async (...args) => {
      await new Promise((r) => setTimeout(r, 50))
      order.push('lease released')
      return release(...args)
    }
    const store = new MemoryStore()
    const stopStore = store.stop.bind(store)
    store.stop = async () => { order.push('store stopped'); return stopStore() }
    const bot = new Bot({ provider: new MockProvider(), store, scheduler: { store: new MemoryScheduleStore(), lease } })
    bot.every('1s', { id: 'led' }, () => {})
    await bot.start()
    await vi.advanceTimersByTimeAsync(1 * SEC)
    const stopping = bot.stop()
    await vi.advanceTimersByTimeAsync(50)
    await stopping
    expect(order).toEqual(['lease released', 'store stopped'])
  })

  it('without durable tasks, bot.schedule/every/delay keep the in-memory behaviour', async () => {
    useClock()
    const bot = new Bot({ provider: new MockProvider() })
    const fn = vi.fn()
    const t = bot.every('1s', fn)
    expect(t.durable).toBeUndefined()
    await bot.start()
    await vi.advanceTimersByTimeAsync(1 * SEC)
    expect(fn).toHaveBeenCalledOnce()
    expect(fn.mock.calls[0]).toEqual([])
    await bot.stop()
  })
})
