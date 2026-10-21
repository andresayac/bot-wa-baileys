/**
 * migrateToClusterLayout against real servers (opt-in):
 *  - BOTWA_TEST_REDIS_URL: in-place migration of a real single-node keyspace;
 *  - plus BOTWA_TEST_REDIS_CLUSTER_URL: a single node copied straight into a Redis Cluster.
 * Data is written through the legacy APIs (store, coordinator, scheduler, durability) and
 * read back through the cluster-layout APIs.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from 'redis'
import type { StoredMessage } from '@botmesh/core'
import {
  RedisCoordinator, RedisDurability, RedisStore, inspectKeyspace, migrateToClusterLayout, type NativeRedisClient,
} from '../src/index.js'
import type { NativeRedisClusterClient } from '../src/client.js'
import { CLUSTER_URL, cleanupPrefix, connectCluster } from './clusterEnv.js'

const REDIS_URL = process.env.BOTWA_TEST_REDIS_URL
const msg = (chatId: string, id: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body: `b-${id}`, fromMe: false,
})

/** Seed a legacy keyspace through the real APIs; returns the leadership term it reached. */
async function seed(client: NativeRedisClient, prefix: string): Promise<number> {
  const store = new RedisStore({ client, prefix, sessionTtl: '1h' })
  await store.start()
  await store.upsertChat({ id: 'c1', name: 'Chat 1' })
  await store.upsertContact({ id: 'u1', name: 'Ann' })
  for (let i = 0; i < 30; i++) await store.saveMessage(msg('c1', `m${i}`, i))
  await store.setCheckpoint('chat:c1', { flowId: 'f', step: 1, state: { a: 1 }, updatedAt: 1 })
  await store.setUserData({ userId: 'u1', namespace: 'prefs', key: 'lang', value: 'es', updatedAt: 1, expiresAt: Date.now() + 600_000 })
  for (let i = 0; i < 2; i++) await store.releaseLock('job', (await store.acquireLockFenced('job', 60_000))!.token)
  await store.schedules().register({ id: 'daily', kind: 'cron', spec: '0 9 * * *', nextRunAt: 100 }, 0)
  await store.setCursor('provider', 'cur-1')
  const coord = new RedisCoordinator({ client, prefix, replicaId: 'old' })
  await coord.start()
  let term = 0
  for (let i = 0; i < 3; i++) {
    const lead = (await coord.tryLead('session'))!
    term = lead.fence
    await lead.release()
  }
  await coord.stop()
  const dur = new RedisDurability({ client, prefix })
  await dur.inbox.append({ id: 'e1', partitionKey: 'p', kind: 'message', payload: {}, receivedAt: 1 }, 1)
  return term
}

describe.skipIf(!REDIS_URL)('migrateToClusterLayout (real single node)', () => {
  let client: NativeRedisClient
  const prefix = `botwa-mig-it-${process.pid}-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = createClient({ url: REDIS_URL })
    await client.connect()
  })

  afterAll(async () => {
    for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
      const keys = Array.isArray(batch) ? batch : [batch]
      if (keys.length) await client.del(keys)
    }
    await client.quit()
  })

  it('migrates in place; the cluster layout reads everything; fences and terms keep growing', async () => {
    const term = await seed(client, prefix)
    const report = await migrateToClusterLayout({ source: client, prefix, deleteSource: true })
    expect(report.copied).toMatchObject({ chats: 1, contacts: 1, messages: 30, checkpoints: 1, userData: 1, locks: 1, schedules: 1, coordination: 1 })
    const info = await inspectKeyspace({ client, prefix })
    expect(info.marker).toBe('cluster:v1')
    expect(info.legacy).toEqual({ cursors: 1, durability: 2 })

    const s = new RedisStore({ client, prefix, layout: 'cluster' })
    await s.start()
    expect(await s.getChat('c1')).toEqual({ id: 'c1', name: 'Chat 1' })
    expect(await s.getMessagesByChat('c1', 100)).toHaveLength(30)
    expect(await s.listCheckpoints()).toHaveLength(1)
    expect((await s.listUserData('u1')).map((e) => e.value)).toEqual(['es'])
    expect(Number(await client.pTTL(`${prefix}:{ud:u1}:e:prefs:lang`))).toBeGreaterThan(590_000)
    expect((await s.acquireLockFenced('job'))!.fence).toBe(3)
    expect(await s.getCursor('provider')).toBe('cur-1')
    const coord = s.coordinator({ replicaId: 'new' })
    await coord.start()
    expect((await coord.tryLead('session'))!.fence).toBe(term + 1)
    await coord.stop()
    expect(await new RedisDurability({ client, prefix }).inbox.get('e1')).toMatchObject({ id: 'e1' })
    // A legacy-layout start over a migrated prefix would not see the data: guard by checking the marker.
    await expect(new RedisStore({ client, prefix: `${prefix}-other`, layout: 'cluster' }).start()).resolves.toBeUndefined()
  }, 60_000)
})

describe.skipIf(!REDIS_URL || !CLUSTER_URL)('migrateToClusterLayout (real single node → real cluster)', () => {
  let source: NativeRedisClient
  let target: NativeRedisClusterClient
  const prefix = `botwa-mig2-it-${process.pid}-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    source = createClient({ url: REDIS_URL })
    await source.connect()
    target = await connectCluster()
  })

  afterAll(async () => {
    for await (const batch of source.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
      const keys = Array.isArray(batch) ? batch : [batch]
      if (keys.length) await source.del(keys)
    }
    await cleanupPrefix(target, prefix)
    await source.quit()
    await target.quit()
  })

  it('copies a whole keyspace into the cluster; bots then run on it', async () => {
    const term = await seed(source, prefix)
    const report = await migrateToClusterLayout({ source, target, prefix })
    expect(report.copied).toMatchObject({ chats: 1, messages: 30, cursors: 1, durability: 1, coordination: 1 })
    const s = new RedisStore({ client: target, prefix })
    await s.start()
    expect(s.layout).toBe('cluster')
    expect((await s.listChats()).map((c) => c.id)).toEqual(['c1'])
    expect(await s.getMessagesByChat('c1', 100)).toHaveLength(30)
    expect((await s.acquireLockFenced('job'))!.fence).toBe(3)
    const coord = s.coordinator({ replicaId: 'new' })
    await coord.start()
    expect((await coord.tryLead('session'))!.fence).toBe(term + 1)
    await coord.stop()
    expect(await new RedisDurability({ client: target, prefix }).inbox.get('e1')).toMatchObject({ id: 'e1' })
    const info = await inspectKeyspace({ client: target, prefix })
    expect(info.legacy).toEqual({ cursors: 1, durability: 2 })
    expect(info.cluster.messages).toBe(31)
  }, 60_000)
})

describe.skipIf(!REDIS_URL)('migrateToClusterLayout rollback and marker (real single node)', () => {
  let client: NativeRedisClient
  const prefixes: string[] = []
  const fresh = (tag: string) => { const p = `botwa-migrb-it-${process.pid}-${randomUUID().slice(0, 8)}-${tag}`; prefixes.push(p); return p }

  beforeAll(async () => {
    client = createClient({ url: REDIS_URL })
    await client.connect()
  })

  afterAll(async () => {
    for (const prefix of prefixes) {
      for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
        const keys = Array.isArray(batch) ? batch : [batch]
        if (keys.length) await client.del(keys)
      }
    }
    await client.quit()
  })

  it('a rollback without deleteSource carries back newer state: tokens never go backwards, deletions stay deleted', async () => {
    const prefix = fresh('mirror')
    const legacy = new RedisStore({ client, prefix })
    await legacy.start()
    await legacy.upsertChat({ id: 'chatA' })
    await legacy.upsertChat({ id: 'chatB' })
    await legacy.schedules().register({ id: 'job', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
    expect((await legacy.schedules().claimDue('job', 'r', 1, 1))!.fencingToken).toBe(1)
    await migrateToClusterLayout({ source: client, prefix })
    const s = new RedisStore({ client, prefix, layout: 'cluster' })
    await s.start()
    for (let i = 1; i <= 5; i++) await s.schedules().claimDue('job', 'r', 1_000 * i, 1)
    await s.deleteChat('chatA')
    const report = await migrateToClusterLayout({ source: client, prefix, direction: 'cluster-to-legacy' })
    expect(report.pruned.chats).toBe(1)
    expect(report.layoutMarker).toBe('removed')
    expect((await legacy.schedules().get('job'))!.fencingToken).toBe(6)
    expect((await legacy.listChats()).map((c) => c.id)).toEqual(['chatB'])
    await expect(new RedisStore({ client, prefix, layout: 'cluster' }).start()).rejects.toThrow(/legacy-layout data/)
  }, 60_000)

  it('a migration limited by include leaves the marker unset; a legacy start on a marked prefix warns', async () => {
    const prefix = fresh('partial')
    const legacy = new RedisStore({ client, prefix })
    await legacy.start()
    await legacy.upsertChat({ id: 'chatA' })
    await legacy.schedules().register({ id: 'job', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
    const partial = await migrateToClusterLayout({ source: client, prefix, include: ['chats'] })
    expect(partial.layoutMarker).toBe('unchanged')
    await expect(new RedisStore({ client, prefix, layout: 'cluster' }).start()).rejects.toThrow(/legacy-layout data/)
    await migrateToClusterLayout({ source: client, prefix })
    const warned: unknown[] = []
    await new RedisStore({ client, prefix, logger: { warn: (...a: unknown[]) => warned.push(a) } }).start()
    expect(warned).toHaveLength(1)
  }, 60_000)
})

describe.skipIf(!REDIS_URL || !CLUSTER_URL)('migrateToClusterLayout rollback (real cluster → real single node)', () => {
  let target: NativeRedisClient
  let cluster: NativeRedisClusterClient
  const prefix = `botwa-migrb2-it-${process.pid}-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    target = createClient({ url: REDIS_URL })
    await target.connect()
    cluster = await connectCluster()
  })

  afterAll(async () => {
    for await (const batch of target.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
      const keys = Array.isArray(batch) ? batch : [batch]
      if (keys.length) await target.del(keys)
    }
    await cleanupPrefix(cluster, prefix)
    await target.quit()
    await cluster.quit()
  })

  it('rolls a keyspace living on a cluster back to a single-node legacy keyspace', async () => {
    const s = new RedisStore({ client: cluster, prefix })
    await s.start()
    await s.upsertChat({ id: 'c1', name: 'Chat 1' })
    await s.upsertChat({ id: 'gone' })
    await s.deleteChat('gone')
    for (let i = 0; i < 30; i++) await s.saveMessage(msg('c1', `m${i}`, i))
    await s.setUserData({ userId: 'u1', namespace: 'prefs', key: 'lang', value: 'es', updatedAt: 1 })
    for (let i = 0; i < 2; i++) await s.releaseLock('job', (await s.acquireLockFenced('job', 60_000))!.token)
    await s.schedules().register({ id: 'daily', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
    for (let i = 1; i <= 3; i++) await s.schedules().claimDue('daily', 'r', 1_000 * i, 1)
    await s.setCursor('provider', 'cur-1')
    const coord = s.coordinator({ replicaId: 'old' })
    await coord.start()
    const term = (await coord.tryLead('session'))!
    await term.release()
    await coord.stop()
    await new RedisDurability({ client: cluster, prefix }).inbox.append({ id: 'e1', partitionKey: 'p', kind: 'message', payload: {}, receivedAt: 1 }, 1)

    const report = await migrateToClusterLayout({ source: cluster, target, prefix, direction: 'cluster-to-legacy' })
    expect(report.copied).toMatchObject({ chats: 1, messages: 30, userData: 1, schedules: 1, cursors: 1, coordination: 1 })
    const legacy = new RedisStore({ client: target, prefix })
    await legacy.start()
    expect((await legacy.listChats()).map((c) => c.id)).toEqual(['c1'])
    expect(await legacy.getMessagesByChat('c1', 100)).toHaveLength(30)
    expect((await legacy.listUserData('u1')).map((e) => e.value)).toEqual(['es'])
    expect((await legacy.acquireLockFenced('job'))!.fence).toBe(3)
    expect((await legacy.schedules().get('daily'))!.fencingToken).toBe(3)
    expect(await legacy.getCursor('provider')).toBe('cur-1')
    const lc = new RedisCoordinator({ client: target, prefix, replicaId: 'new' })
    await lc.start()
    expect((await lc.tryLead('session'))!.fence).toBe(term.fence + 1)
    await lc.stop()
    expect(await new RedisDurability({ client: target, prefix }).inbox.get('e1')).toMatchObject({ id: 'e1' })
  }, 60_000)
})
