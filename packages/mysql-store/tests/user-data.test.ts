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

  it('provisions user_data with a composite key, binary collation and an expiry index', () => {
    expect(ddl()).toBeDefined()
    expect(ddl()).toContain('PRIMARY KEY (user_id, namespace, `key`)')
    expect(ddl()).toContain('INDEX `user_data_expires_idx` (expires_at)')
    expect(ddl()).toContain('COLLATE=utf8mb4_bin') // ids/keys compare exactly, not case-insensitively
    expect(ddl()).toContain('value MEDIUMTEXT NOT NULL') // > 64 KiB values fit
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
