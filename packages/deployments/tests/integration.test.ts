/**
 * KvDeploymentStore against real backends: a SQLite file (always), and PostgreSQL /
 * Redis / Redis Cluster when BOTWA_TEST_POSTGRES_URL / BOTWA_TEST_REDIS_URL /
 * BOTWA_TEST_REDIS_CLUSTER_URL are set (see CONTRIBUTING.md). Runs the store
 * conformance suite plus a cross-connection contention check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as redisClient from 'redis'
import * as sqlite from '@botmesh/sqlite-store'
import * as postgres from '@botmesh/postgres-store'
import * as redis from '@botmesh/redis-store'
import { DeploymentRegistry, KvDeploymentStore } from '../src/index.js'
import { runDeploymentStoreConformance } from '../../../test-utils/deployment-store-conformance.js'
import { realKvBackends, type KvSession } from '../../../test-utils/real-kv-backends.js'

for (const backend of realKvBackends({ sqlite, postgres, redis, pg, redisClient })) {
  describe.skipIf(!backend.enabled)(`KvDeploymentStore — ${backend.name}`, () => {
    let session: KvSession
    beforeAll(async () => { session = await backend.open() })
    afterAll(async () => { await session.close() })

    runDeploymentStoreConformance(backend.name, {
      async make({ clock }) {
        const { kv, teardown } = await session.fresh()
        return { store: new KvDeploymentStore(kv, { clock }), teardown }
      },
    })

    it('parallel gated publishes of one version from two registries: exactly one reservation wins', async () => {
      const { kv, teardown } = await session.fresh()
      try {
        const a = new DeploymentRegistry(new KvDeploymentStore(kv))
        const b = new DeploymentRegistry(new KvDeploymentStore(kv))
        const gate = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20))
        const results = await Promise.all([
          ...Array.from({ length: 5 }, () => a.publish('acme', 'bot', '1.0.0', 'sha:a', { gate }).then(() => 'ok', (e: Error) => e.name)),
          ...Array.from({ length: 5 }, () => b.publish('acme', 'bot', '1.0.0', 'sha:b', { gate }).then(() => 'ok', (e: Error) => e.name)),
        ])
        expect(results.filter((r) => r === 'ok')).toHaveLength(1)
        expect(results.filter((r) => r === 'DeploymentExistsError')).toHaveLength(9)
        expect((await b.list('acme', 'bot')).map((d) => d.version)).toEqual(['1.0.0'])
        expect(await a.gateRuns('acme', 'bot', '1.0.0')).toHaveLength(1)
      } finally {
        await teardown()
      }
    })
  })
}
