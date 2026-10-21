/** Every DeploymentStore against the shared conformance suite: memory, Kv over MemoryKv, Kv over a FileDurability file. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDurability, MemoryKv } from '@botmesh/core'
import { KvDeploymentStore, MemoryDeploymentStore } from '../src/index.js'
import { runDeploymentStoreConformance } from '../../../test-utils/deployment-store-conformance.js'

runDeploymentStoreConformance('MemoryDeploymentStore', {
  async make({ clock }) { return { store: new MemoryDeploymentStore({ clock }), teardown: async () => {} } },
})

runDeploymentStoreConformance('KvDeploymentStore (MemoryKv)', {
  async make({ clock }) { return { store: new KvDeploymentStore(new MemoryKv(), { clock }), teardown: async () => {} } },
})

runDeploymentStoreConformance('KvDeploymentStore (FileDurability)', {
  async make({ clock }) {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-deployments-'))
    const journal = await FileDurability.open(join(dir, 'kv.json'))
    return {
      store: new KvDeploymentStore(journal.kv, { clock }),
      teardown: async () => {
        await journal.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      },
    }
  },
})
