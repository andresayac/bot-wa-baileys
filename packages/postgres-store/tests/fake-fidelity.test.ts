/**
 * FakePool fidelity — the hermetic fake must behave like a real PostgreSQL
 * server on the bug classes the store has already hit for real: the atomic
 * JSONB merge on conflict, jsonb input rejections (U+0000 → 22P05, lone
 * surrogates → 22P02), BIGINT input rejections (non-integer → 22P02, out of
 * range → 22003) and ORDER BY tie-breaks.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { StoredMessage } from '@bot-wa/core'
import { PostgresStore } from '../src/PostgresStore.js'
import { FakePool } from './fakePool.js'

const msg = (chatId: string, id: string, ts: number): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body: id, fromMe: false,
})

const MERGE = 'INSERT INTO chats (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = (chats.data - $4::text[]) || $3::jsonb'

describe('FakePool fidelity', () => {
  let fake: FakePool

  beforeEach(async () => {
    fake = new FakePool()
    await new PostgresStore({ pool: fake }).start()
  })

  it('applies the atomic merge clause on conflict: (data - keys) || patch', async () => {
    await fake.query(MERGE, ['c1', '{"id":"c1","name":"A","kind":"group","tenantId":"t"}', '{}', []])
    // The INSERT payload ($2) must NOT win on conflict: only the merge does.
    await fake.query(MERGE, ['c1', '{"id":"c1","ignored":true}', '{"id":"c1","name":"B"}', ['kind']])
    const { rows } = await fake.query('SELECT data FROM chats WHERE id = $1', ['c1'])
    expect(rows).toEqual([{ data: { id: 'c1', name: 'B', tenantId: 't' } }])
  })

  it('rejects an unsupported DO UPDATE SET assignment', async () => {
    await expect(
      fake.query('INSERT INTO chats (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = chats.data', ['c', '{}']),
    ).rejects.toThrow(/unsupported/)
  })

  it('rejects U+0000 in JSONB input with 22P05', async () => {
    await expect(
      fake.query('INSERT INTO chats (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', ['c', '{"a":"x\\u0000y"}']),
    ).rejects.toMatchObject({ code: '22P05' })
    // Also when the bad value only appears in the merge patch ($3::jsonb).
    await expect(fake.query(MERGE, ['c', '{}', '{"a":"\\u0000"}', []])).rejects.toMatchObject({ code: '22P05' })
  })

  it('rejects lone UTF-16 surrogates in JSONB input with 22P02', async () => {
    for (const bad of ['{"a":"\\ud83d"}', '{"a":"\\ude00x"}', '{"\\udbff":1}']) {
      await expect(
        fake.query('INSERT INTO checkpoints (key, cp) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET cp = EXCLUDED.cp', ['k', bad]),
      ).rejects.toMatchObject({ code: '22P02' })
    }
    // A proper pair is fine.
    await fake.query('INSERT INTO checkpoints (key, cp) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET cp = EXCLUDED.cp', ['k', '{"a":"\\ud83d\\ude00"}'])
    const { rows } = await fake.query('SELECT cp FROM checkpoints WHERE key = $1', ['k'])
    expect(rows).toEqual([{ cp: { a: '\u{1F600}' } }])
  })

  it('rejects non-integer BIGINT input with 22P02 and out-of-range with 22003', async () => {
    const insert = 'INSERT INTO messages (id, chat_id, timestamp, msg) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET chat_id = EXCLUDED.chat_id, timestamp = EXCLUDED.timestamp, msg = EXCLUDED.msg'
    for (const bad of [1.5, Number.NaN, Infinity, 1e21, 'abc']) {
      await expect(fake.query(insert, ['m', 'c', bad, '{}'])).rejects.toMatchObject({ code: '22P02' })
    }
    await expect(fake.query(insert, ['m', 'c', '9223372036854775808', '{}'])).rejects.toMatchObject({ code: '22003' })
    await fake.query(insert, ['m', 'c', '-9223372036854775808', '{}'])
    await fake.query(insert, ['m2', 'c', 42, '{}'])
  })

  it('returns BIGINT columns as strings, like node-postgres', async () => {
    await fake.query(
      'INSERT INTO user_data (user_id, namespace, key, value, expires_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, namespace, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at',
      ['u', 'n', 'k', '1', null, 1700000000000],
    )
    const { rows } = await fake.query('SELECT updated_at, expires_at FROM user_data WHERE user_id = $1', ['u'])
    expect(rows).toEqual([{ updated_at: '1700000000000', expires_at: null }])
  })

  it('rejects a non-integer or negative LIMIT like PostgreSQL', async () => {
    const select = 'SELECT msg FROM messages WHERE chat_id = $1 ORDER BY timestamp DESC, id DESC LIMIT $2'
    await expect(fake.query(select, ['c', 2.5])).rejects.toMatchObject({ code: '22P02' })
    await expect(fake.query(select, ['c', -1])).rejects.toMatchObject({ code: '2201W' })
  })

  it('honours every ORDER BY key (timestamp DESC, id DESC)', async () => {
    const insert = 'INSERT INTO messages (id, chat_id, timestamp, msg) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET chat_id = EXCLUDED.chat_id, timestamp = EXCLUDED.timestamp, msg = EXCLUDED.msg'
    for (const id of ['b', 'd', 'a', 'c']) await fake.query(insert, [id, 'c', 5, JSON.stringify({ id })])
    const { rows } = await fake.query('SELECT msg FROM messages WHERE chat_id = $1 ORDER BY timestamp DESC, id DESC LIMIT $2', ['c', 3])
    expect(rows.map((r) => (r as { msg: { id: string } }).msg.id)).toEqual(['d', 'c', 'b'])
  })
})

describe('PostgresStore on a faithful fake', () => {
  let fake: FakePool
  let store: PostgresStore

  beforeEach(async () => {
    fake = new FakePool()
    store = new PostgresStore({ pool: fake })
    await store.start()
    fake.executed.length = 0
  })

  it('upsertChat / upsertContact are a single round trip (no pre-read)', async () => {
    await store.upsertChat({ id: 'c1', name: 'A' })
    await store.upsertContact({ id: 'u1', name: 'B' })
    expect(fake.executed).toHaveLength(2)
    expect(fake.executed.every((s) => s.startsWith('INSERT INTO'))).toBe(true)
  })

  it('merges server-side: fields written by another replica survive a partial upsert', async () => {
    await store.upsertChat({ id: 'c1', name: 'A', kind: 'group' })
    // Another replica adds a field the local process never saw.
    const other = new PostgresStore({ pool: fake })
    await other.start()
    await other.upsertChat({ id: 'c1', tenantId: 't' })
    await store.upsertChat({ id: 'c1', name: 'B', kind: undefined })
    expect(await store.getChat('c1')).toEqual({ id: 'c1', name: 'B', tenantId: 't' })
  })

  it('a first upsert with an explicit undefined field stores the patch without it', async () => {
    await store.upsertContact({ id: 'u1', name: 'A', username: undefined })
    expect(await store.getContact('u1')).toEqual({ id: 'u1', name: 'A' })
  })

  it('getMessagesByChat breaks timestamp ties deterministically and agrees with the trim', async () => {
    const capped = new PostgresStore({ pool: fake, maxMessagesPerChat: 2 })
    await capped.start()
    for (const id of ['m3', 'm1', 'm4', 'm2']) await capped.saveMessage(msg('c', id, 7))
    // trim keeps the newest 2 by (timestamp DESC, id DESC); the window must show exactly those.
    expect((await capped.getMessagesByChat('c')).map((m) => m.ref.id)).toEqual(['m3', 'm4'])
    for (const id of ['x3', 'x1', 'x4', 'x2']) await store.saveMessage(msg('d', id, 7))
    expect((await store.getMessagesByChat('d', 2)).map((m) => m.ref.id)).toEqual(['x3', 'x4'])
  })

  it('stores a fractional timestamp (sort key floored) without a BIGINT error', async () => {
    await store.saveMessage(msg('c', 'f', 1700000000000.75))
    expect((await store.getMessage({ id: 'f', chatId: 'c' }))?.timestamp).toBe(1700000000000.75)
  })

  it('stores strings JSONB rejects (U+0000, lone surrogates) instead of throwing', async () => {
    await store.saveMessage({ ...msg('c', 'z', 1), body: 'a\u0000b\uD83D' })
    await store.upsertChat({ id: 'c', name: '\uDE00', raw: { 'k\u0000': 'v' } })
    expect((await store.getMessage({ id: 'z', chatId: 'c' }))?.body).toBe('a\uFFFDb\uFFFD')
    expect(await store.getChat('c')).toEqual({ id: 'c', name: '\uFFFD', raw: { 'k\uFFFD': 'v' } })
  })
})
