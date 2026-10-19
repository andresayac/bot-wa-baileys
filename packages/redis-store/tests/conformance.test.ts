/** RedisStore against the shared IStore conformance suite (in-memory fake client). */
import { legacyMessageKey, type StoredMessage } from '@bot-wa/core'
import { RedisStore, type RedisLikeClient } from '../src/RedisStore.js'
import { FakeRedisClient, ScanningFakeRedisClient } from './fakeRedis.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

/** Write a message the way RedisStore did before message keys were escaped. */
function legacySeeder(client: RedisLikeClient, prefix = 'botwa') {
  return async (msg: StoredMessage): Promise<void> => {
    const member = legacyMessageKey(msg.ref)
    await client.set(`${prefix}:msg:item:${member}`, JSON.stringify(msg))
    await client.zAdd(`${prefix}:msg:${msg.chatId}`, { score: msg.timestamp, value: member })
  }
}

runStoreConformance('RedisStore', {
  async make() {
    const client = new FakeRedisClient()
    const store = new RedisStore({ client })
    await store.start()
    return { store, teardown: () => store.stop(), seedLegacyMessage: legacySeeder(client) }
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
