/** SQLiteStore against the shared IStore conformance suite. */
import { existsSync, unlinkSync } from 'fs'
import { SQLiteStore } from '../src/SQLiteStore.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'

let n = 0
runStoreConformance('SQLiteStore', {
  async make() {
    const file = `./test-conformance-${n++}.db`
    const clean = () => { for (const s of ['', '-wal', '-shm']) if (existsSync(file + s)) unlinkSync(file + s) }
    clean()
    const store = new SQLiteStore({ file })
    await store.start()
    return { store, teardown: async () => { await store.stop(); clean() } }
  },
})
