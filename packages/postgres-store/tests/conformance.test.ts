/** PostgresStore against the shared IStore conformance suite (in-memory FakePool). */
import { legacyMessageKey, type StoredMessage } from '@bot-wa/core'
import { PostgresStore } from '../src/PostgresStore.js'
import { FakePool } from './fakePool.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

/** A message row exactly as PostgresStore wrote it before message keys were escaped. */
function legacySeeder(pool: FakePool) {
  return async (msg: StoredMessage): Promise<void> => {
    await pool.query(
      'INSERT INTO messages (id, chat_id, timestamp, msg) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET chat_id = EXCLUDED.chat_id, timestamp = EXCLUDED.timestamp, msg = EXCLUDED.msg',
      [legacyMessageKey(msg.ref), msg.chatId, msg.timestamp, JSON.stringify(msg)],
    )
  }
}

runStoreConformance('PostgresStore', {
  checkpointCas: true,
  async make() {
    const pool = new FakePool()
    const store = new PostgresStore({ pool })
    await store.start()
    return { store, teardown: () => store.stop(), seedLegacyMessage: legacySeeder(pool) }
  },
})

runUserDataConformance('PostgresStore', {
  async make() {
    const store = new PostgresStore({ pool: new FakePool() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
