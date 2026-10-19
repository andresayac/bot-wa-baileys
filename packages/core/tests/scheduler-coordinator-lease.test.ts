import { afterEach, describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import { MemoryCoordinationHub, MemoryCoordinator } from '../src/coordination/MemoryCoordinator.js'
import { MemoryScheduleStore, type ScheduleStore } from '../src/scheduler/ScheduleStore.js'
import { Scheduler } from '../src/scheduler/Scheduler.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'

const SEC = 1000

afterEach(() => {
  vi.useRealTimers()
})

/** A schedule store view that counts `claimDue` calls per replica. */
function counting(store: ScheduleStore, claims: Record<string, number>, name: string): ScheduleStore {
  return Object.assign(Object.create(store) as ScheduleStore, {
    claimDue: (...args: Parameters<ScheduleStore['claimDue']>) => { claims[name] = (claims[name] ?? 0) + 1; return store.claimDue(...args) },
  })
}

describe('scheduler leadership through the multi-replica Coordinator', () => {
  it('a Coordinator works as the scheduler lease: only its leader claims, the follower takes over on stop', async () => {
    vi.useFakeTimers()
    const hub = new MemoryCoordinationHub()
    const ca = new MemoryCoordinator({ hub, replicaId: 'a' })
    const cb = new MemoryCoordinator({ hub, replicaId: 'b' })
    await ca.start()
    await cb.start()
    const store = new MemoryScheduleStore()
    const claims: Record<string, number> = {}
    const fn = vi.fn()
    const a = new Scheduler({ store: counting(store, claims, 'a'), lease: ca, owner: 'a' })
    const b = new Scheduler({ store: counting(store, claims, 'b'), lease: cb, owner: 'b' })
    a.every('10s', { id: 'led' }, fn)
    b.every('10s', { id: 'led' }, fn)
    await a.start()
    await b.start()
    await vi.advanceTimersByTimeAsync(30 * SEC)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(claims.a).toBeGreaterThan(0)
    expect(claims.b ?? 0).toBe(0)

    // The leader stops: its leadership is released through the coordinator, B leads.
    await a.stop()
    await vi.advanceTimersByTimeAsync(20 * SEC)
    expect(fn).toHaveBeenCalledTimes(5)
    expect(claims.b).toBeGreaterThan(0)
    await b.stop()
    await ca.stop()
    await cb.stop()
  })

  it('a lost coordinator leadership (crash) is dropped and campaigned for again', async () => {
    vi.useFakeTimers()
    const hub = new MemoryCoordinationHub()
    const ca = new MemoryCoordinator({ hub, replicaId: 'a' })
    await ca.start()
    const tryLead = vi.spyOn(ca, 'tryLead')
    const fn = vi.fn()
    const s = new Scheduler({ store: new MemoryScheduleStore(), lease: ca, owner: 'a' })
    s.every('10s', { id: 'led' }, fn)
    await s.start()
    await vi.advanceTimersByTimeAsync(10 * SEC)
    expect(fn).toHaveBeenCalledTimes(1)
    const callsBefore = tryLead.mock.calls.length
    ca.crash()        // its leadership signal aborts
    await ca.start()  // back alive
    await vi.advanceTimersByTimeAsync(10 * SEC)
    expect(tryLead.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(fn).toHaveBeenCalledTimes(2)
    await s.stop()
    await ca.stop()
  })

  it('BotConfig.coordination is the default scheduler lease (one coordination backend)', async () => {
    vi.useFakeTimers()
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore()
    const schedules = new MemoryScheduleStore()
    const ran: string[] = []
    const make = (id: string) => {
      const coordinator = new MemoryCoordinator({ hub, replicaId: id })
      const tryLead = vi.spyOn(coordinator, 'tryLead')
      const bot = new Bot({
        provider: new MockProvider(),
        store,
        botId: 'shared',
        coordination: { coordinator, providerSession: 'shared' },
        scheduler: { store: schedules },
      })
      bot.every('10s', { id: 'report' }, () => { ran.push(id) })
      return { bot, tryLead }
    }
    const a = make('a')
    const b = make('b')
    await a.bot.start()
    await b.bot.start()
    await vi.advanceTimersByTimeAsync(30 * SEC)
    expect(ran).toEqual(['a', 'a', 'a'])
    expect(a.tryLead.mock.calls.some(([name]) => String(name).endsWith('scheduler:leader'))).toBe(true)
    await a.bot.stop()
    await vi.advanceTimersByTimeAsync(20 * SEC)
    expect(ran.slice(3)).toEqual(['b', 'b'])
    await b.bot.stop()
  })

  it('an explicit scheduler.lease wins over the coordinator', async () => {
    vi.useFakeTimers()
    const coordinator = new MemoryCoordinator()
    const tryLead = vi.spyOn(coordinator, 'tryLead')
    const lease = { acquire: vi.fn(async () => ({ token: 1 })), renew: vi.fn(async () => true), release: vi.fn(async () => {}) }
    const bot = new Bot({
      provider: new MockProvider(),
      coordination: { coordinator, providerSession: 'shared' },
      scheduler: { store: new MemoryScheduleStore(), lease },
    })
    bot.every('10s', { id: 'x' }, () => {})
    await bot.start()
    await vi.advanceTimersByTimeAsync(10 * SEC)
    expect(lease.acquire).toHaveBeenCalled()
    expect(tryLead.mock.calls.some(([name]) => String(name).endsWith('scheduler:leader'))).toBe(false)
    await bot.stop()
    expect(lease.release).toHaveBeenCalled()
  })
})
