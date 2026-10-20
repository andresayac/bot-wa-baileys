/** MemoryStore against the shared IStore conformance suite (the reference impl). */
import { MemoryStore } from '../src/store/MemoryStore.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'

runStoreConformance('MemoryStore', {
  checkpointCas: true,
  async make() {
    const store = new MemoryStore({})
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
