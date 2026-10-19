/** SQLiteStore against the shared IStore conformance suites. */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SQLiteStore } from '../src/SQLiteStore.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

/**
 * A fresh database in its own temp directory per test: on Windows a just-closed
 * SQLite file can stay locked for a moment (EBUSY), so fixed paths were flaky.
 */
async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'botwa-sqlite-conf-'))
  const store = new SQLiteStore({ file: join(dir, 'store.db') })
  await store.start()
  return {
    store,
    teardown: async () => {
      await store.stop()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

runStoreConformance('SQLiteStore', { make })
runUserDataConformance('SQLiteStore', { make })
