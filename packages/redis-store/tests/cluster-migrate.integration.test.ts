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
import type { StoredMessage } from '@bot-wa/core'
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
