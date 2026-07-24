/** PostgresStore against the shared IStore conformance suite (in-memory FakePool). */
import { PostgresStore } from '../src/PostgresStore.js'
import { FakePool } from './fakePool.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'

runStoreConformance('PostgresStore', {
  async make() {
    const store = new PostgresStore({ pool: new FakePool() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
