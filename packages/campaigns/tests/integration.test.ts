/**
 * KvCampaignStore against real backends: a SQLite file (always), and PostgreSQL / Redis /
 * Redis Cluster when their BOTWA_TEST_*_URL is set (see CONTRIBUTING.md). Runs the store
 * conformance suite plus a cross-connection check: two planners over the same backend
 * never exceed maxPerRecipient.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import * as redisClient from 'redis'
import * as sqlite from '@botmesh/sqlite-store'
import * as postgres from '@botmesh/postgres-store'
import * as redis from '@botmesh/redis-store'
import { CampaignPlanner, KvCampaignStore, makeDeliveryId } from '../src/index.js'
import { runCampaignStoreConformance } from '../../../test-utils/campaign-store-conformance.js'
import { realKvBackends, type KvSession } from '../../../test-utils/real-kv-backends.js'

for (const backend of realKvBackends({ sqlite, postgres, redis, pg, redisClient })) {
  describe.skipIf(!backend.enabled)(`KvCampaignStore — ${backend.name}`, () => {
    let session: KvSession
    beforeAll(async () => { session = await backend.open() })
    afterAll(async () => { await session.close() })

    runCampaignStoreConformance(backend.name, {
      async make({ clock }) {
        const { kv, teardown } = await session.fresh()
        return { store: new KvCampaignStore(kv, { clock }), teardown }
      },
      deliveryId: (tenantId, campaignId, recipientId) => makeDeliveryId(tenantId, campaignId, recipientId),
    })

    it('parallel plans from two processes over the same backend: one send slot', async () => {
      const { kv, teardown } = await session.fresh()
      try {
        const a = new CampaignPlanner(new KvCampaignStore(kv))
        const b = new CampaignPlanner(new KvCampaignStore(kv))
        const campaign = { id: 'sale', tenantId: 'acme' }
        const recipient = { id: 'r1', tenantId: 'acme', channel: 'wa', optedIn: true }
        const results = await Promise.all([
          ...Array.from({ length: 5 }, () => a.plan(campaign, [recipient])),
          ...Array.from({ length: 5 }, () => b.plan(campaign, [recipient])),
        ])
        const queued = results.flat().filter((delivery) => delivery.state === 'queued')
        expect(queued).toHaveLength(1)
        await a.markSent(queued[0]!.deliveryId!)
        expect(await b.sentCount('acme', 'sale', 'r1')).toBe(1)
      } finally {
        await teardown()
      }
    })
  })
}
