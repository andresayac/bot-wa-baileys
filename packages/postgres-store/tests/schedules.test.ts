/**
 * PostgresScheduleStore against an in-memory fake pool (hermetic). The same contract runs
 * against a real server in schedules.integration.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { Scheduler, type ScheduledRun } from '@botmesh/core'
import { PostgresStore } from '../src/PostgresStore.js'
import { PostgresScheduleStore } from '../src/schedules.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'
import { FakeSchedulePool } from './fakeSchedulePool.js'
import { FakePool } from './fakePool.js'

runScheduleStoreConformance('PostgresScheduleStore (fake pool)', {
  async make() {
    const store = new PostgresScheduleStore({ pool: new FakeSchedulePool(), tablePrefix: 'bot_' })
    await store.start()
    return { store, teardown: async () => {} }
  },
})

describe('PostgresScheduleStore', () => {
  it('uses `{prefix}schedules` and rejects an unsafe prefix', () => {
    const pool = new FakeSchedulePool()
    expect(new PostgresScheduleStore({ pool }).table).toBe('schedules')
    expect(new PostgresScheduleStore({ pool, tablePrefix: 'bot_' }).table).toBe('bot_schedules')
    expect(() => new PostgresScheduleStore({ pool, tablePrefix: 'x; DROP TABLE y' })).toThrow(/invalid tablePrefix/)
    expect(() => new PostgresScheduleStore({ pool: {} as never })).toThrow(TypeError)
  })

  it('start() is idempotent and retries a lost catalog race', async () => {
    const pool = new FakeSchedulePool()
    const store = new PostgresScheduleStore({ pool })
    pool.failCreate = ['42P07', '23505']
    await store.start()
    await store.start()
    expect(pool.tables.has('schedules')).toBe(true)
    pool.failCreate = ['42501'] // insufficient privilege: not a race, surfaced
    await expect(store.start()).rejects.toMatchObject({ code: '42501' })
  })

  it('soft-deletes: the tombstone is invisible but keeps the fencing token', async () => {
    const pool = new FakeSchedulePool()
    const store = new PostgresScheduleStore({ pool })
    await store.start()
    await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: 0 }, 0)
    await store.claimDue('t', 'a', 0, 1000)
    await store.delete('t')
    expect(pool.tables.get('schedules')!.get('t')).toMatchObject({ deleted: true, fencing_token: 1, lease_owner: null })
    expect(await store.list()).toEqual([])
  })

  it('returns tokens past 2^31 as numbers', async () => {
    const pool = new FakeSchedulePool()
    const store = new PostgresScheduleStore({ pool })
    await store.start()
    pool.seed('schedules', { id: 'big', fencing_token: 2 ** 31 - 1 })
    const c = await store.claimDue('big', 'a', 1, 1000)
    expect(c?.fencingToken).toBe(2 ** 31)
    expect(typeof (await store.get('big'))?.fencingToken).toBe('number')
  })
})

describe('PostgresStore#schedules()', () => {
  it('returns one instance on the store pool and prefix, failing clearly before start()', async () => {
    const own = new PostgresStore({ tablePrefix: 'b1_' }) // would create its pool in start()
    const s = own.schedules()
    expect(own.schedules()).toBe(s)
    expect(s.table).toBe('b1_schedules')
    await expect(s.get('x')).rejects.toThrow(/not started/)
    await expect(s.start()).rejects.toThrow(/not started/)
  })

  it('shares the injected pool', async () => {
    const pool = new FakeSchedulePool()
    const store = new PostgresStore({ pool: pool as never })
    const s = store.schedules()
    await s.start()
    await s.register({ id: 'x', kind: 'once', spec: '5', nextRunAt: 5 }, 0)
    expect(pool.tables.get('schedules')?.has('x')).toBe(true)
    expect(new PostgresStore({ pool: new FakePool() as never }).schedules().table).toBe('schedules')
  })

  it('works with the durable scheduler end to end', async () => {
    const pool = new FakeSchedulePool()
    const store = new PostgresScheduleStore({ pool })
    let now = 1_000_000
    const scheduler = new Scheduler({ store, now: () => now, tickMs: 10 })
    const runs: ScheduledRun[] = []
    scheduler.every(50, { id: 'beat' }, (run) => { runs.push(run) })
    await scheduler.start()
    expect(await store.get('beat')).toMatchObject({ nextRunAt: now + 50, fencingToken: 0 })
    now += 60
    await new Promise((r) => setTimeout(r, 80))
    await scheduler.stop()
    expect(runs.length).toBeGreaterThanOrEqual(1)
    expect(runs[0]).toMatchObject({ taskId: 'beat', fencingToken: 1 })
    expect((await store.get('beat'))?.lastStatus).toBe('ok')
  })
})
