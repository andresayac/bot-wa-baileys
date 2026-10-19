/**
 * SQLiteStore — user-data (`ctx.user`) specifics: schema, persistence across
 * reopen, physical purge of expired rows. The shared contract is covered by
 * the user-data conformance suite (tests/conformance.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SQLiteStore } from '../src/SQLiteStore.js'

// Under the OS temp dir, not the package folder (no stray files when a run is interrupted).
const FILE = join(mkdtempSync(join(tmpdir(), 'botwa-sqlite-ud-')), 'user-data.db')
const clean = () => { for (const s of ['', '-wal', '-shm']) if (existsSync(FILE + s)) unlinkSync(FILE + s) }
const count = (sql: string): number => {
  const db = new Database(FILE, { readonly: true })
  try { return (db.prepare(sql).get() as { n: number }).n } finally { db.close() }
}

describe('SQLiteStore — user data', () => {
  let store: SQLiteStore
  beforeEach(async () => { clean(); store = new SQLiteStore({ file: FILE }); await store.start() })
  afterEach(async () => { await store.stop(); clean() })

  it('creates the user_data table and its expiry index idempotently', async () => {
    await store.stop()
    store = new SQLiteStore({ file: FILE }) // second migrate on the same file must not fail
    await store.start()
    expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'user_data'")).toBe(1)
    expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_data_expires'")).toBe(1)
  })

  it('keeps user data across a reopen of the database file', async () => {
    await store.setUserData({ userId: 'u1', namespace: 'default', key: 'name', value: { first: 'Juan' }, updatedAt: 5 })
    await store.stop()
    store = new SQLiteStore({ file: FILE })
    await store.start()
    expect(await store.getUserData('u1', 'default', 'name')).toEqual({
      userId: 'u1', namespace: 'default', key: 'name', value: { first: 'Juan' }, updatedAt: 5,
    })
  })

  it('purgeExpiredUserData physically deletes only expired rows', async () => {
    const now = Date.now()
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'old', value: 1, expiresAt: now - 10, updatedAt: now })
    await store.setUserData({ userId: 'u2', namespace: 'g', key: 'old', value: 2, expiresAt: now - 5, updatedAt: now })
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'live', value: 3, expiresAt: now + 60_000, updatedAt: now })
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'forever', value: 4, updatedAt: now })
    expect(count('SELECT COUNT(*) AS n FROM user_data')).toBe(4) // lazily hidden, still on disk
    expect(await store.purgeExpiredUserData(now)).toBe(2)
    expect(count('SELECT COUNT(*) AS n FROM user_data')).toBe(2)
    expect(await store.purgeExpiredUserData(now)).toBe(0)
  })
})
