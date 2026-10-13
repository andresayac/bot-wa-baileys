/** MysqlStore against the shared IStore conformance suite (in-memory FakePool). */
import { MysqlStore } from '../src/MysqlStore.js'
import { FakePool } from './fakePool.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

runStoreConformance('MysqlStore', {
  async make() {
    const store = new MysqlStore({ pool: new FakePool() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})

runUserDataConformance('MysqlStore', {
  async make() {
    const store = new MysqlStore({ pool: new FakePool() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
