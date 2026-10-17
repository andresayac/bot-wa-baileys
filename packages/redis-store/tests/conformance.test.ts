/** RedisStore against the shared IStore conformance suite (in-memory fake client). */
import { RedisStore } from '../src/RedisStore.js'
import { FakeRedisClient } from './fakeRedis.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

runStoreConformance('RedisStore', {
  async make() {
    const store = new RedisStore({ client: new FakeRedisClient() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})

runUserDataConformance('RedisStore', {
  async make() {
    const store = new RedisStore({ client: new FakeRedisClient() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
