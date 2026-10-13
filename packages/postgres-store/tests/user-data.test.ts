/**
 * PostgresStore — user-data (`ctx.user`) specifics: schema (composite primary
 * key, expiry index), JSON-text values, BIGINT-as-string tolerance and
 * physical purge. The shared contract is covered by the user-data conformance
 * suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PostgresStore, type PostgresPoolLike, type PostgresQueryResult } from '../src/PostgresStore.js'
import { FakePool } from './fakePool.js'

describe('PostgresStore — user data', () => {
  let fake: FakePool
  let store: PostgresStore

  beforeEach(async () => {
    fake = new FakePool()
    store = new PostgresStore({ pool: fake })
    await store.start()
  })
  afterEach(async () => { await store.stop() })

  it('creates user_data with a composite primary key and an expiry index', () => {
    const def = fake.tables.get('user_data')
    expect(def?.pk).toEqual(['user_id', 'namespace', 'key'])
    expect(Object.fromEntries(def?.columns ?? [])).toEqual({
      user_id: 'TEXT', namespace: 'TEXT', key: 'TEXT', value: 'TEXT', expires_at: 'BIGINT', updated_at: 'BIGINT',
    })
    expect(fake.executed).toContain('CREATE INDEX IF NOT EXISTS user_data_expires_idx ON user_data (expires_at)')
  })

  it('namespaces the user_data table under tablePrefix', async () => {
    const scoped = new PostgresStore({ pool: fake, tablePrefix: 'acme_' })
    await scoped.start()
    await scoped.setUserData({ userId: 'u1', namespace: 'default', key: 'k', value: 1, updatedAt: 1 })
    expect(fake.tables.get('acme_user_data')?.rows.size).toBe(1)
    expect(await store.getUserData('u1', 'default', 'k')).toBeUndefined()
  })

  it('stores the value as exact JSON text and upserts on the composite key', async () => {
    await store.setUserData({ userId: 'u1', namespace: 'n', key: 'k', value: { b: 1, a: [1.5] }, updatedAt: 1 })
    await store.setUserData({ userId: 'u1', namespace: 'n', key: 'k', value: { b: 2 }, expiresAt: Date.now() + 60_000, updatedAt: 2 })
    const rows = [...(fake.tables.get('user_data')?.rows.values() ?? [])]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: 'u1', namespace: 'n', key: 'k', value: '{"b":2}', updated_at: 2 })
  })

  it('purgeExpiredUserData physically deletes only expired rows and reports the count', async () => {
    const now = Date.now()
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'old', value: 1, expiresAt: now - 10, updatedAt: now })
    await store.setUserData({ userId: 'u2', namespace: 'g', key: 'old', value: 2, expiresAt: now, updatedAt: now })
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'live', value: 3, expiresAt: now + 60_000, updatedAt: now })
    await store.setUserData({ userId: 'u1', namespace: 'g', key: 'forever', value: 4, updatedAt: now })
    expect(fake.tables.get('user_data')?.rows.size).toBe(4) // lazily hidden, still stored
    expect(await store.purgeExpiredUserData(now)).toBe(2)
    expect([...(fake.tables.get('user_data')?.rows.values() ?? [])].map((r) => r.key).sort()).toEqual(['forever', 'live'])
    expect(await store.purgeExpiredUserData(now)).toBe(0)
  })

  it('returns numeric metadata when the driver yields BIGINT columns as strings (node-postgres default)', async () => {
    const stringly: PostgresPoolLike = {
      async query(text: string, values?: unknown[]): Promise<PostgresQueryResult> {
        const result = await fake.query(text, values)
        return {
          ...result,
          rows: result.rows.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(
            ([k, v]) => [k, (k === 'expires_at' || k === 'updated_at') && v != null ? String(v) : v],
          ))),
        }
      },
      async end() {},
    }
    const expiresAt = Date.now() + 60_000
    const viaStrings = new PostgresStore({ pool: stringly })
    await viaStrings.start()
    await viaStrings.setUserData({ userId: 'u1', namespace: 'n', key: 'k', value: 'v', expiresAt, updatedAt: 42 })
    expect(await viaStrings.getUserData('u1', 'n', 'k')).toEqual({
      userId: 'u1', namespace: 'n', key: 'k', value: 'v', expiresAt, updatedAt: 42,
    })
    expect(await viaStrings.listUserData('u1')).toEqual([{ userId: 'u1', namespace: 'n', key: 'k', value: 'v', expiresAt, updatedAt: 42 }])
  })
})
