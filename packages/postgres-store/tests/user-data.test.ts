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
    expect(rows[0]).toMatchObject({ user_id: 'u1', namespace: 'n', key: 'k', value: '{"b":2}', updated_at: '2' }) // BIGINT: a string, like node-postgres returns it
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

  it('stores values exactly: U+0000, lone surrogates and U+FFFD round-trip unchanged (no sanitising)', async () => {
    const value = {
      nul: 'a\u0000b',
      lone: 'x\ud83d',
      low: '\udc00y',
      ok: '👍',
      fffd: '�',
      literal: '\\u0000 is text',
      'k\u0000': 1,
      nested: [{ v: '\u0000\ud800' }],
    }
    await store.setUserData({ userId: 'u1', namespace: 'n', key: 'k', value, updatedAt: 1 })
    expect((await store.getUserData('u1', 'n', 'k'))?.value).toEqual(value)
    expect((await store.listUserData('u1', 'n'))[0]?.value).toEqual(value)
    for (const s of ['\u0000', 'a\ud83d', '\udfff']) {
      await store.setUserData({ userId: 'u1', namespace: 'n', key: 's', value: s, updatedAt: 1 })
      expect((await store.getUserData('u1', 'n', 's'))?.value).toBe(s)
    }
  })

  it('the stored text is the plain JSON.stringify output (NUL travels as the \\u0000 escape, never a raw byte)', async () => {
    const value = { nul: 'a\u0000b', lone: 'x\ud83d' }
    await store.setUserData({ userId: 'u1', namespace: 'n', key: 'k', value, updatedAt: 1 })
    const row = [...(fake.tables.get('user_data')?.rows.values() ?? [])][0] as { value: string }
    expect(row.value).toBe(JSON.stringify(value))
    expect(row.value).not.toContain('\u0000') // no raw NUL reaches the TEXT column…
    expect(row.value).toContain('\\u0000')    // …only the six-character JSON escape
  })

  it('purgeExpiredUserData deletes in batches of purgeBatchSize and still removes every expired row', async () => {
    const batched = new PostgresStore({ pool: fake, purgeBatchSize: 3 })
    await batched.start()
    const now = Date.now()
    for (let i = 0; i < 7; i++) {
      await batched.setUserData({ userId: `u${i}`, namespace: 'g', key: 'old', value: i, expiresAt: now - i, updatedAt: now })
    }
    await batched.setUserData({ userId: 'u1', namespace: 'g', key: 'live', value: 'x', expiresAt: now + 60_000, updatedAt: now })
    await batched.setUserData({ userId: 'u1', namespace: 'g', key: 'forever', value: 'y', updatedAt: now })
    const before = fake.executed.length
    expect(await batched.purgeExpiredUserData(now)).toBe(7)
    const deletes = fake.executed.slice(before).filter((s) => s.startsWith('DELETE FROM user_data'))
    expect(deletes).toHaveLength(3) // 3 + 3 + 1: a short batch means nothing is left
    expect(deletes[0]).toContain('LIMIT $2')
    expect([...(fake.tables.get('user_data')?.rows.values() ?? [])].map((r) => r.key).sort()).toEqual(['forever', 'live'])
  })

  it('rejects a purgeBatchSize that is not a positive integer', () => {
    for (const purgeBatchSize of [0, -1, 1.5, Number.NaN]) {
      expect(() => new PostgresStore({ pool: fake, purgeBatchSize })).toThrow(RangeError)
    }
  })
})
