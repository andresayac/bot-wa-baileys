/** Every InboxStore against the shared conformance suite: memory, Kv over MemoryKv, Kv over a FileDurability file. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDurability, MemoryKv } from '@bot-wa/core'
import { KvInboxStore, MemoryInboxStore } from '../src/index.js'
import { runInboxStoreConformance } from '../../../test-utils/inbox-store-conformance.js'

runInboxStoreConformance('MemoryInboxStore', {
  async make({ clock }) { return { store: new MemoryInboxStore({ clock }), teardown: async () => {} } },
})

runInboxStoreConformance('KvInboxStore (MemoryKv)', {
  async make({ clock }) { return { store: new KvInboxStore(new MemoryKv(), { clock }), teardown: async () => {} } },
})

runInboxStoreConformance('KvInboxStore (FileDurability)', {
  async make({ clock }) {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-inbox-'))
    const journal = await FileDurability.open(join(dir, 'kv.json'))
    return {
      store: new KvInboxStore(journal.kv, { clock }),
      teardown: async () => {
        await journal.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      },
    }
  },
})
