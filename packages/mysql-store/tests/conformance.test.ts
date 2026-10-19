/** MysqlStore against the shared IStore conformance suite (in-memory FakePool). */
import { legacyMessageKey, type StoredMessage } from '@bot-wa/core'
import { MysqlStore } from '../src/MysqlStore.js'
import { FakePool } from './fakePool.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

/** A message row exactly as MysqlStore wrote it before message keys were escaped. */
function legacySeeder(pool: FakePool) {
  return async (msg: StoredMessage): Promise<void> => {
    await pool.query(
      'INSERT INTO `messages` (id, chat_id, timestamp, msg) VALUES (?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE chat_id = VALUES(chat_id), timestamp = VALUES(timestamp), msg = VALUES(msg)',
      [legacyMessageKey(msg.ref), msg.chatId, msg.timestamp, JSON.stringify(msg)],
    )
  }
}

runStoreConformance('MysqlStore', {
  async make() {
    const pool = new FakePool()
    const store = new MysqlStore({ pool })
    await store.start()
    return { store, teardown: () => store.stop(), seedLegacyMessage: legacySeeder(pool) }
  },
})

runUserDataConformance('MysqlStore', {
  async make() {
    const store = new MysqlStore({ pool: new FakePool() })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
