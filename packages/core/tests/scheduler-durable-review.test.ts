/** Durable scheduler: late registration, leadership, catch-up races, fencing and restarts. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import type { ScheduledRun } from '../src/core/types.js'
import { MemoryLeaseProvider, type LeaseProvider } from '../src/coordination/lease.js'
import { MemoryScheduleStore, type ScheduleStore } from '../src/scheduler/ScheduleStore.js'
import { Scheduler } from '../src/scheduler/Scheduler.js'
import { MockProvider } from '../src/testing/MockProvider.js'

const T0 = new Date(2026, 0, 5, 8, 0, 0, 0).getTime()
const SEC = 1000
const MIN = 60 * SEC

function useClock(at = T0) {
  vi.useFakeTimers()
  vi.setSystemTime(at)
}

/** `store` with `ms` of latency on every call (fake timers). */
function slowStore(store: ScheduleStore, ms: number): ScheduleStore {
  const wait = () => new Promise((r) => setTimeout(r, ms))
  return {
    get: async (id) => { await wait(); return store.get(id) },
    register: async (r, n) => { await wait(); return store.register(r, n) },
    claimDue: async (...a) => { await wait(); return store.claimDue(...a) },
    renew: async (...a) => { await wait(); return store.renew(...a) },
    complete: async (...a) => { await wait(); return store.complete(...a) },
    delete: async (id) => { await wait(); return store.delete(id) },
    list: async () => { await wait(); return store.list() },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('durable scheduler: tasks registered after start', () => {
  it('a Bot without scheduler config runs a durable task registered after start()', async () => {
    useClock()
    const bot = new Bot({ provider: new MockProvider() })
    await bot.start()
    const fn = vi.fn()
    bot.delay('1s', { id: 'late', missed: 'run-once' }, fn)
    await vi.advanceTimersByTimeAsync(5 * SEC)
    expect(fn).toHaveBeenCalledOnce()
    await bot.stop()
  })

  it('a standalone Scheduler started with nothing durable activates later durable tasks', async () => {
    useClock()
    const s = new Scheduler()
    expect(s.start()).toBeUndefined()
    const fn = vi.fn()
    s.every('2s', { id: 'beat' }, fn)
    await vi.advanceTimersByTimeAsync(6 * SEC)
    expect(fn).toHaveBeenCalledTimes(3)
    s.stop()
  })
})

describe('durable scheduler: one-shot tasks', () => {
  it('drops a finished one-shot from memory: its id can be registered again, and cancel() deletes the tombstone', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const s = new Scheduler({ store })
    await s.start()
    const fn = vi.fn()
    const task = s.delay('1s', { id: 'remind:1' }, fn)
    await vi.advanceTimersByTimeAsync(2 * SEC)
    expect(fn).toHaveBeenCalledOnce()
    expect((await store.get('remind:1'))?.nextRunAt).toBeNull()
    // The same id again is the tombstone (it does not run twice), but registering it does not throw.
    const again = vi.fn()
    expect(() => s.delay('1s', { id: 'remind:1' }, again)).not.toThrow()
    await vi.advanceTimersByTimeAsync(5 * SEC)
    expect(again).not.toHaveBeenCalled()
    task.cancel()
    await vi.advanceTimersByTimeAsync(0)
    expect(await store.get('remind:1')).toBeNull()
    s.stop()
  })
})

describe('durable scheduler: leadership is an optimisation only', () => {
  it('a task registered only on a follower still runs', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const lease = new MemoryLeaseProvider()
    const a = new Scheduler({ store, lease, owner: 'a', leaderTtlMs: '10s' })
    const b = new Scheduler({ store, lease, owner: 'b', leaderTtlMs: '10s' })
    const common = vi.fn()
    const onlyB = vi.fn()
    a.every('5s', { id: 'common' }, common)
    b.every('5s', { id: 'common' }, common)
    b.every('5s', { id: 'onlyB' }, onlyB)
    await a.start()
    await vi.advanceTimersByTimeAsync(1)
    await b.start()
    await vi.advanceTimersByTimeAsync(120 * SEC)
    expect(common.mock.calls.length).toBeGreaterThanOrEqual(23)
    expect(onlyB.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(onlyB.mock.calls.every((c) => (c[0] as ScheduledRun).missed === false)).toBe(true)
    a.stop()
    b.stop()
  })

  it('on a leader crash, the slots that fell due during the failover window run (not skipped as missed)', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const lease = new MemoryLeaseProvider()
    // A "crash": stop() without releasing the leader lease, which then has to expire.
    const crashing: LeaseProvider = {
      acquire: (...a) => lease.acquire(...a),
      renew: (...a) => lease.renew(...a),
      release: async () => {},
    }
    const a = new Scheduler({ store, lease: crashing, owner: 'a', leaderTtlMs: '10s' })
    const b = new Scheduler({ store, lease, owner: 'b', leaderTtlMs: '10s' })
    const runs: Array<[string, number, boolean]> = []
    a.every('5s', { id: 'job' }, async (run) => {
      runs.push(['a', run.scheduledAt.getTime() - T0, run.missed])
      await new Promise((r) => setTimeout(r, 3 * SEC))
    })
    b.every('5s', { id: 'job' }, (run) => { runs.push(['b', run.scheduledAt.getTime() - T0, run.missed]) })
    await a.start()
    // B joins while A is mid-handler (the stored slot is overdue at B's activation).
    await vi.advanceTimersByTimeAsync(7 * SEC)
    await b.start()
    await vi.advanceTimersByTimeAsync(5 * SEC)
    a.stop()
    await vi.advanceTimersByTimeAsync(40 * SEC)
    const bRuns = runs.filter(([w]) => w === 'b')
    expect(bRuns.length).toBeGreaterThan(0)
    expect(bRuns.every(([, , missed]) => !missed)).toBe(true)
    const lastA = Math.max(...runs.filter(([w]) => w === 'a').map(([, s]) => s))
    expect(bRuns[0][1]).toBe(lastA + 5 * SEC)
    b.stop()
  })
})

describe('durable scheduler: catch-up across replicas', () => {
  it('runs every missed slot exactly once, in order, even when another replica polls in between', async () => {
    useClock()
    const inner = new MemoryScheduleStore()
    await inner.register({ id: 'job', kind: 'interval', spec: String(10 * SEC), nextRunAt: T0 + 10 * SEC }, T0)
    vi.setSystemTime(T0 + 105 * SEC)
    const runs: Array<[string, number, boolean]> = []
    const make = (who: string) => {
      const s = new Scheduler({ store: slowStore(inner, 300) })
      s.every('10s', { id: 'job', missed: 'catch-up', maxCatchUp: 20 }, (run) => {
        runs.push([who, (run.scheduledAt.getTime() - T0) / SEC, run.missed])
      })
      return s
    }
    const a = make('A')
    const b = make('B')
    const sa = a.start()
    await vi.advanceTimersByTimeAsync(100)
    const sb = b.start()
    await vi.advanceTimersByTimeAsync(20 * SEC)
    await sa
    await sb
    const slots = runs.map(([, s]) => s)
    expect(slots.slice(0, 10)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(runs.slice(0, 10).every(([, , missed]) => missed)).toBe(true)
    expect(new Set(slots).size).toBe(slots.length)
    a.stop()
    b.stop()
  })
})

describe('durable scheduler: fencing tokens never go backwards', () => {
  it('keeps growing across cancel(), forget() and a new registration of the same id', async () => {
    useClock()
    const store = new MemoryScheduleStore()
    const s = new Scheduler({ store })
    await s.start()
    const tokens: number[] = []
    const t = s.every('1s', { id: 'f' }, (run) => { tokens.push(run.fencingToken) })
    await vi.advanceTimersByTimeAsync(3 * SEC)
    t.cancel()
    await vi.advanceTimersByTimeAsync(0)
    s.every('1s', { id: 'f' }, (run) => { tokens.push(run.fencingToken) })
    await vi.advanceTimersByTimeAsync(2 * SEC)
    expect(tokens).toEqual([1, 2, 3, 4, 5])
    await s.forget('f')
    s.every('1s', { id: 'f' }, (run) => { tokens.push(run.fencingToken) })
    await vi.advanceTimersByTimeAsync(1 * SEC)
    expect(tokens.at(-1)).toBe(6)
    s.stop()
  })
})

describe('durable scheduler: restarts after an interrupted occurrence', () => {
  async function crashedRunner(leaseMs: number) {
    const store = new MemoryScheduleStore()
    await store.register({ id: 'job', kind: 'interval', spec: String(MIN), nextRunAt: T0 }, T0)
    // The previous process claimed T0 and died mid-handler.
    await store.claimDue('job', 'dead', T0, leaseMs)
    return store
  }

  it("re-runs the interrupted slot once its lease expired, even with the default 'skip'", async () => {
    useClock(T0)
    const store = await crashedRunner(5 * SEC)
    vi.setSystemTime(T0 + 20 * SEC)
    const s = new Scheduler({ store })
    const runs: ScheduledRun[] = []
    s.every('1m', { id: 'job' }, (run) => { runs.push(run) })
    await s.start()
    await vi.advanceTimersByTimeAsync(1 * SEC)
    expect(runs).toHaveLength(1)
    expect(runs[0].scheduledAt.getTime()).toBe(T0)
    expect(runs[0].missed).toBe(false)
    expect((await store.get('job'))?.nextRunAt).toBe(T0 + MIN)
    s.stop()
  })

  it("applies 'catch-up' to the slots after an interrupted one, whatever the restart timing", async () => {
    useClock(T0)
    const store = await crashedRunner(3 * MIN + 50 * SEC)
    // Back at T0 + 3m30s, before the dead runner's lease (T0 + 3m50s) expires.
    vi.setSystemTime(T0 + 3 * MIN + 30 * SEC)
    const s = new Scheduler({ store })
    const runs: ScheduledRun[] = []
    s.every('1m', { id: 'job', missed: 'catch-up' }, (run) => { runs.push(run) })
    await s.start()
    await vi.advanceTimersByTimeAsync(40 * SEC)
    expect(runs.map((r) => (r.scheduledAt.getTime() - T0) / MIN)).toEqual([0, 1, 2, 3, 4])
    expect(runs.map((r) => r.missed)).toEqual([false, true, true, true, false])
    s.stop()
  })
})

describe('Bot: forgetting a stored schedule', () => {
  it('bot.forgetTask(id) deletes the namespaced row of an orphan', async () => {
    useClock()
    const schedules = new MemoryScheduleStore()
    const first = new Bot({ provider: new MockProvider(), botId: 'shop', scheduler: { store: schedules } })
    first.every('10s', { id: 'old-report' }, () => {})
    await first.start()
    await first.stop()
    expect(await schedules.list()).toHaveLength(1)

    const bot = new Bot({ provider: new MockProvider(), botId: 'shop', scheduler: { store: schedules } })
    await bot.start()
    await bot.forgetTask('old-report')
    expect(await schedules.list()).toHaveLength(0)
    await bot.stop()
  })
})
