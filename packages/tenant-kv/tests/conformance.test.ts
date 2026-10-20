/** TenantDocs against the shared conformance suite, over MemoryKv and a FileDurability file. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDurability, MemoryKv } from '@bot-wa/core'
import { CorruptDocumentError, TenantDocs } from '../src/index.js'
import { runTenantDocsConformance } from '../../../test-utils/tenant-docs-conformance.js'

const deps = { TenantDocs, CorruptDocumentError }

runTenantDocsConformance('MemoryKv', deps, {
  async make() { return { kv: new MemoryKv(), teardown: async () => {} } },
})

runTenantDocsConformance('FileDurability', deps, {
  async make() {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-tenant-kv-'))
    const journal = await FileDurability.open(join(dir, 'kv.json'))
    return {
      kv: journal.kv,
      teardown: async () => {
        await journal.close()
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      },
    }
  },
})
