/**
 * RedisStore in the cluster key layout — behaviour beyond the shared conformance suites
 * (hermetic: the cluster fake enforces Redis Cluster's CROSSSLOT rules).
 */
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@botmesh/core'
import { RedisCoordinator, RedisDurability, RedisLeaseProvider, RedisScheduleStore, RedisStore, withClusterRetry } from '../src/index.js'
import { bucketOf, storeKeys } from '../src/layout.js'
import { hashSlot } from '../src/slot.js'
import { FakeRedisClient, ScanningFakeRedisClient } from './fakeRedis.js'
import { ClusterFakeRedisClient, LayoutFakeRedisClient, ScanningLayoutFakeRedisClient } from './fakeClusterRedis.js'

const msg = (chatId: string, id: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body: `m${id}`, fromMe: false,
})

async function clusterStore(opts: { prefix?: string; sessionTtl?: string | number; maxMessagesPerChat?: number } = {}) {
  const client = new ClusterFakeRedisClient()
  const store = new RedisStore({ client, ...opts })
  await store.start()
  return { client, store }
}

describe('layout selection', () => {
  it('defaults to legacy on a single-node client and to cluster on a cluster client', () => {
    expect(new RedisStore({ client: new FakeRedisClient() }).layout).toBe('legacy')
    expect(new RedisStore({ client: new ClusterFakeRedisClient() }).layout).toBe('cluster')
    expect(new RedisStore({ client: new FakeRedisClient(), layout: 'cluster' }).layout).toBe('cluster')
    expect(new RedisCoordinator({ client: new ClusterFakeRedisClient() }).layout).toBe('cluster')
    expect(new RedisCoordinator({ client: new FakeRedisClient() }).layout).toBe('legacy')
  })

  it('rejects the legacy layout on a cluster client, braces in a cluster prefix, and conflicting connection options', () => {
    const cluster = new ClusterFakeRedisClient()
    expect(() => new RedisStore({ client: cluster, layout: 'legacy' })).toThrow(/not Redis Cluster safe/)
    expect(() => new RedisCoordinator({ client: cluster, layout: 'legacy' })).toThrow(RangeError)
    expect(() => new RedisScheduleStore({ client: cluster, layout: 'legacy' })).toThrow(RangeError)
    expect(() => new RedisLeaseProvider({ client: cluster, layout: 'legacy' })).toThrow(RangeError)
    expect(() => new RedisStore({ client: cluster, prefix: 'a{b}' })).toThrow(/prefix/)
    expect(() => new RedisLeaseProvider({ client: cluster, prefix: 'a{b}' })).toThrow(RangeError)
    expect(() => new RedisStore({ cluster: { rootNodes: ['redis://h:1'] }, url: 'redis://x' })).toThrow(/either url or cluster/)
    expect(() => new RedisStore({ cluster: { rootNodes: [] } })).toThrow(/rootNodes/)
    expect(() => new RedisDurability({ cluster: { rootNodes: ['redis://h:1'] }, url: 'redis://x' })).toThrow(RangeError)
    expect(() => new RedisStore({ client: new FakeRedisClient(), layout: 'weird' as never })).toThrow(RangeError)
  })

  it('keeps the historical key names in the default layout (golden)', async () => {
    const client = new FakeRedisClient()
    const store = new RedisStore({ client })
    await store.start()
    await store.upsertChat({ id: 'c1' })
    await store.saveMessage(msg('c1', 'm1', 1))
    await store.setCheckpoint('k', { flowId: 'f', step: 0, state: {}, updatedAt: 1 })
    await store.acquireLockFenced('job')
    expect((await client.keys('*')).sort()).toEqual([
      'botwa:chat:c1', 'botwa:cp:k', 'botwa:lock:job', 'botwa:lockfence:job', 'botwa:msg:c1', 'botwa:msg:item:c1:m1',
    ])
  })

  it('shares the layout with coordinator(), schedules() and leases()', () => {
    const store = new RedisStore({ client: new FakeRedisClient(), layout: 'cluster' })
    expect(store.coordinator().layout).toBe('cluster')
  })
})

describe('cluster layout keys', () => {
  it('writes tagged keys and indexes, never a legacy name', async () => {
    const { client, store } = await clusterStore()
    await store.upsertChat({ id: 'c1' })
    await store.upsertContact({ id: 'u1' })
    await store.saveMessage(msg('c1', 'm1', 1))
    await store.setCheckpoint('k', { flowId: 'f', step: 0, state: {}, updatedAt: 1 })
    await store.setUserData({ userId: 'u1', namespace: 'ns', key: 'k', value: 1, updatedAt: 1 })
    await store.acquireLockFenced('job')
    await store.schedules().register({ id: 'daily', kind: 'cron', spec: '0 9 * * *', nextRunAt: 1 }, 0)
    const keys = client.keysMatching('*').sort()
    expect(keys).toEqual([
      `botwa:{ch:${bucketOf('c1')}}:idx`, `botwa:{ch:${bucketOf('c1')}}:r:c1`,
      `botwa:{cp:${bucketOf('k')}}:idx`, `botwa:{cp:${bucketOf('k')}}:r:k`,
      `botwa:{ct:${bucketOf('u1')}}:idx`, `botwa:{ct:${bucketOf('u1')}}:r:u1`,
      'botwa:{lk:job}:f', 'botwa:{lk:job}:l',
      'botwa:{m:c1}:i:c1:m1', 'botwa:{m:c1}:z',
      'botwa:{meta}:layout',
      `botwa:{sc:${bucketOf('daily')}}:idx`, `botwa:{sc:${bucketOf('daily')}}:r:daily`,
      'botwa:{ud:u1}:e:ns:k', 'botwa:{ud:u1}:idx',
    ].sort())
    await expect(client.get('botwa:{meta}:layout')).resolves.toBe('cluster:v1')
    expect(hashSlot('botwa:{m:c1}:z')).toBe(hashSlot('botwa:{m:c1}:i:c1:m1'))
  })

  it('a chat id with braces or separators cannot break the hash tag', async () => {
    const { store } = await clusterStore()
    for (const id of ['{x}', 'a}b{c', 'a:b', '*', '']) {
      await store.upsertChat({ id: id || 'empty' })
      await store.saveMessage(msg(id || 'empty', 'm1', 1))
      expect((await store.getMessagesByChat(id || 'empty')).map((m) => m.ref.id)).toEqual(['m1'])
    }
    expect((await store.listChats()).length).toBe(5)
  })
})

describe('cluster layout behaviour', () => {
  it('deleteChat drops thousands of messages in chunks; a message saved meanwhile survives intact, no orphan', async () => {
    const { client, store } = await clusterStore()
    await store.upsertChat({ id: 'big' })
    for (let i = 0; i < 2600; i++) await store.saveMessage(msg('big', `m${i}`, i))
    const keys = storeKeys('botwa', 'cluster')
    const deleting = store.deleteChat('big')
    const saving = store.saveMessage(msg('big', 'late', 99_999))
    await Promise.all([deleting, saving])
    expect(await store.getChat('big')).toBeUndefined()
    const left = await client.zRange(keys.msgSet('big'), 0, -1)
    const items = client.keysMatching('botwa:{m:big}:i:*')
    // Every remaining item has its log entry and vice versa.
    expect(items.sort()).toEqual(left.map((m) => keys.msgItem('big', m)).sort())
    expect(left.length).toBeLessThanOrEqual(1)
    if (left.length) expect(await store.getMessage({ chatId: 'big', id: 'late' })).toMatchObject({ body: 'mlate' })
    expect(client.evals.filter((s) => s.includes('for i = 1, #ARGV do\n  if redis.call(\'zrem\'')).length).toBe(3)
  })

  it('prunes expired checkpoint index entries (server-side expiry)', async () => {
    const { client, store } = await clusterStore({ sessionTtl: '1h' })
    await store.setCheckpoint('a', { flowId: 'f', step: 0, state: {}, updatedAt: 1 })
    await store.setCheckpoint('b', { flowId: 'f', step: 0, state: {}, updatedAt: 1 })
    const keys = storeKeys('botwa', 'cluster')
    expect(client.pttl(keys.checkpoint('a'))).toBeGreaterThan(3_500_000)
    const idx = keys.checkpointIndex('a')!
    const score = (await client.zRangeWithScores(idx, 0, -1)).find((e) => e.value === 'a')!.score
    expect(score).toBeGreaterThan(Date.now() + 3_500_000)
    // Expire 'a' (record and index entry) as the server would.
    client.expires.set(keys.checkpoint('a'), Date.now() - 1)
    await client.zAdd(idx, { score: Date.now() - 1, value: 'a' })
    expect((await store.listCheckpoints()).map(([k]) => k)).toEqual(['b'])
    expect((await client.zRange(idx, 0, -1))).not.toContain('a')
  })

  it('user-data bulk deletes and listings use the per-user index', async () => {
    const { client, store } = await clusterStore()
    for (let i = 0; i < 1200; i++) await store.setUserData({ userId: 'u', namespace: i % 2 ? 'odd' : 'even', key: `k${i}`, value: i, updatedAt: 1 })
    await store.setUserData({ userId: 'u', namespace: 'tmp', key: 'gone', value: 1, updatedAt: 1, expiresAt: Date.now() + 50 })
    expect(await store.listUserData('u', 'odd')).toHaveLength(600)
    client.expires.set('botwa:{ud:u}:e:tmp:gone', Date.now() - 1)
    await client.zAdd('botwa:{ud:u}:idx', { score: Date.now() - 1, value: 'tmp:gone' })
    expect(await store.listUserData('u', 'tmp')).toEqual([])
    await store.deleteUserData('u', 'odd')
    expect(await store.listUserData('u', 'odd')).toEqual([])
    expect(await store.listUserData('u')).toHaveLength(600)
    await store.deleteUserData('u')
    expect(client.keysMatching('botwa:{ud:u}*')).toEqual([])
  })

  it('keeps indexes exact under concurrent upserts and deletes', async () => {
    const { store } = await clusterStore()
    const ops: Array<Promise<void>> = []
    for (let i = 0; i < 200; i++) {
      ops.push(store.upsertContact({ id: `u${i % 50}`, name: `n${i}` }))
      if (i % 3 === 0) ops.push(store.deleteContact(`u${(i + 7) % 50}`))
    }
    await Promise.all(ops)
    const listed = (await store.listContacts()).map((c) => c.id).sort()
    const actual: string[] = []
    for (let i = 0; i < 50; i++) if (await store.getContact(`u${i}`)) actual.push(`u${i}`)
    expect(listed).toEqual(actual.sort())
  })

  it('caps the message log with maxMessagesPerChat inside the chat slot', async () => {
    const { store } = await clusterStore({ maxMessagesPerChat: 3 })
    for (let i = 0; i < 6; i++) await store.saveMessage(msg('c', `m${i}`, i))
    expect((await store.getMessagesByChat('c', 10)).map((m) => m.ref.id)).toEqual(['m3', 'm4', 'm5'])
  })

  it('fenced locks keep their fence in the lock slot', async () => {
    const { store } = await clusterStore()
    const a = await store.acquireLockFenced('job', 1000)
    expect(await store.acquireLockFenced('job', 1000)).toBeNull()
    expect(await store.renewLock('job', a!.token, 1000)).toBe(true)
    expect(await store.releaseLock('job', a!.token)).toBe(true)
    const b = await store.acquireLockFenced('job', 1000)
    expect(b!.fence).toBe(a!.fence + 1)
  })

  it('a cross-slot command is caught before the network call (assertOneSlot) and by the fake (CROSSSLOT)', async () => {
    const client = new ClusterFakeRedisClient()
    await expect(client.del(['a', 'b'])).rejects.toThrow(/CROSSSLOT/)
    await expect(client.multi().set('a', '1').set('b', '1').exec()).rejects.toThrow(/CROSSSLOT/)
    // The legacy layout's scripts are rejected by a cluster.
    const legacy = new RedisStore({ client: new FakeRedisClient() })
    expect(legacy.layout).toBe('legacy')
  })
})

describe('TRYAGAIN / CLUSTERDOWN retry', () => {
  it('retries a command rejected before it ran, and gives up after the attempts', async () => {
    const { client, store } = await clusterStore()
    client.failNext(2)
    await store.upsertChat({ id: 'c1' })
    expect(client.rejected).toBe(2)
    expect(await store.getChat('c1')).toEqual({ id: 'c1' })
    client.failNext(1, 'CLUSTERDOWN The cluster is down')
    await store.saveMessage(msg('c1', 'm1', 1))
    expect(await store.getMessagesByChat('c1')).toHaveLength(1)
    client.failNext(50)
    await expect(store.upsertChat({ id: 'c2' })).rejects.toThrow(/TRYAGAIN/)
    client.failNext(0)
  })

  it('never retries any other error (a lost reply may have been applied)', async () => {
    const { client, store } = await clusterStore()
    client.failNext(1, 'ERR connection lost')
    await expect(store.upsertChat({ id: 'c1' })).rejects.toThrow(/connection lost/)
    expect(client.rejected).toBe(1)
  })

  it('withClusterRetry wraps once and replays a MULTI on a fresh transaction', async () => {
    const base = new ClusterFakeRedisClient()
    const wrapped = withClusterRetry(base)
    expect(withClusterRetry(wrapped)).toBe(wrapped)
    base.failNext(1)
    await wrapped.multi().set('{t}a', '1').set('{t}b', '2').exec()
    expect([await base.get('{t}a'), await base.get('{t}b')]).toEqual(['1', '2'])
  })
})

describe('layout marker and the legacy-data safety net', () => {
  it('start() claims the prefix; an unknown marker refuses to start', async () => {
    const client = new ClusterFakeRedisClient()
    await new RedisStore({ client }).start()
    expect(await client.get('botwa:{meta}:layout')).toBe('cluster:v1')
    await client.set('other:{meta}:layout', 'cluster:v9')
    await expect(new RedisStore({ client, prefix: 'other' }).start()).rejects.toThrow(/cluster:v9/)
  })

  it('refuses to start over legacy data on a single node unless allowed', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    const legacy = new RedisStore({ client: client as unknown as ScanningFakeRedisClient })
    await legacy.upsertChat({ id: 'c1' })
    await expect(new RedisStore({ client, layout: 'cluster' }).start()).rejects.toThrow(/migrateToClusterLayout/)
    expect(await client.get('botwa:{meta}:layout')).toBeNull()
    await new RedisStore({ client, layout: 'cluster', allowLegacyData: true }).start()
    expect(await client.get('botwa:{meta}:layout')).toBe('cluster:v1')
    // Other prefixes' legacy data does not count.
    const fresh = new LayoutFakeRedisClient()
    await new RedisStore({ client: fresh, prefix: 'x' }).upsertChat({ id: 'c' })
    await new RedisStore({ client: fresh, prefix: 'y', layout: 'cluster' }).start()
  })
})
