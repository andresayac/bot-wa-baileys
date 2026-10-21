/**
 * KvInboxStore against real backends: a SQLite file (always), and PostgreSQL / Redis /
 * Redis Cluster when BOTWA_TEST_POSTGRES_URL / BOTWA_TEST_REDIS_URL /
 * BOTWA_TEST_REDIS_CLUSTER_URL are set (see CONTRIBUTING.md). Runs the store
 * conformance suite plus a cross-connection contention check: two stores over the same
 * backend can never settle one version twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as redisClient from 'redis'
import * as sqlite from '@botmesh/sqlite-store'
import * as postgres from '@botmesh/postgres-store'
import * as redis from '@botmesh/redis-store'
import { KvInboxStore } from '../src/index.js'
import { runInboxStoreConformance } from '../../../test-utils/inbox-store-conformance.js'
import { realKvBackends, type KvSession } from '../../../test-utils/real-kv-backends.js'

for (const backend of realKvBackends({ sqlite, postgres, redis, pg, redisClient })) {
  describe.skipIf(!backend.enabled)(`KvInboxStore — ${backend.name}`, () => {
    let session: KvSession
    beforeAll(async () => { session = await backend.open() })
    afterAll(async () => { await session.close() })

    runInboxStoreConformance(backend.name, {
      async make({ clock }) {
        const { kv, teardown } = await session.fresh()
        return { store: new KvInboxStore(kv, { clock }), teardown }
      },
    })

    it('parallel agent writes from two stores over the same backend: exactly one wins', async () => {
      const { kv, teardown } = await session.fresh()
      try {
        const now = 1_700_000_000_000
        const a = new KvInboxStore(kv, { clock: () => now })
        const b = new KvInboxStore(kv, { clock: () => now })
        const created = await a.upsert({ tenantId: 'acme', id: 'chat', status: 'open', handoff: false })
        const results = await Promise.all([
          ...Array.from({ length: 10 }, (_, i) => a.update('acme', 'chat', created.version, { assigneeId: `a-${i}` }).then(() => 'ok', (e: Error) => e.name)),
          ...Array.from({ length: 10 }, (_, i) => b.update('acme', 'chat', created.version, { assigneeId: `b-${i}` }).then(() => 'ok', (e: Error) => e.name)),
        ])
        expect(results.filter((r) => r === 'ok')).toHaveLength(1)
        expect(results.filter((r) => r === 'InboxConflictError')).toHaveLength(19)
        expect((await a.get('acme', 'chat'))?.version).toBe(2)
      } finally {
        await teardown()
      }
    })

    it('parallel message projections from two stores count every inbound message', async () => {
      const { kv, teardown } = await session.fresh()
      try {
        const a = new KvInboxStore(kv)
        const b = new KvInboxStore(kv)
        const message = { ref: { id: 'm', chatId: 'busy' }, chatId: 'busy', timestamp: 1, type: 'text' as const, direction: 'inbound' as const }
        await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).applyMessage(message)))
        expect(await a.get('local', 'busy')).toMatchObject({ unread: 20, version: 20 })
      } finally {
        await teardown()
      }
    })
  })
}
