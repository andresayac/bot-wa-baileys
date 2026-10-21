/**
 * MongoScheduleStore against an in-memory fake collection (hermetic). The same contract
 * runs against a real server in schedules.integration.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { Scheduler, type ScheduledRun } from '@botmesh/core'
import { MongoStore } from '../src/MongoStore.js'
import { MongoScheduleStore, toNum } from '../src/schedules.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'
import { FakeScheduleCollection } from './fakeScheduleCollection.js'

runScheduleStoreConformance('MongoScheduleStore (fake collection)', {
  async make() {
    return { store: new MongoScheduleStore({ collection: new FakeScheduleCollection() }), teardown: async () => {} }
  },
})

describe('MongoScheduleStore', () => {
  it('rejects something that is not a collection', () => {
    expect(() => new MongoScheduleStore({ collection: {} })).toThrow(TypeError)
    expect(() => new MongoScheduleStore(undefined as never)).toThrow(TypeError)
  })

  it('claims with one atomic findOneAndUpdate', async () => {
    const col = new FakeScheduleCollection()
    const store = new MongoScheduleStore({ collection: col })
    await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: 0 }, 0)
    col.commands.length = 0
    await store.claimDue('t', 'a', 0, 1000)
    expect(col.commands).toEqual(['findOneAndUpdate'])
  })

  it('soft-deletes, keeping the token in the tombstone', async () => {
    const col = new FakeScheduleCollection()
    const store = new MongoScheduleStore({ collection: col })
    await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: 0 }, 0)
    await store.claimDue('t', 'a', 0, 1000)
    await store.delete('t')
    expect(col.docs.get('t')).toMatchObject({ deleted: true, fencingToken: 1 })
    expect(col.docs.get('t')).not.toHaveProperty('leaseOwner')
    expect(await store.get('t')).toBeNull()
  })

  it('normalizes Long-like and bigint values to numbers', () => {
    expect(toNum({ toNumber: () => 2 ** 31 })).toBe(2 ** 31)
    expect(toNum(5n)).toBe(5)
    expect(toNum(7)).toBe(7)
  })
})

describe('MongoStore#schedules()', () => {
  it('uses `{collectionPrefix}schedules` in the store database, one instance', async () => {
    const cols = new Map<string, FakeScheduleCollection>()
    const dbs: string[] = []
    const client = {
      db: (name: string) => {
        dbs.push(name)
        return { collection: (n: string) => cols.get(n) ?? cols.set(n, new FakeScheduleCollection()).get(n)! }
      },
      connect: async () => {},
      close: async () => {},
    }
    const store = new MongoStore({ client: client as never, dbName: 'mybot', collectionPrefix: 'b2_' })
    const s = store.schedules()
    expect(store.schedules()).toBe(s)
    await s.register({ id: 'x', kind: 'once', spec: '5', nextRunAt: 5 }, 0)
    expect(cols.get('b2_schedules')?.docs.has('x')).toBe(true)
    expect(dbs.every((d) => d === 'mybot')).toBe(true)
  })

  it('works with the durable scheduler end to end', async () => {
    const store = new MongoScheduleStore({ collection: new FakeScheduleCollection() })
    let now = 1_000_000
    const scheduler = new Scheduler({ store, now: () => now, tickMs: 10 })
    const runs: ScheduledRun[] = []
    scheduler.every(50, { id: 'beat' }, (run) => { runs.push(run) })
    await scheduler.start()
    now += 60
    await new Promise((r) => setTimeout(r, 80))
    await scheduler.stop()
    expect(runs[0]).toMatchObject({ taskId: 'beat', fencingToken: 1 })
    expect((await store.get('beat'))?.lastStatus).toBe('ok')
  })
})
