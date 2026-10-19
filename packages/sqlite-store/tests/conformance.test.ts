/** SQLiteStore against the shared IStore conformance suites. */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type BetterSqlite3 from 'better-sqlite3'
import { legacyMessageKey, type StoredMessage } from '@bot-wa/core'
import { SQLiteStore } from '../src/SQLiteStore.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

/**
 * A fresh database in its own temp directory per test: on Windows a just-closed
 * SQLite file can stay locked for a moment (EBUSY), so fixed paths were flaky.
 */
async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'botwa-sqlite-conf-'))
  const store = new SQLiteStore({ file: join(dir, 'store.db') })
  await store.start()
  // Rows exactly as SQLiteStore wrote them before message keys were escaped.
  const db = (store as unknown as { db: BetterSqlite3.Database }).db
  const seedLegacyMessage = async (msg: StoredMessage): Promise<void> => {
    db.prepare(
      'INSERT OR REPLACE INTO messages (id, chat_id, sender_id, timestamp, type, body, from_me, msg_json) VALUES (?,?,?,?,?,?,?,?)',
    ).run(legacyMessageKey(msg.ref), msg.chatId, msg.senderId ?? null, msg.timestamp, msg.type, msg.body ?? null, msg.fromMe ? 1 : 0, JSON.stringify(msg))
  }
  return {
    store,
    seedLegacyMessage,
    teardown: async () => {
      await store.stop()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

runStoreConformance('SQLiteStore', { make })
runUserDataConformance('SQLiteStore', { make })
