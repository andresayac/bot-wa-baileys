/** Every CampaignStore against the shared conformance suite: memory, Kv over MemoryKv, Kv over a FileDurability file. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDurability, MemoryKv } from '@bot-wa/core'
import { MemoryCampaignStore, makeDeliveryId } from '../src/memory.js'
import { KvCampaignStore } from '../src/kv.js'
import { runCampaignStoreConformance } from '../../../test-utils/campaign-store-conformance.js'

const deliveryId = (tenantId: string, campaignId: string, recipientId: string) => makeDeliveryId(tenantId, campaignId, recipientId)

runCampaignStoreConformance('MemoryCampaignStore', {
  async make({ clock }) { return { store: new MemoryCampaignStore({ clock }), teardown: async () => {} } },
  deliveryId,
})

runCampaignStoreConformance('KvCampaignStore (MemoryKv)', {
  async make({ clock }) { return { store: new KvCampaignStore(new MemoryKv(), { clock }), teardown: async () => {} } },
  deliveryId,
})

runCampaignStoreConformance('KvCampaignStore (FileDurability)', {
  async make({ clock }) {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-campaigns-'))
    const journal = await FileDurability.open(join(dir, 'kv.json'))
    return {
      store: new KvCampaignStore(journal.kv, { clock }),
      teardown: async () => {
        await journal.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      },
    }
  },
  deliveryId,
})
