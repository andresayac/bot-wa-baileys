/**
 * KvPluginStore against real backends: a SQLite file (always), and PostgreSQL / Redis /
 * Redis Cluster when their BOTWA_TEST_*_URL is set (see CONTRIBUTING.md). Runs the store
 * conformance suite plus a cross-connection check: two registries over the same backend
 * see each other's installs and never corrupt a concurrent enable/disable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as redisClient from 'redis'
import * as sqlite from '@bot-wa/sqlite-store'
import * as postgres from '@bot-wa/postgres-store'
import * as redis from '@bot-wa/redis-store'
import { KvPluginStore, PluginRegistry } from '../src/index.js'
import { runPluginStoreConformance } from '../../../test-utils/plugin-store-conformance.js'
import { realKvBackends, type KvSession } from '../../../test-utils/real-kv-backends.js'

const manifest = { id: 'crm-sync', version: '1.0.0', botwa: '^2.0.0', entry: 'dist/index.js', permissions: ['contacts:read'] as const }

for (const backend of realKvBackends({ sqlite, postgres, redis, pg, redisClient })) {
  describe.skipIf(!backend.enabled)(`KvPluginStore — ${backend.name}`, () => {
    let session: KvSession
    beforeAll(async () => { session = await backend.open() })
    afterAll(async () => { await session.close() })

    runPluginStoreConformance(backend.name, {
      async make() {
        const { kv, teardown } = await session.fresh()
        return { store: new KvPluginStore(kv), teardown }
      },
    })

    it('two registries over the same backend share installs and concurrent toggles', async () => {
      const { kv, teardown } = await session.fresh()
      try {
        const a = new PluginRegistry(new KvPluginStore(kv))
        const b = new PluginRegistry(new KvPluginStore(kv))
        await a.install('acme', manifest, '2.1.0')
        expect(await b.get('acme', 'crm-sync')).toMatchObject({ enabled: false, manifest: { id: 'crm-sync' } })
        await a.enable('acme', 'crm-sync', manifest.permissions)
        expect(await b.get('acme', 'crm-sync')).toMatchObject({ enabled: true })
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).get('acme', 'crm-sync')))
        expect(results.every((record) => record?.manifest.id === 'crm-sync')).toBe(true)
      } finally {
        await teardown()
      }
    })
  })
}
