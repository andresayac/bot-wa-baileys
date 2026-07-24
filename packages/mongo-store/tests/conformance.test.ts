/** MongoStore against the shared IStore conformance suite (in-memory fake client). */
import { MongoStore } from '../src/MongoStore.js'
import { FakeMongoClient } from './fakeMongo.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'

runStoreConformance('MongoStore', {
  async make() {
    const store = new MongoStore({ client: new FakeMongoClient() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
