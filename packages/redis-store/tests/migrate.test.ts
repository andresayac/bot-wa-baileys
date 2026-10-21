/**
 * migrateToClusterLayout / inspectKeyspace (hermetic). Data is seeded through the real
 * legacy-layout APIs, migrated, then read back through the cluster-layout APIs.
 */
import { describe, expect, it } from 'vitest'
import { legacyMessageKey, type StoredMessage } from '@botmesh/core'
import {
  RedisDurability, RedisStore, inspectKeyspace, migrateToClusterLayout,
} from '../src/index.js'
import { ClusterFakeRedisClient, ScanningLayoutFakeRedisClient } from './fakeClusterRedis.js'

const msg = (chatId: string, id: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body: `b-${id}`, fromMe: false,
})

/** A legacy keyspace with one of everything. */
async function seedLegacy(client: ScanningLayoutFakeRedisClient, prefix = 'botwa') {
  const store = new RedisStore({ client, prefix, sessionTtl: '1h' })
  await store.start()
  await store.upsertChat({ id: 'c1', name: 'Chat 1' })
  await store.upsertChat({ id: 'item:x' })                 // a chat id that looks like an item key
  await store.upsertContact({ id: 'u1', name: 'Ann' })
  for (let i = 0; i < 5; i++) await store.saveMessage(msg('c1', `m${i}`, i))
  await store.saveMessage(msg('item:x', 'z', 1))
  // A row written before message keys were escaped, still owned by its chat.
  const old = msg('c1', 'a:b', 10)
  await client.set(`${prefix}:msg:item:${legacyMessageKey(old.ref)}`, JSON.stringify(old))
  await client.zAdd(`${prefix}:msg:c1`, { score: 10, value: legacyMessageKey(old.ref) })
  // An orphan item nothing references.
  await client.set(`${prefix}:msg:item:ghost:1`, JSON.stringify(msg('ghost', '1', 1)))
  await store.setCheckpoint('chat:c1', { flowId: 'f', step: 2, state: { a: 1 }, updatedAt: 5 })
  await store.setConversation('ai:c1', [{ role: 'user', content: 'hi' }])
  await store.setCursor('provider', 'cur-9')
  await store.setUserData({ userId: 'u1', namespace: 'prefs', key: 'lang', value: 'es', updatedAt: 1 })
  await store.setUserData({ userId: 'u1', namespace: 'tmp', key: 'otp', value: 123, updatedAt: 1, expiresAt: Date.now() + 600_000 })
  for (let i = 0; i < 3; i++) {
    const l = await store.acquireLockFenced('job', 60_000)
    await store.releaseLock('job', l!.token)
  }
  const sched = store.schedules()
  await sched.register({ id: 'daily', kind: 'cron', spec: '0 9 * * *', nextRunAt: 100 }, 0)
  await sched.register({ id: 'gone', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
  await sched.claimDue('gone', 'r', 1, 1000)
  await sched.claimDue('gone', 'r', 2000, 1000)
  await sched.delete('gone')                                  // deleted marker keeps token 2
  await store.leases().acquire('scheduler:leader', 'r', 60_000)
  // A leadership term counter (the fake keeps coordinator scripts in their own state, so
  // the counter is written directly; the real-server suite migrates a real one).
  await client.set(`${prefix}:co:lead:session:term`, '2')
  await client.set(`${prefix}:co:lead:x:term`, '7|r#1')       // a lease of a name ending in ':term', not a counter
  const dur = new RedisDurability({ client, prefix })
  await dur.inbox.append({ id: 'e1', partitionKey: 'p', kind: 'message', payload: {}, receivedAt: 1 }, 1)
  return store
}

async function clusterReader(client: ScanningLayoutFakeRedisClient | ClusterFakeRedisClient, prefix = 'botwa') {
  const store = new RedisStore({ client, prefix, layout: 'cluster', sessionTtl: '1h' })
  await store.start()
  return store
}

describe('migrateToClusterLayout (legacy → cluster, in place)', () => {
  it('copies every namespace; the cluster-layout store reads the same data', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await seedLegacy(client)
    const report = await migrateToClusterLayout({ source: client })
    expect(report.dryRun).toBe(false)
    expect(report.copied).toMatchObject({
      chats: 2, contacts: 1, messages: 7, checkpoints: 1, userData: 2, locks: 1, schedules: 2, coordination: 1,
      conversations: 0, cursors: 0, leases: 0, durability: 0,                // unchanged names, same keyspace
    })
    expect(report.orphans).toEqual(['botwa:msg:item:ghost:1'])

    const s = await clusterReader(client)
    expect((await s.listChats()).map((c) => c.id).sort()).toEqual(['c1', 'item:x'])
    expect(await s.getChat('c1')).toEqual({ id: 'c1', name: 'Chat 1' })
    expect(await s.listContacts()).toEqual([{ id: 'u1', name: 'Ann' }])
    expect((await s.getMessagesByChat('c1', 10)).map((m) => m.ref.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'a:b'])
    expect(await s.getMessage({ chatId: 'c1', id: 'a:b' })).toMatchObject({ body: 'b-a:b' })
    expect((await s.getMessagesByChat('item:x')).map((m) => m.ref.id)).toEqual(['z'])
    expect(await s.listCheckpoints()).toEqual([['chat:c1', { flowId: 'f', step: 2, state: { a: 1 }, updatedAt: 5 }]])
    expect(await s.getConversation('ai:c1')).toEqual([{ role: 'user', content: 'hi' }])
    expect(await s.getCursor('provider')).toBe('cur-9')
    expect((await s.listUserData('u1')).map((e) => `${e.namespace}/${e.key}`).sort()).toEqual(['prefs/lang', 'tmp/otp'])
    // Remaining TTLs are kept.
    expect(client.pttl('botwa:{ud:u1}:e:tmp:otp')).toBeGreaterThan(590_000)
    expect(client.pttl(`botwa:{cp:${(await import('../src/layout.js')).bucketOf('chat:c1')}}:r:chat%3Ac1`)).toBeGreaterThan(3_500_000)
    // Fences and terms never go backwards.
    expect((await s.acquireLockFenced('job'))!.fence).toBe(4)
    expect(await client.get('botwa:co:{ld:session}:term')).toBe('2')
    expect(await client.get('botwa:co:{ld:x}:term')).toBeNull()
    // A deleted schedule keeps its fencing token.
    const sched = s.schedules()
    expect((await sched.list()).map((r) => r.id)).toEqual(['daily'])
    expect((await sched.register({ id: 'gone', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)).fencingToken).toBe(2)
    expect(await s.leases().acquire('scheduler:leader', 'other', 1000)).toBeNull()   // same lease key, still held
    expect(await client.get('botwa:{meta}:layout')).toBe('cluster:v1')
  })

  it('dryRun writes nothing; a re-run is idempotent; deleteSource removes only migrated legacy keys of the prefix', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await seedLegacy(client)
    await new RedisStore({ client, prefix: 'other' }).upsertChat({ id: 'keep' })
    const before = client.keysMatching('*').sort()
    const dry = await migrateToClusterLayout({ source: client, dryRun: true })
    expect(dry.copied.messages).toBe(7)
    expect(client.keysMatching('*').sort()).toEqual(before)

    await migrateToClusterLayout({ source: client })
    const again = await migrateToClusterLayout({ source: client })
    expect(again.copied.chats).toBe(0)
    expect(again.skippedExisting.chats).toBe(2)
    expect(again.skippedExisting.messages).toBe(7)

    const done = await migrateToClusterLayout({ source: client, deleteSource: true })
    expect(done.deletedSource).toBeGreaterThan(10)
    const info = await inspectKeyspace({ client })
    // Left: unchanged names, the orphan item and the 'x:term' lease that is not a counter.
    expect(info.legacy).toEqual({ conversations: 1, cursors: 1, leases: 1, durability: 2, messages: 1, coordination: 1 })
    expect(info.marker).toBe('cluster:v1')
    expect(await new RedisStore({ client, prefix: 'other' }).getChat('keep')).toEqual({ id: 'keep' })
    const s = await clusterReader(client)
    expect((await s.getMessagesByChat('c1', 10))).toHaveLength(6)
  })

  it('resumes after a failure half-way', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await seedLegacy(client)
    let calls = 0
    const flaky = Object.create(client) as ScanningLayoutFakeRedisClient
    flaky.set = async (...args: Parameters<ScanningLayoutFakeRedisClient['set']>) => {
      if (++calls === 3) throw new Error('ECONNRESET')
      return client.set(...args)
    }
    await expect(migrateToClusterLayout({ source: client, target: flaky })).rejects.toThrow('ECONNRESET')
    const report = await migrateToClusterLayout({ source: client })
    expect(report.copied.messages + report.skippedExisting.messages).toBe(7)
    const s = await clusterReader(client)
    expect(await s.getMessagesByChat('c1', 10)).toHaveLength(6)
  })

  it('refuses while the fleet looks live', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await seedLegacy(client)
    await client.set('botwa:co:rep:r#1', '1')
    await expect(migrateToClusterLayout({ source: client })).rejects.toThrow(/looks live/)
    await migrateToClusterLayout({ source: client, allowLive: true, include: ['chats'] })
  })

  it('copies a single node straight into a cluster (unchanged names too)', async () => {
    const source = new ScanningLayoutFakeRedisClient()
    await seedLegacy(source)
    const target = new ClusterFakeRedisClient()
    const report = await migrateToClusterLayout({ source, target })
    expect(report.copied).toMatchObject({ conversations: 1, cursors: 1, leases: 1, durability: 1 })
    const s = await clusterReader(target)
    expect((await s.getMessagesByChat('c1', 10))).toHaveLength(6)
    expect(await s.getCursor('provider')).toBe('cur-9')
    const dur = new RedisDurability({ client: target })
    expect(await dur.inbox.get('e1')).toMatchObject({ id: 'e1' })
  })

  it('validates its options', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await expect(migrateToClusterLayout({ source: new ClusterFakeRedisClient() })).rejects.toThrow(/single-node/)
    await expect(migrateToClusterLayout({ source: client, prefix: 'a{b}' })).rejects.toThrow(/targetPrefix/)
    await expect(migrateToClusterLayout({ source: client, direction: 'cluster-to-legacy', target: new ClusterFakeRedisClient() })).rejects.toThrow(/legacy layout/)
    const ok = await migrateToClusterLayout({ source: client, prefix: 'a{b}', targetPrefix: 'ab' })
    expect(ok.copied.chats).toBe(0)
  })
})

describe('migrateToClusterLayout (cluster → legacy, rollback)', () => {
  it('round-trips the keyspace back to the legacy layout', async () => {
    const legacySrc = new ScanningLayoutFakeRedisClient()
    await seedLegacy(legacySrc)
    await migrateToClusterLayout({ source: legacySrc, deleteSource: true })
    // Writes made after the migration exist only in the cluster layout.
    const s = await clusterReader(legacySrc)
    await s.saveMessage(msg('c1', 'new', 50))
    const report = await migrateToClusterLayout({ source: legacySrc, direction: 'cluster-to-legacy', deleteSource: true })
    expect(report.copied.messages).toBe(8)
    const legacy = new RedisStore({ client: legacySrc, sessionTtl: '1h' })
    expect((await legacy.getMessagesByChat('c1', 10)).map((m) => m.ref.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'a:b', 'new'])
    expect((await legacy.listChats()).map((c) => c.id).sort()).toEqual(['c1', 'item:x'])
    expect((await legacy.listUserData('u1')).length).toBe(2)
    expect((await legacy.acquireLockFenced('job'))!.fence).toBe(4)
    expect(await legacySrc.get('botwa:{meta}:layout')).toBeNull()
    const info = await inspectKeyspace({ client: legacySrc })
    expect(info.cluster).toEqual({ conversations: 1, cursors: 1, leases: 1, durability: 2 })
  })
})

describe('migrateToClusterLayout: the rollback mirrors writes made after the forward pass', () => {
  it('without deleteSource, newer cluster-layout state replaces the stale legacy copy (and deletions stay deleted)', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    const legacyBefore = await seedLegacy(client)
    await migrateToClusterLayout({ source: client })
    // A schedule created in the legacy layout only (never migrated): its token must survive the rollback.
    const lsched = legacyBefore.schedules()
    await lsched.register({ id: 'legacy-only', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)
    await lsched.claimDue('legacy-only', 'r', 1, 1)
    await lsched.claimDue('legacy-only', 'r', 10, 1)
    // Writes in the cluster layout after the forward pass.
    const s = await clusterReader(client)
    const sched = s.schedules()
    for (let i = 1; i <= 5; i++) expect(await sched.claimDue('daily', 'r', 1_000 * i, 1)).not.toBeNull()
    expect((await sched.get('daily'))!.fencingToken).toBe(5)
    await s.upsertChat({ id: 'c1', name: 'Renamed' })
    await s.deleteChat('item:x')
    await s.deleteContact('u1')
    await s.clearCheckpoint('chat:c1')
    await s.deleteUserData('u1', 'prefs', 'lang')
    await s.saveMessage(msg('c1', 'new', 50))
    await s.deleteMessage({ chatId: 'c1', id: 'm0' })

    const report = await migrateToClusterLayout({ source: client, direction: 'cluster-to-legacy' })
    expect(report.pruned).toMatchObject({ chats: 1, contacts: 1, checkpoints: 1, userData: 1, schedules: 1 })
    expect(report.pruned.messages).toBe(5)                           // item:x log + item, m0 member + item, the orphan
    expect(report.layoutMarker).toBe('removed')

    const legacy = new RedisStore({ client, sessionTtl: '1h' })
    await legacy.start()
    expect((await legacy.schedules().get('daily'))!.fencingToken).toBe(5)
    expect(await legacy.schedules().get('legacy-only')).toBeNull()
    expect((await legacy.schedules().register({ id: 'legacy-only', kind: 'interval', spec: '1000', nextRunAt: 1 }, 0)).fencingToken).toBe(2)
    expect((await legacy.listChats()).map((c) => c.id)).toEqual(['c1'])
    expect(await legacy.getChat('c1')).toEqual({ id: 'c1', name: 'Renamed' })
    expect(await legacy.listContacts()).toEqual([])
    expect(await legacy.listCheckpoints()).toEqual([])
    expect((await legacy.listUserData('u1')).map((e) => `${e.namespace}/${e.key}`)).toEqual(['tmp/otp'])
    expect((await legacy.getMessagesByChat('c1', 10)).map((m) => m.ref.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'a:b', 'new'])
    expect(await legacy.getMessagesByChat('item:x')).toEqual([])
    expect(await legacy.getMessage({ chatId: 'c1', id: 'm0' })).toBeUndefined()
    // The marker is gone: a cluster-layout store now refuses the (restored) legacy data.
    expect(await client.get('botwa:{meta}:layout')).toBeNull()
    await expect(new RedisStore({ client, layout: 'cluster' }).start()).rejects.toThrow(/legacy-layout data/)
  })

  it('a dry-run rollback counts what it would prune and changes nothing', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await seedLegacy(client)
    await migrateToClusterLayout({ source: client })
    const s = await clusterReader(client)
    await s.deleteChat('item:x')
    const before = client.keysMatching('*').sort()
    const dry = await migrateToClusterLayout({ source: client, direction: 'cluster-to-legacy', dryRun: true })
    expect(dry.pruned.chats).toBe(1)
    expect(dry.layoutMarker).toBe('unchanged')
    expect(client.keysMatching('*').sort()).toEqual(before)
  })

  it('mirror: false keeps the old rollback (existing legacy keys win); mirror is rollback-only', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await seedLegacy(client)
    await migrateToClusterLayout({ source: client })
    const s = await clusterReader(client)
    await s.upsertChat({ id: 'c1', name: 'Renamed' })
    await s.deleteChat('item:x')
    const r = await migrateToClusterLayout({ source: client, direction: 'cluster-to-legacy', mirror: false })
    expect(r.pruned.chats).toBe(0)
    const legacy = new RedisStore({ client })
    expect(await legacy.getChat('c1')).toEqual({ id: 'c1', name: 'Chat 1' })
    expect(await legacy.getChat('item:x')).toEqual({ id: 'item:x' })
    await expect(migrateToClusterLayout({ source: client, mirror: true })).rejects.toThrow(/mirror/)
    await expect(migrateToClusterLayout({ source: client, direction: 'cluster-to-legacy', overwrite: false })).rejects.toThrow(/mirror/)
  })
})

describe('migrateToClusterLayout: schedule fencing tokens never go backwards', () => {
  it('a re-run replaces a target schedule only with a higher token; overwrite keeps the higher token', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    const legacy = await seedLegacy(client)
    await migrateToClusterLayout({ source: client })
    const s = await clusterReader(client)
    for (let i = 1; i <= 3; i++) await s.schedules().claimDue('daily', 'r', 1_000 * i, 1)
    // A stale legacy record (token 0) never lowers the cluster token, even with overwrite.
    const forced = await migrateToClusterLayout({ source: client, include: ['schedules'], overwrite: true })
    expect(forced.copied.schedules).toBeGreaterThan(0)
    expect((await s.schedules().get('daily'))!.fencingToken).toBe(3)
    // A newer legacy record (higher token) replaces the target without overwrite.
    for (let i = 1; i <= 6; i++) await legacy.schedules().claimDue('daily', 'r', 10_000 * i, 1)
    const again = await migrateToClusterLayout({ source: client, include: ['schedules'] })
    expect(again.copied.schedules).toBe(1)
    expect((await s.schedules().get('daily'))!.fencingToken).toBe(6)
  })
})

describe('migrateToClusterLayout: the layout marker marks a complete migration only', () => {
  it('a run limited by include leaves the marker unset (the start() guard stays armed)', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await seedLegacy(client)
    const partial = await migrateToClusterLayout({ source: client, include: ['chats'] })
    expect(partial.layoutMarker).toBe('unchanged')
    expect(await client.get('botwa:{meta}:layout')).toBeNull()
    await expect(new RedisStore({ client, layout: 'cluster' }).start()).rejects.toThrow(/legacy-layout data/)
    const full = await migrateToClusterLayout({ source: client })
    expect(full.layoutMarker).toBe('written')
    expect(await client.get('botwa:{meta}:layout')).toBe('cluster:v1')
  })
})

describe('migrateToClusterLayout: a Redis Cluster as the rollback source', () => {
  it('rolls a cluster back to a single-node legacy keyspace', async () => {
    const legacySrc = new ScanningLayoutFakeRedisClient()
    await seedLegacy(legacySrc)
    const cluster = new ClusterFakeRedisClient()
    await migrateToClusterLayout({ source: legacySrc, target: cluster })
    const s = await clusterReader(cluster)
    await s.saveMessage(msg('c1', 'new', 50))
    await s.deleteChat('item:x')
    for (let i = 1; i <= 4; i++) await s.schedules().claimDue('daily', 'r', 1_000 * i, 1)

    const target = new ScanningLayoutFakeRedisClient()
    const report = await migrateToClusterLayout({ source: cluster, target, direction: 'cluster-to-legacy' })
    expect(report.copied).toMatchObject({ chats: 1, contacts: 1, checkpoints: 1, userData: 2, schedules: 2, conversations: 1, cursors: 1, leases: 1 })
    const legacy = new RedisStore({ client: target, sessionTtl: '1h' })
    expect((await legacy.getMessagesByChat('c1', 10)).map((m) => m.ref.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'a:b', 'new'])
    expect((await legacy.listChats()).map((c) => c.id)).toEqual(['c1'])
    expect((await legacy.schedules().get('daily'))!.fencingToken).toBe(4)
    expect((await legacy.acquireLockFenced('job'))!.fence).toBe(4)
    expect(await legacy.getCursor('provider')).toBe('cur-9')
    expect(await new RedisDurability({ client: target }).inbox.get('e1')).toMatchObject({ id: 'e1' })
  })

  it('a cluster source holds no legacy layout: the forward direction still refuses it', async () => {
    await expect(migrateToClusterLayout({ source: new ClusterFakeRedisClient() })).rejects.toThrow(/single-node/)
  })

  it('the live-fleet guard also checks a separate target', async () => {
    const source = new ScanningLayoutFakeRedisClient()
    await seedLegacy(source)
    const target = new ClusterFakeRedisClient()
    await target.set('botwa:co:rep:r#1', '1')
    await expect(migrateToClusterLayout({ source, target })).rejects.toThrow(/looks live/)
    const quietCluster = new ClusterFakeRedisClient()
    const busy = new ScanningLayoutFakeRedisClient()
    await busy.zAdd('botwa:co:t:chat-1:tix', { score: 1, value: 'x' })
    await expect(migrateToClusterLayout({ source: quietCluster, target: busy, direction: 'cluster-to-legacy' })).rejects.toThrow(/looks live/)
  })
})

describe('RedisStore (legacy layout) on a prefix marked as migrated', () => {
  it('start() warns (warn, else error) and still starts; no marker, no warning', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await seedLegacy(client)
    const quiet: unknown[] = []
    await new RedisStore({ client, logger: { warn: (...a: unknown[]) => quiet.push(a), error: (...a: unknown[]) => quiet.push(a) } }).start()
    expect(quiet).toEqual([])
    await migrateToClusterLayout({ source: client })
    const warned: unknown[][] = []
    await new RedisStore({ client, logger: { warn: (...a: unknown[]) => warned.push(a) } }).start()
    expect(warned).toHaveLength(1)
    expect(String(warned[0]![1])).toMatch(/layout: 'cluster' on every replica/)
    const errored: unknown[][] = []
    await new RedisStore({ client, logger: { error: (...a: unknown[]) => errored.push(a) } }).start()
    expect(errored).toHaveLength(1)
  })

  it('a failing or not-ready client only skips the check', async () => {
    const client = new ScanningLayoutFakeRedisClient()
    await client.set('botwa:{meta}:layout', 'cluster:v1')
    const broken = Object.create(client) as ScanningLayoutFakeRedisClient
    broken.get = async () => { throw new Error('ECONNRESET') }
    const warned: unknown[] = []
    await new RedisStore({ client: broken, logger: { warn: (...a: unknown[]) => warned.push(a) } }).start()
    const notReady = Object.create(client) as ScanningLayoutFakeRedisClient
    Object.defineProperty(notReady, 'isReady', { value: false })
    let reads = 0
    notReady.get = async (k: string) => { reads++; return client.get(k) }
    await new RedisStore({ client: notReady, logger: { warn: (...a: unknown[]) => warned.push(a) } }).start()
    expect(reads).toBe(0)
    expect(warned).toEqual([])
  })
})
