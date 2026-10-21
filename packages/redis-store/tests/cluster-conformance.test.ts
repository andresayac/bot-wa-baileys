/**
 * The cluster key layout against every shared conformance suite (hermetic):
 *  (a) the cluster fake (CROSSSLOT rules, no KEYS/SCAN), layout picked automatically;
 *  (b) the single-node fake with `layout: 'cluster'` (the in-place migration setting).
 */
import { legacyMessageKey, type StoredMessage } from '@bot-wa/core'
import { RedisDurability, RedisDurableKv, RedisStore, type RedisLikeClient } from '../src/index.js'
import { storeKeys } from '../src/layout.js'
import { ClusterFakeRedisClient, ScanningLayoutFakeRedisClient } from './fakeClusterRedis.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'
import { runLeaseConformance } from '../../../test-utils/lease-conformance.js'
import { runDurabilityConformance, runDurableKvConformance } from '../../../test-utils/durability-conformance.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'
import { Bot, MemoryStore, flow } from '@bot-wa/core'
import { CrashableProvider, MockProvider, crashable } from '@bot-wa/core/testing'

/** A message row as an older version wrote it, after a migration into the cluster layout. */
function clusterLegacySeeder(client: RedisLikeClient, prefix = 'botwa') {
  const keys = storeKeys(prefix, 'cluster')
  return async (msg: StoredMessage): Promise<void> => {
    const member = legacyMessageKey(msg.ref)
    await client.set(keys.msgItem(msg.chatId, member), JSON.stringify(msg))
    await client.zAdd(keys.msgSet(msg.chatId), { score: msg.timestamp, value: member })
  }
}

const variants = [
  { label: 'cluster fake', make: () => new RedisStore({ client: new ClusterFakeRedisClient() }), client: () => new ClusterFakeRedisClient() },
  {
    label: 'single node, layout cluster',
    make: () => new RedisStore({ client: new ScanningLayoutFakeRedisClient(), layout: 'cluster' }),
    client: () => new ScanningLayoutFakeRedisClient(),
  },
] as const

for (const v of variants) {
  runStoreConformance(`RedisStore (${v.label})`, {
    checkpointCas: true,
    async make() {
      const client = v.client()
      const store = new RedisStore(v.label === 'cluster fake' ? { client } : { client, layout: 'cluster' })
      await store.start()
      return { store, teardown: () => store.stop(), seedLegacyMessage: clusterLegacySeeder(client) }
    },
  })

  runUserDataConformance(`RedisStore (${v.label})`, {
    async make() {
      const store = v.make()
      await store.start()
      return { store, teardown: () => store.stop() }
    },
  })

  runScheduleStoreConformance(`RedisScheduleStore (${v.label})`, {
    async make() {
      const store = v.make()
      await store.start()
      return { store: store.schedules(), teardown: () => store.stop() }
    },
  })

  runLeaseConformance(`RedisLeaseProvider (${v.label})`, {
    async make() {
      const store = v.make()
      await store.start()
      return { lease: store.leases(), teardown: () => store.stop() }
    },
  })
}

runDurableKvConformance('RedisDurableKv (cluster fake)', {
  async make() { return { kv: new RedisDurableKv({ client: new ClusterFakeRedisClient() }), teardown: async () => {} } },
})

const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps
runCrashRecoveryMatrix('RedisDurability (cluster fake)', deps, {
  async make() { return { backend: new RedisDurability({ client: new ClusterFakeRedisClient() }), teardown: async () => {} } },
})

runDurabilityConformance('RedisDurability (cluster fake)', {
  async make() {
    const backend = new RedisDurability({ client: new ClusterFakeRedisClient() })
    await backend.start()
    return { backend, teardown: () => backend.stop() }
  },
})
