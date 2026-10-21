/** Every PluginStore against the shared conformance suite: memory, Kv over MemoryKv, Kv over a FileDurability file. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDurability, MemoryKv } from '@botmesh/core'
import { KvPluginStore, MemoryPluginStore } from '../src/index.js'
import { runPluginStoreConformance } from '../../../test-utils/plugin-store-conformance.js'

runPluginStoreConformance('MemoryPluginStore', {
  async make() { return { store: new MemoryPluginStore(), teardown: async () => {} } },
})

runPluginStoreConformance('KvPluginStore (MemoryKv)', {
  async make() { return { store: new KvPluginStore(new MemoryKv()), teardown: async () => {} } },
})

runPluginStoreConformance('KvPluginStore (FileDurability)', {
  async make() {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-hub-'))
    const journal = await FileDurability.open(join(dir, 'kv.json'))
    return {
      store: new KvPluginStore(journal.kv),
      teardown: async () => {
        await journal.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      },
    }
  },
})
