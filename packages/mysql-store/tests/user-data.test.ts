/**
 * MysqlStore — user-data (`ctx.user`) specifics: schema (composite primary
 * key, binary collation, inline expiry index), JSON-text values, purge count
 * from `affectedRows`, BIGINT-as-string tolerance. The shared contract is
 * covered by the user-data conformance suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MysqlStore, type MysqlQueryResult, type PoolLike } from '../src/MysqlStore.js'
import { FakePool } from './fakePool.js'

describe('MysqlStore — user data', () => {
  let fake: FakePool
  let store: MysqlStore

  beforeEach(async () => {
    fake = new FakePool()
    store = new MysqlStore({ pool: fake })
    await store.start()
  })
  afterEach(async () => { await store.stop() })

  const ddl = () => fake.queries.map((q) => q.sql).find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS `user_data`'))

  it('provisions user_data with a composite key, byte-exact identifiers and an expiry index', () => {
    expect(ddl()).toBeDefined()
    expect(ddl()).toContain('PRIMARY KEY (user_id, namespace, `key`)')
    expect(ddl()).toContain('INDEX `user_data_expires_idx` (expires_at)')
    // VARBINARY compares bytes: case, accents AND trailing spaces are significant.
    // utf8mb4_bin is PAD SPACE, so 'name ' and 'name' would share one row.
    expect(ddl()).toContain('user_id VARBINARY(1024) NOT NULL')
    expect(ddl()).toContain('namespace VARBINARY(512) NOT NULL')
    expect(ddl()).toContain('`key` VARBINARY(1020) NOT NULL')
    expect(ddl()).not.toMatch(/VARCHAR/)
    expect(ddl()).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4') // the JSON value keeps emoji
    expect(ddl()).toContain('value MEDIUMTEXT NOT NULL') // > 64 KiB values fit
    expect(fake.userDataIdentifiers).toBe('binary')
  })

  it('decodes VARBINARY identifiers that mysql2 returns as Buffers', async () => {
    await store.setUserData({ userId: 'jüan 🎲 ', namespace: 'jüego ', key: 'ñame ', value: 1, updatedAt: 1 })
    const [rows] = await fake.query(
      'SELECT user_id, namespace, `key`, value, expires_at, updated_at FROM `user_data` WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)',
      ['jüan 🎲 ', 0],
    )
    expect(Buffer.isBuffer(rows[0]?.user_id)).toBe(true) // the fake models mysql2
    expect(await store.listUserData('jüan 🎲 ')).toEqual([
      { userId: 'jüan 🎲 ', namespace: 'jüego ', key: 'ñame ', value: 1, updatedAt: 1 },
    ])
    expect(await store.getUserData('jüan 🎲 ', 'jüego ', 'ñame ')).toMatchObject({ userId: 'jüan 🎲 ', key: 'ñame ' })
  })

  it('the fake models PAD SPACE, so the old utf8mb4_bin schema would merge trailing-space keys', async () => {
    const padded = new FakePool()
    await padded.query(
      'CREATE TABLE IF NOT EXISTS `user_data` (user_id VARCHAR(255) NOT NULL, namespace VARCHAR(128) NOT NULL, ' +
        '`key` VARCHAR(255) NOT NULL, value MEDIUMTEXT NOT NULL, expires_at BIGINT NULL, updated_at BIGINT NOT NULL, ' +
        'PRIMARY KEY (user_id, namespace, `key`)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    )
    expect(padded.userDataIdentifiers).toBe('padSpace')
    const insert = 'INSERT INTO `user_data` (user_id, namespace, `key`, value, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE value = VALUES(value), expires_at = VALUES(expires_at), updated_at = VALUES(updated_at)'
    await padded.query(insert, ['u1', 'default', 'name ', '"a"', null, 1])
    await padded.query(insert, ['u1', 'default', 'name', '"b"', null, 2])
    expect([...(padded.tables.get('user_data')?.values() ?? [])]).toEqual([
      { user_id: 'u1', namespace: 'default', key: 'name ', value: '"b"', expires_at: null, updated_at: 2 },
    ])
  })

  it('honors tablePrefix', async () => {
    const prefixedFake = new FakePool({ tablePrefix: 'acme_' })
    const scoped = new MysqlStore({ pool: prefixedFake, tablePrefix: 'acme_' })
    await scoped.start()
    await scoped.setUserData({ userId: 'u1', namespace: 'default', key: 'k', value: 1, updatedAt: 1 })
    expect(prefixedFake.tables.get('acme_user_data')?.size).toBe(1)
    expect(prefixedFake.tables.has('user_data')).toBe(false)
    await scoped.stop()
  })

  it('stores the value as exact JSON text', async () => {
    await store.setUserData({ userId: 'u1', namespace: 'n', key: 'k', value: { b: 1, a: [1.5] }, updatedAt: 1 })
    const rows = [...(fake.tables.get('user_data')?.values() ?? [])]
    expect(rows).toEqual([{ user_id: 'u1', namespace: 'n', key: 'k', value: '{"b":1,"a":[1.5]}', expires_at: null, updated_at: 1 }])
  })

  it('purgeExpiredUserData physically deletes only expired rows and reports affectedRows', async () => {
    const now = Date.now()
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'old', value: 1, expiresAt: now - 10, updatedAt: now })
    await store.setUserData({ userId: 'u2', namespace: 'g', key: 'old', value: 2, expiresAt: now, updatedAt: now })
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'live', value: 3, expiresAt: now + 60_000, updatedAt: now })
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'forever', value: 4, updatedAt: now })
    expect(fake.tables.get('user_data')?.size).toBe(4) // lazily hidden, still stored
    expect(await store.purgeExpiredUserData(now)).toBe(2)
    expect([...(fake.tables.get('user_data')?.values() ?? [])].map((r) => r.key).sort()).toEqual(['forever', 'live'])
    expect(await store.purgeExpiredUserData(now)).toBe(0)
  })

  it('returns numeric metadata when the driver yields BIGINT columns as strings (bigNumberStrings)', async () => {
    const stringly: PoolLike = {
      async query(sql: string, params?: readonly unknown[]): Promise<MysqlQueryResult> {
        const [rows, fields] = await fake.query(sql, params)
        if (!Array.isArray(rows)) return [rows, fields]
        return [rows.map((row) => Object.fromEntries(Object.entries(row).map(
          ([k, v]) => [k, (k === 'expires_at' || k === 'updated_at') && v != null ? String(v) : v],
        ))), fields]
      },
      async end() {},
    }
    const expiresAt = Date.now() + 60_000
    const viaStrings = new MysqlStore({ pool: stringly })
    await viaStrings.start()
    await viaStrings.setUserData({ userId: 'u1', namespace: 'n', key: 'k', value: 'v', expiresAt, updatedAt: 42 })
    expect(await viaStrings.getUserData('u1', 'n', 'k')).toEqual({
      userId: 'u1', namespace: 'n', key: 'k', value: 'v', expiresAt, updatedAt: 42,
    })
    expect(await viaStrings.listUserData('u1', 'n')).toEqual([{ userId: 'u1', namespace: 'n', key: 'k', value: 'v', expiresAt, updatedAt: 42 }])
  })
})
