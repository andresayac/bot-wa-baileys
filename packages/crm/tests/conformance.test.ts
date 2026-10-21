/** Every ContactStore against the shared conformance suite: memory, Kv over MemoryKv, Kv over a FileDurability file. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDurability, MemoryKv } from '@botmesh/core'
import { KvContactStore, MemoryContactStore } from '../src/index.js'
import { runContactStoreConformance } from '../../../test-utils/contact-store-conformance.js'

runContactStoreConformance('MemoryContactStore', {
  async make({ clock }) { return { store: new MemoryContactStore({ clock }), teardown: async () => {} } },
})

runContactStoreConformance('KvContactStore (MemoryKv)', {
  async make({ clock }) { return { store: new KvContactStore(new MemoryKv(), { clock }), teardown: async () => {} } },
})

runContactStoreConformance('KvContactStore (FileDurability)', {
  async make({ clock }) {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-crm-'))
    const journal = await FileDurability.open(join(dir, 'kv.json'))
    return {
      store: new KvContactStore(journal.kv, { clock }),
      teardown: async () => {
        await journal.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      },
    }
  },
})
