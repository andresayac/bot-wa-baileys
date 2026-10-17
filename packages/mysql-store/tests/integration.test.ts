/**
 * MysqlStore — integration tests against a REAL MySQL/MariaDB server.
 *
 * The unit suites (mysql-store.test.ts, conformance.test.ts) run against an
 * in-memory FakePool that pattern-matches the store's SQL, so real MySQL
 * never executed those statements. This file does: it runs the shared IStore
 * conformance suite plus MySQL-specific behaviour (schema/index provisioning,
 * persistence, trimming, collation, JSON edge cases, concurrency) on a live
 * server.
 *
 * Opt-in: the whole file is skipped unless BOTWA_TEST_MYSQL_URL is set, so
 * `pnpm test` stays hermetic. Locally:
 *
 *   docker run -d --name botwa-it-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -e MYSQL_DATABASE=botwa -p 53306:3306 mysql:8.4
 *   BOTWA_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:53306/botwa \
 *     pnpm --filter @bot-wa/mysql-store test
 *
 * Isolation: every store gets its own table prefix (`it<run>_<n>_`), so runs
 * never collide with each other or with real data in the same database. Each
 * test drops its tables in teardown and `afterAll` sweeps anything left over
 * from this run.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPool } from 'mysql2/promise'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { AIMessage, FlowCheckpoint, StoredMessage } from '@bot-wa/core'
import { MysqlStore } from '../src/MysqlStore.js'
import type { MysqlQueryResult, MysqlStoreOptions, PoolLike } from '../src/MysqlStore.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'
import { FakePool } from './fakePool.js'

const MYSQL_URL = process.env.BOTWA_TEST_MYSQL_URL?.trim() ?? ''
const enabled = MYSQL_URL !== ''

const TABLES = ['messages', 'chats', 'contacts', 'checkpoints', 'conversations', 'cursors', 'user_data'] as const

/** Unique per process run; every store gets `${RUN}_${n}_` as its table prefix. */
const RUN = `it${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
let seq = 0
const nextPrefix = (): string => `${RUN}_${++seq}_`

const msg = (chatId: string, id: string, body: string, ts: number, extra: Partial<StoredMessage> = {}): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false, ...extra,
})

const bodies = (list: StoredMessage[]): Array<string | undefined> => list.map((m) => m.body)

// Every conformance test provisions (and drops) a fresh seven-table schema. MySQL DDL
// is slow on some hosts (Docker on Windows: ~1 s per test), and slower still while the
// other store suites run in parallel, so the default 10 s hook/test budget is too tight.
if (enabled) vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

describe.skipIf(!enabled)('MysqlStore — real MySQL integration', () => {
  /** Out-of-band connection used for setup, raw assertions and cleanup. */
  let admin: Pool

  async function dropTables(prefix: string): Promise<void> {
    // One statement for all seven tables: DDL dominates this suite's run time.
    await admin.query(`DROP TABLE IF EXISTS ${TABLES.map((t) => `\`${prefix}${t}\``).join(', ')}`)
  }

  async function rowCount(prefix: string, table: string, where = '1 = 1', params: unknown[] = []): Promise<number> {
    const [rows] = await admin.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${prefix}${table}\` WHERE ${where}`, params)
    return Number(rows[0]?.n)
  }

  /** A started store on a fresh prefix + a teardown that stops it and drops its tables. */
  async function makeStore(opts: MysqlStoreOptions = {}): Promise<{ store: MysqlStore; prefix: string; teardown: () => Promise<void> }> {
    const prefix = opts.tablePrefix ?? nextPrefix()
    const store = new MysqlStore({ uri: MYSQL_URL, ...opts, tablePrefix: prefix })
    await store.start()
    return {
      store,
      prefix,
      teardown: async () => {
        await store.stop()
        await dropTables(prefix)
      },
    }
  }

  beforeAll(async () => {
    admin = createPool(MYSQL_URL)
    await admin.query('SELECT 1') // fail early (and clearly) when the server is unreachable
  })

  afterAll(async () => {
    if (admin == null) return
    // Safety net: drop anything this run created that a failed test left behind.
    const [rows] = await admin.query<RowDataPacket[]>(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    )
    for (const r of rows) {
      const name = String(r.name)
      if (name.startsWith(`${RUN}_`)) await admin.query(`DROP TABLE IF EXISTS \`${name}\``)
    }
    await admin.end()
  })

  /* Shared contract -------------------------------------------------------- */

  runStoreConformance('MysqlStore (real MySQL)', {
    async make() {
      const { store, teardown } = await makeStore()
      return { store, teardown }
    },
  })

  runUserDataConformance('MysqlStore (real MySQL)', {
    async make() {
      const { store, teardown } = await makeStore()
      return { store, teardown }
    },
  })

  describe('user data (ctx.user)', () => {
    it('user_data keys are byte-exact VARBINARY on InnoDB, like the other tables', async () => {
      const { prefix, teardown } = await makeStore()
      try {
        const [cols] = await admin.query<RowDataPacket[]>(
          'SELECT COLUMN_NAME AS col, DATA_TYPE AS type FROM information_schema.COLUMNS ' +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN ('user_id', 'namespace', 'key') ORDER BY COLUMN_NAME",
          [`${prefix}user_data`],
        )
        expect(cols.map((r) => [String(r.col), String(r.type)])).toEqual([['key', 'varbinary'], ['namespace', 'varbinary'], ['user_id', 'varbinary']])
        const [tables] = await admin.query<RowDataPacket[]>(
          'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
          [`${prefix}user_data`],
        )
        expect(String(tables[0]?.engine)).toBe('InnoDB')
      } finally {
        await teardown()
      }
    })

    it('a value with a lone surrogate is stored like the JSON columns (toJson → U+FFFD)', async () => {
      const { store, teardown } = await makeStore()
      try {
        await store.setUserData({ userId: 'u', namespace: 'default', key: 'k', value: { lone: 'x\ud83d', ok: '👍' }, updatedAt: 1 })
        expect((await store.getUserData('u', 'default', 'k'))?.value).toEqual({ lone: 'x' + String.fromCharCode(0xfffd), ok: '👍' })
      } finally {
        await teardown()
      }
    })
  })

  /* Schema provisioning ------------------------------------------------------ */

  describe('schema', () => {
    it('provisions the seven tables and the (chat_id, timestamp) index idempotently', async () => {
      const { store, prefix, teardown } = await makeStore()
      try {
        await store.saveMessage(msg('c', 'm1', 'survives re-provisioning', 1))
        // start() again on the same store, then a second instance on the same prefix.
        await store.start()
        const again = new MysqlStore({ uri: MYSQL_URL, tablePrefix: prefix })
        await again.start()
        await again.start()
        await again.stop()

        const [tables] = await admin.query<RowDataPacket[]>(
          'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)',
          [TABLES.map((t) => `${prefix}${t}`)],
        )
        expect(tables.map((r) => String(r.name)).sort()).toEqual(TABLES.map((t) => `${prefix}${t}`).sort())

        const [idx] = await admin.query<RowDataPacket[]>(
          'SELECT INDEX_NAME AS idx, COLUMN_NAME AS col FROM information_schema.STATISTICS ' +
            'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
          [`${prefix}messages`],
        )
        const byIndex = new Map<string, string[]>()
        for (const r of idx) byIndex.set(String(r.idx), [...(byIndex.get(String(r.idx)) ?? []), String(r.col)])
        expect(byIndex.get('PRIMARY')).toEqual(['id'])
        // Exactly one secondary index, on (chat_id, timestamp) — not duplicated by re-runs.
        const secondary = [...byIndex.entries()].filter(([name]) => name !== 'PRIMARY')
        expect(secondary.map(([, cols]) => cols)).toEqual([['chat_id', 'timestamp']])

        expect((await store.getMessage({ id: 'm1', chatId: 'c' }))?.body).toBe('survives re-provisioning')
      } finally {
        await teardown()
      }
    })

    it('getMessagesByChat uses the (chat_id, timestamp) index', async () => {
      const { prefix, teardown } = await makeStore()
      try {
        const [plan] = await admin.query<RowDataPacket[]>(
          `EXPLAIN SELECT msg FROM \`${prefix}messages\` WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`,
          ['c', 10],
        )
        expect(String(plan[0]?.key)).toBe('chat_ts')
      } finally {
        await teardown()
      }
    })
  })

  /* Lifecycle / persistence ---------------------------------------------------- */

  describe('persistence', () => {
    it('keeps every kind of state across stop()/start() and a fresh client', async () => {
      const { store, prefix, teardown } = await makeStore()
      try {
        const cp: FlowCheckpoint = { flowId: 'register', step: 3, state: { name: 'Ana', tags: ['a', 'b'] }, updatedAt: 1_700_000_000_123 }
        const convo: AIMessage[] = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: '¿En qué te ayudo?' }]
        await store.saveMessage(msg('chat@x', 'm1', 'first', 1_700_000_000_001))
        await store.saveMessage(msg('chat@x', 'm2', 'second', 1_700_000_000_002, { quoted: { id: 'm1', chatId: 'chat@x' } }))
        await store.upsertChat({ id: 'chat@x', name: 'Chat', kind: 'group', lastMessageAt: 1_700_000_000_002 })
        await store.upsertContact({ id: 'user@x', name: 'Ana', phoneNumber: '+57 300 000 0000' })
        await store.setCheckpoint('chat@x:user@x', cp)
        await store.setConversation('chat@x', convo)
        await store.setCursor('tg:updates', '000123')
        await store.stop()

        // After stop() the self-created pool is gone: calls fail fast.
        await expect(store.getChat('chat@x')).rejects.toThrow(/start\(\)/)

        // A brand-new client (new pool, new instance) sees everything.
        const fresh = new MysqlStore({ uri: MYSQL_URL, tablePrefix: prefix })
        await fresh.start()
        try {
          expect(bodies(await fresh.getMessagesByChat('chat@x'))).toEqual(['first', 'second'])
          expect((await fresh.getMessage({ id: 'm2', chatId: 'chat@x' }))?.quoted).toEqual({ id: 'm1', chatId: 'chat@x' })
          expect(await fresh.getChat('chat@x')).toEqual({ id: 'chat@x', name: 'Chat', kind: 'group', lastMessageAt: 1_700_000_000_002 })
          expect(await fresh.getContact('user@x')).toEqual({ id: 'user@x', name: 'Ana', phoneNumber: '+57 300 000 0000' })
          expect(await fresh.getCheckpoint('chat@x:user@x')).toEqual(cp)
          expect(await fresh.listCheckpoints()).toEqual([['chat@x:user@x', cp]])
          expect(await fresh.getConversation('chat@x')).toEqual(convo)
          expect(await fresh.getCursor('tg:updates')).toBe('000123') // TEXT: no numeric coercion
        } finally {
          await fresh.stop()
        }

        // The original instance can be restarted (creates a new pool).
        await store.start()
        expect((await store.getMessage({ id: 'm1', chatId: 'chat@x' }))?.timestamp).toBe(1_700_000_000_001)
      } finally {
        await teardown()
      }
    })

    it('works with an injected real pool and never closes it', async () => {
      const prefix = nextPrefix()
      const pool = createPool(MYSQL_URL)
      try {
        const store = new MysqlStore({ pool, tablePrefix: prefix })
        await store.start()
        await store.upsertChat({ id: 'c1', name: 'injected' })
        await store.stop()
        // Caller-owned pool keeps serving after stop().
        expect((await store.getChat('c1'))?.name).toBe('injected')
        const [rows] = await pool.query<RowDataPacket[]>('SELECT 1 AS one')
        expect(Number(rows[0]?.one)).toBe(1)
      } finally {
        await pool.end()
        await dropTables(prefix)
      }
    })
  })

  /* Message log ------------------------------------------------------------------ */

  describe('messages', () => {
    it('getMessagesByChat orders by timestamp (not insertion) and windows to the newest `limit`', async () => {
      const { store, teardown } = await makeStore()
      try {
        const order = [7, 2, 9, 0, 5, 1, 8, 3, 6, 4] // shuffled insertion
        for (const i of order) await store.saveMessage(msg('c', `m${i}`, `b${i}`, 1_700_000_000_000 + i * 1000))
        expect(bodies(await store.getMessagesByChat('c'))).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'])
        expect(bodies(await store.getMessagesByChat('c', 3))).toEqual(['b7', 'b8', 'b9'])
        expect(bodies(await store.getMessagesByChat('c', 1))).toEqual(['b9'])
        expect(await store.getMessagesByChat('c', 0)).toEqual([])
        expect(await store.getMessagesByChat('c', 500)).toHaveLength(10)
        expect(await store.getMessagesByChat('unknown')).toEqual([])

        // Re-saving (edit) with a newer timestamp moves the message to the end, without duplicating it.
        await store.saveMessage(msg('c', 'm0', 'b0 edited', 1_800_000_000_000))
        const after = await store.getMessagesByChat('c')
        expect(after).toHaveLength(10)
        expect(after.at(-1)?.body).toBe('b0 edited')
      } finally {
        await teardown()
      }
    })

    it('applies the default limit of 50', async () => {
      const { store, teardown } = await makeStore()
      try {
        for (let i = 0; i < 60; i++) await store.saveMessage(msg('c', `m${i}`, `b${i}`, 1000 + i))
        const win = await store.getMessagesByChat('c')
        expect(win).toHaveLength(50)
        expect(win[0]?.body).toBe('b10')
        expect(win.at(-1)?.body).toBe('b59')
      } finally {
        await teardown()
      }
    }, 30_000)

    it('maxMessagesPerChat trims the oldest rows per chat on the server', async () => {
      const { store, prefix, teardown } = await makeStore({ maxMessagesPerChat: 3 })
      try {
        for (let i = 0; i < 6; i++) await store.saveMessage(msg('c', `m${i}`, `b${i}`, 1000 + i))
        expect(bodies(await store.getMessagesByChat('c'))).toEqual(['b3', 'b4', 'b5'])
        expect(await rowCount(prefix, 'messages', 'chat_id = ?', ['c'])).toBe(3)

        // A late-arriving OLDER message is pruned immediately (cap is by timestamp, not arrival).
        await store.saveMessage(msg('c', 'late', 'late', 500))
        expect(bodies(await store.getMessagesByChat('c'))).toEqual(['b3', 'b4', 'b5'])
        expect(await store.getMessage({ id: 'late', chatId: 'c' })).toBeUndefined()

        // Re-saving an existing message does not count twice.
        await store.saveMessage(msg('c', 'm5', 'b5 edited', 1005))
        expect(bodies(await store.getMessagesByChat('c'))).toEqual(['b3', 'b4', 'b5 edited'])

        // Other chats have their own budget.
        await store.saveMessage(msg('other', 'o1', 'o1', 1))
        expect(bodies(await store.getMessagesByChat('other'))).toEqual(['o1'])
        expect(await rowCount(prefix, 'messages')).toBe(4)
      } finally {
        await teardown()
      }
    })

    it('deleteChat purges the whole message log of that chat only', async () => {
      const { store, prefix, teardown } = await makeStore()
      try {
        for (let i = 0; i < 5; i++) await store.saveMessage(msg('gone', `g${i}`, `g${i}`, i))
        await store.saveMessage(msg('stays', 's1', 's1', 1))
        await store.saveMessage(msg('no-record', 'n1', 'n1', 1))
        await store.upsertChat({ id: 'gone', name: 'Gone' })
        await store.upsertChat({ id: 'stays', name: 'Stays' })

        await store.deleteChat('gone')
        expect(await rowCount(prefix, 'messages', 'chat_id = ?', ['gone'])).toBe(0)
        expect(await store.getChat('gone')).toBeUndefined()
        expect(await store.getMessage({ id: 'g0', chatId: 'gone' })).toBeUndefined()
        expect(bodies(await store.getMessagesByChat('stays'))).toEqual(['s1'])
        expect((await store.listChats()).map((c) => c.id)).toEqual(['stays'])

        // A chat with messages but no chat record is purged too.
        await store.deleteChat('no-record')
        expect(await store.getMessagesByChat('no-record')).toEqual([])
        expect(await rowCount(prefix, 'messages')).toBe(1)
      } finally {
        await teardown()
      }
    })

    it('concurrent saveMessage calls on the same chat all land (no lost writes, no deadlocks)', async () => {
      const { store, teardown } = await makeStore()
      try {
        const n = 120
        await Promise.all(Array.from({ length: n }, (_, i) => store.saveMessage(msg('hot', `m${i}`, `b${i}`, 10_000 + i))))
        const all = await store.getMessagesByChat('hot', n + 10)
        expect(all).toHaveLength(n)
        expect(bodies(all)).toEqual(Array.from({ length: n }, (_, i) => `b${i}`))
      } finally {
        await teardown()
      }
    }, 30_000)

    it('concurrent saveMessage calls with maxMessagesPerChat converge to the newest N', async () => {
      const { store, prefix, teardown } = await makeStore({ maxMessagesPerChat: 10 })
      try {
        for (let round = 0; round < 3; round++) {
          const base = round * 1000
          const n = 150
          await Promise.all(
            Array.from({ length: n }, (_, i) => store.saveMessage(msg('hot', `r${round}m${i}`, `r${round}b${i}`, 100_000 + base + i))),
          )
          expect(bodies(await store.getMessagesByChat('hot', 100))).toEqual(
            Array.from({ length: 10 }, (_, k) => `r${round}b${n - 10 + k}`),
          )
          expect(await rowCount(prefix, 'messages', 'chat_id = ?', ['hot'])).toBe(10)
        }
      } finally {
        await teardown()
      }
    }, 60_000)
  })

  /* Chats / contacts merge ---------------------------------------------------------- */

  describe('upsert merge', () => {
    it('upsertChat / upsertContact merge shallowly (nested objects are replaced, not deep-merged)', async () => {
      const { store, teardown } = await makeStore()
      try {
        await store.upsertChat({ id: 'c', name: 'Group', kind: 'group', raw: { a: 1, nested: { x: 1, y: 2 } } })
        await store.upsertChat({ id: 'c', updatedAt: 5, raw: { nested: { z: 3 } } })
        expect(await store.getChat('c')).toEqual({ id: 'c', name: 'Group', kind: 'group', updatedAt: 5, raw: { nested: { z: 3 } } })

        await store.upsertContact({ id: 'u', name: 'Ana', username: 'ana', phoneNumber: '+1', raw: { tags: ['a', 'b'] } })
        await store.upsertContact({ id: 'u', name: 'Ana B.', raw: { tags: ['c'] } })
        expect(await store.getContact('u')).toEqual({ id: 'u', name: 'Ana B.', username: 'ana', phoneNumber: '+1', raw: { tags: ['c'] } })

        // Merging does not leak between records.
        await store.upsertContact({ id: 'v' })
        expect(await store.getContact('v')).toEqual({ id: 'v' })
      } finally {
        await teardown()
      }
    })
  })

  /* Encoding / JSON fidelity ------------------------------------------------------------ */

  describe('unicode and JSON values', () => {
    it('round-trips emoji, CJK, RTL and combining text in ids, keys and documents', async () => {
      const { store, teardown } = await makeStore()
      try {
        const text = 'hola 👋🏽 👨‍👩‍👧‍👦 中文 العربية ñandú é (e\u0301) 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 "quotes" \\back\\slash\n\ttab'
        const chatId = 'chat-😀-中文'
        await store.saveMessage(msg(chatId, 'msg-🎉', text, 1))
        await store.upsertChat({ id: chatId, name: text })
        await store.upsertContact({ id: 'user-ñ-👤', name: text })
        await store.setCheckpoint('cp-🔑', { flowId: 'flujo-ñ', step: 1, state: { text, 'key.with.dots': 1, $dollar: true }, updatedAt: 1 })
        await store.setConversation('conv-💬', [{ role: 'user', content: text }])
        await store.setCursor('cur-⏱', text)

        expect((await store.getMessage({ id: 'msg-🎉', chatId }))?.body).toBe(text)
        expect(bodies(await store.getMessagesByChat(chatId))).toEqual([text])
        expect((await store.getChat(chatId))?.name).toBe(text)
        expect((await store.getContact('user-ñ-👤'))?.name).toBe(text)
        expect((await store.getCheckpoint('cp-🔑'))?.state).toEqual({ text, 'key.with.dots': 1, $dollar: true })
        expect(await store.getConversation('conv-💬')).toEqual([{ role: 'user', content: text }])
        expect(await store.getCursor('cur-⏱')).toBe(text)
        expect((await store.listCheckpoints()).map(([k]) => k)).toEqual(['cp-🔑'])
      } finally {
        await teardown()
      }
    })

    it('round-trips large and structurally rich JSON documents', async () => {
      const { store, teardown } = await makeStore()
      try {
        const big = 'x'.repeat(4 * 1024 * 1024) + '😀' // ~4 MB body
        let deep: Record<string, unknown> = { leaf: true }
        for (let i = 0; i < 40; i++) deep = { level: i, child: deep }
        const raw = {
          ints: [0, -1, 1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER],
          floats: [0.1, -2.5, 1e-7, 1.7976931348623157e308],
          misc: [null, true, false, '', {}, []],
          rows: Array.from({ length: 5000 }, (_, i) => ({ i, s: `row-${i}`, ok: i % 2 === 0 })),
          deep,
        }
        const m = msg('big', 'b1', big, 1_700_000_000_000, { raw })
        await store.saveMessage(m)
        const got = await store.getMessage({ id: 'b1', chatId: 'big' })
        expect(got?.body?.length).toBe(big.length)
        expect(got?.body).toBe(big)
        expect(got?.raw).toEqual(raw)
        expect(got?.timestamp).toBe(1_700_000_000_000)
        expect(typeof got?.timestamp).toBe('number') // never a BIGINT string

        const longConvo: AIMessage[] = Array.from({ length: 2000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'y'.repeat(200)}` }))
        await store.setConversation('long', longConvo)
        expect(await store.getConversation('long')).toEqual(longConvo)
      } finally {
        await teardown()
      }
    }, 60_000)

    // Regression: MySQL's JSON type rejects unpaired UTF-16 surrogates
    // (ER_INVALID_JSON_TEXT "The surrogate pair in string is invalid"), so a
    // truncated emoji made saveMessage throw. They are now stored as U+FFFD —
    // the same thing the UTF-8 based stores (redis/mongo/sqlite) end up with.
    it('stores strings with lone surrogates instead of rejecting them (U+FFFD)', async () => {
      const { store, teardown } = await makeStore()
      try {
        const truncated = 'cut emoji \uD83D' // high surrogate without its pair
        const orphanLow = '\uDE00 orphan low'
        await expect(store.saveMessage(msg('c', 'm1', truncated, 1, { raw: { note: orphanLow } }))).resolves.toBeUndefined()
        const got = await store.getMessage({ id: 'm1', chatId: 'c' })
        expect(got?.body).toBe('cut emoji \uFFFD')
        expect(got?.raw).toEqual({ note: '\uFFFD orphan low' })

        await store.upsertChat({ id: 'c', name: truncated })
        expect((await store.getChat('c'))?.name).toBe('cut emoji \uFFFD')
        await store.upsertContact({ id: 'u', name: orphanLow })
        expect((await store.getContact('u'))?.name).toBe('\uFFFD orphan low')
        await store.setConversation('k', [{ role: 'assistant', content: truncated }])
        expect(await store.getConversation('k')).toEqual([{ role: 'assistant', content: 'cut emoji \uFFFD' }])
        await store.setCheckpoint('k', { flowId: 'f', step: 1, state: { v: truncated }, updatedAt: 1 })
        expect((await store.getCheckpoint('k'))?.state).toEqual({ v: 'cut emoji \uFFFD' })

        // Well-formed pairs and escape-looking literal text are left untouched.
        const fine = 'pair 😀 and literal \\ud83d text'
        await store.saveMessage(msg('c', 'm2', fine, 2))
        expect((await store.getMessage({ id: 'm2', chatId: 'c' }))?.body).toBe(fine)
      } finally {
        await teardown()
      }
    })
  })

  /* Opaque identifiers --------------------------------------------------------------------- */

  describe('opaque ids', () => {
    // Regression: id/key columns used the server default collation
    // (utf8mb4_0900_ai_ci on MySQL 8 — case- AND accent-insensitive), so
    // 'abc'/'ABC' or 'e'/'é' collapsed into ONE row. IDs are opaque strings
    // and must compare byte-for-byte.
    it('treats ids differing only in case, accents or trailing spaces as distinct', async () => {
      const { store, teardown } = await makeStore()
      try {
        const ids = ['abc', 'ABC', 'Abc', 'e', 'é', 'E', 'ss', 'ß', 'k', 'k ']
        for (const id of ids) {
          await store.upsertChat({ id, name: `chat ${id}` })
          await store.upsertContact({ id, name: `contact ${id}` })
          await store.saveMessage(msg(id, id, `msg ${id}`, 1))
          await store.setCheckpoint(id, { flowId: `flow ${id}`, step: 1, state: {}, updatedAt: 1 })
          await store.setConversation(id, [{ role: 'user', content: `conv ${id}` }])
          await store.setCursor(id, `cursor ${id}`)
        }
        for (const id of ids) {
          expect((await store.getChat(id))?.name).toBe(`chat ${id}`)
          expect((await store.getContact(id))?.name).toBe(`contact ${id}`)
          expect((await store.getMessage({ id, chatId: id }))?.body).toBe(`msg ${id}`)
          expect(bodies(await store.getMessagesByChat(id))).toEqual([`msg ${id}`])
          expect((await store.getCheckpoint(id))?.flowId).toBe(`flow ${id}`)
          expect(await store.getConversation(id)).toEqual([{ role: 'user', content: `conv ${id}` }])
          expect(await store.getCursor(id)).toBe(`cursor ${id}`)
        }
        expect(await store.listChats()).toHaveLength(ids.length)
        expect(await store.listContacts()).toHaveLength(ids.length)
        const keys = (await store.listCheckpoints()).map(([k]) => k)
        expect(keys.every((k) => typeof k === 'string')).toBe(true)
        expect(keys.sort()).toEqual([...ids].sort())

        // Deleting one variant leaves the others alone.
        await store.deleteChat('ABC')
        expect(await store.getChat('ABC')).toBeUndefined()
        expect((await store.getChat('abc'))?.name).toBe('chat abc')
        expect(bodies(await store.getMessagesByChat('abc'))).toEqual(['msg abc'])
        await store.clearCheckpoint('é')
        expect((await store.getCheckpoint('e'))?.flowId).toBe('flow e')
      } finally {
        await teardown()
      }
    }, 30_000)

    // Regression: VARCHAR(255) keys rejected longer ids with ER_DATA_TOO_LONG.
    // Message rows are keyed by `${chatId}:${messageId}`, and long provider
    // ids (e.g. base64 Instagram/Messenger mids) or composed checkpoint keys
    // can exceed 255 characters.
    it('accepts ids and keys longer than 255 characters', async () => {
      const { store, teardown } = await makeStore()
      try {
        const chatId = `chat:${'c'.repeat(300)}`
        const id = `mid.${'A1b2'.repeat(150)}` // 604 chars
        await store.saveMessage(msg(chatId, id, 'long', 1))
        expect((await store.getMessage({ id, chatId }))?.body).toBe('long')
        expect(bodies(await store.getMessagesByChat(chatId))).toEqual(['long'])
        await store.upsertChat({ id: chatId, name: 'long chat' })
        expect((await store.getChat(chatId))?.name).toBe('long chat')
        const key = `tenant:bot:${chatId}:${'p'.repeat(200)}:flow`
        await store.setCheckpoint(key, { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
        expect(await store.listCheckpoints()).toEqual([[key, { flowId: 'f', step: 1, state: {}, updatedAt: 1 }]])
        await store.deleteChat(chatId)
        expect(await store.getMessagesByChat(chatId)).toEqual([])
      } finally {
        await teardown()
      }
    })
  })
})

/**
 * The regressions above, pinned WITHOUT a server so `pnpm test` keeps guarding
 * them even when BOTWA_TEST_MYSQL_URL is unset. They assert what the store
 * sends to / accepts from the driver; the real-server suite proves MySQL
 * agrees.
 */
describe('MysqlStore — real-server regressions (hermetic pins)', () => {
  it('provisions byte-exact VARBINARY keys and the chat_ts index (no collation-dependent VARCHAR keys)', async () => {
    const fake = new FakePool()
    const store = new MysqlStore({ pool: fake })
    await store.start()
    const ddl = fake.queries.map((q) => q.sql).filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS'))
    expect(ddl).toHaveLength(7)
    for (const sql of ddl) {
      expect(sql).not.toMatch(/VARCHAR/i)
      expect(sql).toMatch(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4$/)
    }
    // The six state tables key on one id; user_data (ctx.user) on a composite VARBINARY key.
    const stateDdl = ddl.filter((s) => !s.includes('user_data'))
    expect(stateDdl).toHaveLength(6)
    for (const sql of stateDdl) expect(sql).toMatch(/(id|`key`) VARBINARY\(1024\) NOT NULL PRIMARY KEY/)
    const userDataDdl = ddl.find((s) => s.includes('user_data'))
    expect(userDataDdl).toMatch(/user_id VARBINARY\(1024\) NOT NULL/)
    expect(userDataDdl).toMatch(/PRIMARY KEY \(user_id, namespace, `key`\)/)
    const messagesDdl = ddl.find((s) => s.includes('`messages`'))
    expect(messagesDdl).toMatch(/chat_id VARBINARY\(1024\) NOT NULL/)
    expect(messagesDdl).toMatch(/KEY chat_ts \(chat_id, timestamp\)/)
  })

  it('serializes lone surrogates as U+FFFD (MySQL JSON rejects them) and leaves literal escapes alone', async () => {
    const fake = new FakePool()
    const store = new MysqlStore({ pool: fake })
    await store.start()
    await store.saveMessage(msg('c', 'm1', 'cut \uD83D|\uDE00| pair 😀 | literal \\ud83d', 1, { raw: { ['k\uD83D']: 1 } }))
    const insert = fake.queries.find((q) => q.sql.startsWith('INSERT INTO `messages`'))
    const json = String(insert?.params?.[3])
    // No real \udXXX escape survives (an escaped backslash followed by "ud83d" is literal text).
    expect(json.replace(/\\\\/g, '')).not.toMatch(/\\u[dD][89a-fA-F]/)
    const got = await store.getMessage({ id: 'm1', chatId: 'c' })
    expect(got?.body).toBe('cut \uFFFD|\uFFFD| pair 😀 | literal \\ud83d')
    expect(got?.raw).toEqual({ 'k\uFFFD': 1 })
  })

  it('decodes VARBINARY keys (returned by mysql2 as Buffers) back to strings', async () => {
    const cp: FlowCheckpoint = { flowId: 'f', step: 1, state: {}, updatedAt: 1 }
    const pool: PoolLike = {
      async query(sql: string): Promise<MysqlQueryResult> {
        if (sql.startsWith('SELECT `key`, cp FROM')) return [[{ key: Buffer.from('chat-😀:ñ', 'utf8'), cp }], []]
        return [[], []]
      },
      async end() {},
    }
    const store = new MysqlStore({ pool })
    await store.start()
    expect(await store.listCheckpoints()).toEqual([['chat-😀:ñ', cp]])
  })
})
