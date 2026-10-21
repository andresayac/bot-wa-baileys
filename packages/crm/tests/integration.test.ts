/**
 * KvContactStore against real backends: a SQLite file (always), and PostgreSQL / Redis /
 * Redis Cluster when their BOTWA_TEST_*_URL is set (see CONTRIBUTING.md). Runs the store
 * conformance suite plus a cross-connection check: consent updates from two stores never
 * lose each other.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as redisClient from 'redis'
import * as sqlite from '@bot-wa/sqlite-store'
import * as postgres from '@bot-wa/postgres-store'
import * as redis from '@bot-wa/redis-store'
import { KvContactStore } from '../src/index.js'
import { runContactStoreConformance } from '../../../test-utils/contact-store-conformance.js'
import { realKvBackends, type KvSession } from '../../../test-utils/real-kv-backends.js'

for (const backend of realKvBackends({ sqlite, postgres, redis, pg, redisClient })) {
  describe.skipIf(!backend.enabled)(`KvContactStore — ${backend.name}`, () => {
    let session: KvSession
    beforeAll(async () => { session = await backend.open() })
    afterAll(async () => { await session.close() })

    runContactStoreConformance(backend.name, {
      async make({ clock }) {
        const { kv, teardown } = await session.fresh()
        return { store: new KvContactStore(kv, { clock }), teardown }
      },
    })

    it('concurrent consent updates from two stores over the same backend all land', async () => {
      const { kv, teardown } = await session.fresh()
      try {
        const a = new KvContactStore(kv)
        const b = new KvContactStore(kv)
        await a.upsert({ tenantId: 'acme', id: 'u', channels: {}, tags: ['vip'], attributes: {}, marketingConsent: true })
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).setConsent('acme', 'u', i % 3 === 0).then(() => 'ok', (e: Error) => e.name)),
        )
        expect(results.every((r) => r === 'ok')).toBe(true)
        expect(await b.get('acme', 'u')).toMatchObject({ tags: ['vip'] })
      } finally {
        await teardown()
      }
    })
  })
}
