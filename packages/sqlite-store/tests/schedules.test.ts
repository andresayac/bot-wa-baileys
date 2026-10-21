/** SQLiteScheduleStore against the shared ScheduleStore conformance suite, plus restart persistence. */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bot, type ScheduledRun } from '@botmesh/core'
import { MockProvider } from '@botmesh/core/testing'
import { SQLiteStore } from '../src/SQLiteStore.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'botwa-sqlite-sched-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}

runScheduleStoreConformance('SQLiteScheduleStore', {
  async make() {
    const { dir, cleanup } = tempDir()
    const store = new SQLiteStore({ file: join(dir, 'store.db') })
    await store.start()
    return {
      store: store.schedules(),
      teardown: async () => { await store.stop(); cleanup() },
    }
  },
})

describe('SQLiteScheduleStore', () => {
  it('shares one instance per store and survives reopening the database', async () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'bot.db')
      const first = new SQLiteStore({ file })
      expect(first.schedules()).toBe(first.schedules())
      await first.schedules().register({ id: 'daily', kind: 'cron', spec: '0 9 * * *', nextRunAt: 123 }, 1)
      const claim = await first.schedules().claimDue('daily', 'a', 200, 1000)
      expect(claim?.fencingToken).toBe(1)
      await first.stop()

      const second = new SQLiteStore({ file })
      expect(await second.schedules().get('daily')).toMatchObject({
        id: 'daily', nextRunAt: 123, fencingToken: 1, leaseOwner: 'a', leaseUntil: 1200,
      })
      await second.stop()
    } finally {
      cleanup()
    }
  })

  it('two connections on the same file never both win a claim', async () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'bot.db')
      const a = new SQLiteStore({ file })
      const b = new SQLiteStore({ file })
      await a.schedules().register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: 0 }, 0)
      const results = await Promise.all([
        a.schedules().claimDue('t', 'a', 10, 5000),
        b.schedules().claimDue('t', 'b', 10, 5000),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
      await a.stop()
      await b.stop()
    } finally {
      cleanup()
    }
  })
})

describe('Bot + SQLiteStore#schedules(): durable tasks across restarts', () => {
  afterEach(() => { vi.useRealTimers() })

  it('keeps the next run of a durable task across a bot restart and catches up missed slots', async () => {
    const { dir, cleanup } = tempDir()
    const T0 = new Date(2026, 0, 5, 8, 0).getTime()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    try {
      const file = join(dir, 'bot.db')
      const store1 = new SQLiteStore({ file })
      const bot1 = new Bot({ provider: new MockProvider(), store: store1, scheduler: { store: store1.schedules() } })
      const first: ScheduledRun[] = []
      bot1.every('10m', { id: 'sync', missed: 'catch-up' }, (run) => { first.push(run) })
      await bot1.start()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(first).toHaveLength(1)
      await bot1.stop()

      // Down for 25 minutes: the 08:20 and 08:30 slots are missed.
      vi.setSystemTime(T0 + 35 * 60_000)
      const store2 = new SQLiteStore({ file })
      const bot2 = new Bot({ provider: new MockProvider(), store: store2, scheduler: { store: store2.schedules() } })
      const second: ScheduledRun[] = []
      bot2.every('10m', { id: 'sync', missed: 'catch-up' }, (run) => { second.push(run) })
      await bot2.start()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(second.map((r) => [r.scheduledAt.getTime() - T0, r.missed])).toEqual([
        [20 * 60_000, true],
        [30 * 60_000, true],
      ])
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(second.map((r) => r.scheduledAt.getTime() - T0)).toEqual([20, 30, 40].map((m) => m * 60_000))
      await bot2.stop()
    } finally {
      cleanup()
    }
  })
})
