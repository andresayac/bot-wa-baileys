/** MongoStore against the shared IStore conformance suite (in-memory fake client). */
import { legacyMessageKey, type StoredMessage } from '@botmesh/core'
import { MongoStore } from '../src/MongoStore.js'
import { FakeMongoClient } from './fakeMongo.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

runStoreConformance('MongoStore', {
  checkpointCas: true,
  async make() {
    const client = new FakeMongoClient()
    const store = new MongoStore({ client })
    await store.start()
    // A message document exactly as MongoStore wrote it before keys were escaped.
    const seedLegacyMessage = async (msg: StoredMessage): Promise<void> => {
      await client.db('botwa').collection<{ _id: string; chatId: string; timestamp: number; msg: StoredMessage }>('messages')
        .updateOne({ _id: legacyMessageKey(msg.ref) }, { $set: { chatId: msg.chatId, timestamp: msg.timestamp, msg } }, { upsert: true })
    }
    return { store, teardown: () => store.stop(), seedLegacyMessage }
  },
})

runUserDataConformance('MongoStore', {
  async make() {
    const store = new MongoStore({ client: new FakeMongoClient() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
