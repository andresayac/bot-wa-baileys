/** RedisStore against the shared IStore conformance suite (in-memory fake client). */
import { RedisStore } from '../src/RedisStore.js'
import { FakeRedisClient, ScanningFakeRedisClient } from './fakeRedis.js'
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

// Same contract when the client offers SCAN (node-redis' scanIterator) instead of only KEYS.
runStoreConformance('RedisStore (SCAN client)', {
  async make() {
    const store = new RedisStore({ client: new ScanningFakeRedisClient() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})

runUserDataConformance('RedisStore (SCAN client)', {
  async make() {
    const store = new RedisStore({ client: new ScanningFakeRedisClient() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
