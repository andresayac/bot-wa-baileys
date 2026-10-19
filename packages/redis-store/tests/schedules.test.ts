/** RedisScheduleStore / RedisLeaseProvider against the shared conformance suites (in-memory fake client). */
import { describe, expect, it } from 'vitest'
import { RedisStore } from '../src/RedisStore.js'
import { RedisLeaseProvider, RedisScheduleStore } from '../src/index.js'
import { FakeRedisClient, ScanningFakeRedisClient } from './fakeRedis.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'
import { runLeaseConformance } from '../../../test-utils/lease-conformance.js'

runScheduleStoreConformance('RedisScheduleStore', {
  async make() {
    const store = new RedisStore({ client: new FakeRedisClient() })
    await store.start()
    return { store: store.schedules(), teardown: () => store.stop() }
  },
})

runScheduleStoreConformance('RedisScheduleStore (SCAN client)', {
  async make() {
    return { store: new RedisScheduleStore({ client: new ScanningFakeRedisClient(), prefix: 'p[1]' }), teardown: async () => {} }
  },
})

runLeaseConformance('RedisLeaseProvider', {
  async make() {
    const store = new RedisStore({ client: new FakeRedisClient() })
    await store.start()
    return { lease: store.leases(), teardown: () => store.stop() }
  },
})

describe('RedisStore#schedules() / #leases()', () => {
  it('share the store client and prefix, one instance each', async () => {
    const client = new FakeRedisClient()
    const store = new RedisStore({ client, prefix: 'shop' })
    expect(store.schedules()).toBe(store.schedules())
    expect(store.leases()).toBe(store.leases())
    await store.schedules().register({ id: 'daily', kind: 'cron', spec: '0 9 * * *', nextRunAt: 1 }, 0)
    await store.leases().acquire('scheduler:leader', 'a', 1000)
    expect((await client.keys('shop:*')).sort()).toEqual(['shop:lease:scheduler:leader', 'shop:sched:daily'])
  })

  it('lists only its own prefix', async () => {
    const client = new FakeRedisClient()
    const a = new RedisScheduleStore({ client, prefix: 'a' })
    const ab = new RedisScheduleStore({ client, prefix: 'a:b' })
    await a.register({ id: 'x', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
    await ab.register({ id: 'y', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
    expect((await ab.list()).map((r) => r.id)).toEqual(['y'])
  })

  it('a lease token keeps growing across release and expiry', async () => {
    let now = 1000
    const lease = new RedisLeaseProvider({ client: new FakeRedisClient(), now: () => now })
    const a = await lease.acquire('k', 'a', 100)
    await lease.release('k', 'a', a!.token)
    const b = await lease.acquire('k', 'b', 100)
    now += 200
    const c = await lease.acquire('k', 'c', 100)
    expect([a!.token, b!.token, c!.token]).toEqual([1, 2, 3])
  })
})
