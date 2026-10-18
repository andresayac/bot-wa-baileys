/**
 * PostgresStore — integration tests against a REAL PostgreSQL server.
 *
 * Opt-in: the whole file is skipped unless `BOTWA_TEST_POSTGRES_URL` is set, so
 * the default `pnpm test` stays hermetic (no network). Locally:
 *
 *   docker run -d --name botwa-it-postgres -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=botwa -p 55432:5432 postgres:16-alpine
 *   BOTWA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55432/botwa \
 *     pnpm --filter @bot-wa/postgres-store test
 *
 * Isolation: every run gets a random table-prefix namespace (`it<hex>_`) and
 * every store built here a unique sub-prefix, so reruns and parallel CI jobs
 * against one database never collide. All tables of the run are dropped in
 * `afterAll`.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import pg from 'pg'
import { MemoryStore, type FlowCheckpoint, type StoredChat, type StoredContact, type StoredMessage } from '@bot-wa/core'
import { PostgresStore, type PostgresStoreOptions } from '../src/PostgresStore.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

const URL = process.env.BOTWA_TEST_POSTGRES_URL

/** U+FFFD REPLACEMENT CHARACTER (what jsonb-unsafe characters are stored as). */
const FFFD = String.fromCharCode(0xfffd)

const TABLES = ['messages', 'chats', 'contacts', 'checkpoints', 'conversations', 'cursors', 'user_data'] as const

const msg = (chatId: string, id: string, body: string, ts: number, extra?: Partial<StoredMessage>): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false, ...extra,
})

/** One-field partial updates, each touching a DIFFERENT top-level field. */
const CHAT_PARTIALS: Array<Omit<StoredChat, 'id'>> = [
  { tenantId: 't' }, { environmentId: 'e' }, { botId: 'b' }, { providerId: 'p' }, { connectionId: 'c' },
  { kind: 'group' }, { lastMessageAt: 1 }, { updatedAt: 2 }, { raw: { r: 1 } },
]
const CONTACT_PARTIALS: Array<Omit<StoredContact, 'id'>> = [
  { tenantId: 't' }, { environmentId: 'e' }, { botId: 'b' }, { providerId: 'p' }, { connectionId: 'c' },
  { username: 'u' }, { phoneNumber: '+1' }, { updatedAt: 2 }, { raw: { r: 1 } },
]

/** Fisher-Yates with a fixed LCG seed — deterministic "random" insertion order. */
function shuffled<T>(items: T[], seed = 42): T[] {
  const out = [...items]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe.skipIf(!URL)('PostgresStore — real PostgreSQL integration', () => {
  const connectionString = URL as string
  /** Namespace shared by every table this run creates (dropped in afterAll). */
  const runPrefix = `it${randomBytes(4).toString('hex')}_`
  let seq = 0
  let admin: pg.Pool
  /** Stores opened by a test; stopped in afterEach even when the test fails. */
  const open: PostgresStore[] = []

  const nextPrefix = (): string => `${runPrefix}${++seq}_`

  const prefixes = new WeakMap<PostgresStore, string>()
  const prefixOf = (store: PostgresStore): string => prefixes.get(store) as string

  /** A fresh store on its own pool + unique tables (not started). */
  function makeStore(opts: PostgresStoreOptions = {}): PostgresStore {
    const tablePrefix = opts.tablePrefix ?? nextPrefix()
    const store = new PostgresStore({ connectionString, ...opts, tablePrefix })
    prefixes.set(store, tablePrefix)
    open.push(store)
    return store
  }

  async function count(table: string, where = 'TRUE', values: unknown[] = []): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, values)
    return Number(rows[0].n)
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString, max: 2 })
    await admin.query('SELECT 1') // fail fast with a clear connection error
  })

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.stop()))
  })

  afterAll(async () => {
    if (!admin) return
    try {
      const { rows } = await admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND starts_with(tablename, $1)`,
        [runPrefix],
      )
      for (const { tablename } of rows) await admin.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`)
    } finally {
      await admin.end()
    }
  })

  /* (a) Shared IStore contract against the real server ------------------------ */

  runStoreConformance('PostgresStore (real PostgreSQL)', {
    async make() {
      const store = new PostgresStore({ connectionString, tablePrefix: nextPrefix() })
      await store.start()
      return { store, teardown: () => store.stop() }
    },
  })

  runUserDataConformance('PostgresStore (real PostgreSQL)', {
    async make() {
      const store = new PostgresStore({ connectionString, tablePrefix: nextPrefix() })
      await store.start()
      return { store, teardown: () => store.stop() }
    },
  })

  describe('user data (ctx.user)', () => {
    it('stores values exactly: U+0000, lone surrogates and U+FFFD round-trip unchanged (TEXT, not JSONB)', async () => {
      const store = makeStore()
      await store.start()
      const value = {
        nul: 'a\u0000b', lone: 'x\ud83d', low: '\udc00y', ok: '👍', fffd: FFFD,
        literal: '\\u0000 is text', 'k\u0000': 1, nested: [{ v: '\u0000\ud800' }],
      }
      await store.setUserData({ userId: 'u', namespace: 'default', key: 'k', value, updatedAt: 1 })
      expect((await store.getUserData('u', 'default', 'k'))?.value).toEqual(value)
      expect((await store.listUserData('u'))[0]?.value).toEqual(value)
      for (const s of ['\u0000', 'a\ud83d', '\udfff', '\u0000\u0000\u0000']) {
        await store.setUserData({ userId: 'u', namespace: 'default', key: 's', value: s, updatedAt: 1 })
        expect((await store.getUserData('u', 'default', 's'))?.value).toBe(s)
      }
    })

    it('a raw U+0000 cannot live in a PostgreSQL TEXT value; its JSON escape can (why values are JSON text)', async () => {
      await expect(admin.query('SELECT $1::text AS v', ['a\u0000b'])).rejects.toMatchObject({ code: '22021' })
      const { rows } = await admin.query<{ v: string }>('SELECT $1::text AS v', [JSON.stringify('a\u0000b')])
      expect(rows[0].v).toBe('"a\\u0000b"')
      expect(JSON.parse(rows[0].v)).toBe('a\u0000b')
    })
  })

  /* (b) Store-specific behaviour ---------------------------------------------- */

  describe('schema', () => {
    it('creates the seven tables and the (chat_id, timestamp) index', async () => {
      const store = makeStore()
      await store.start()
      const prefix = prefixOf(store)
      const { rows: tables } = await admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND starts_with(tablename, $1)`,
        [prefix],
      )
      expect(tables.map((t) => t.tablename).sort()).toEqual(TABLES.map((t) => `${prefix}${t}`).sort())
      const { rows: idx } = await admin.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`,
        [`${prefix}messages_chat_ts_idx`],
      )
      expect(idx).toHaveLength(1)
      expect(idx[0].indexdef).toMatch(/\(chat_id, "?timestamp"?\)/)
    })

    it('schema creation is idempotent: start twice, restart, and a second instance on the same tables', async () => {
      const prefix = nextPrefix()
      const a = makeStore({ tablePrefix: prefix })
      await a.start()
      await a.start() // no-op while started
      await a.saveMessage(msg('c@x', 'm1', 'kept', 1))
      await a.stop()
      await a.start() // fresh pool + full idempotent schema pass over existing tables
      const b = makeStore({ tablePrefix: prefix })
      await b.start() // another instance: CREATE ... IF NOT EXISTS over existing objects
      expect((await b.getMessage({ id: 'm1', chatId: 'c@x' }))?.body).toBe('kept')
      expect((await a.getMessagesByChat('c@x')).map((m) => m.body)).toEqual(['kept'])
    })

    it('replicas booting at the same time on fresh tables all start cleanly', async () => {
      // Concurrent `CREATE TABLE IF NOT EXISTS` of the same table can race on
      // PostgreSQL's catalog (unique violation on pg_type). start() must
      // survive it — this is exactly "N replicas deploy at once".
      const prefix = nextPrefix()
      const replicas = Array.from({ length: 6 }, () => makeStore({ tablePrefix: prefix }))
      const results = await Promise.allSettled(replicas.map((r) => r.start()))
      expect(results.filter((r) => r.status === 'rejected')).toEqual([])
      await replicas[0].upsertChat({ id: 'c1', name: 'shared' })
      expect((await replicas[5].getChat('c1'))?.name).toBe('shared')
    })

    it('tablePrefix isolates two stores sharing one database', async () => {
      const a = makeStore()
      const b = makeStore()
      await Promise.all([a.start(), b.start()])
      await a.saveMessage(msg('c1', 'm1', 'only in a', 5))
      await a.upsertChat({ id: 'c1', name: 'A' })
      await a.setCursor('k', '1')
      expect(await b.getChat('c1')).toBeUndefined()
      expect(await b.getMessagesByChat('c1')).toEqual([])
      expect(await b.getCursor('k')).toBeUndefined()
    })
  })

  describe('lifecycle and persistence', () => {
    it('everything survives stop() and a brand-new store/pool on the same tables', async () => {
      const prefix = nextPrefix()
      const first = makeStore({ tablePrefix: prefix })
      await first.start()
      const m = msg('chat@x', 'm1', 'persisted', 1_700_000_000_000, { raw: { nested: { ok: true } } })
      const cp: FlowCheckpoint = { flowId: 'register', step: 2, state: { name: 'Ana', opts: [1, 2] }, updatedAt: 3 }
      const convo = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'hello' }]
      await first.saveMessage(m)
      await first.upsertChat({ id: 'chat@x', name: 'Chat', kind: 'group' })
      await first.upsertContact({ id: 'u@x', name: 'Alice', phoneNumber: '+1' })
      await first.setCheckpoint('u@x', cp)
      await first.setConversation('chat@x', convo)
      await first.setCursor('tg:updates', '4242')
      await first.stop()

      const second = makeStore({ tablePrefix: prefix })
      await second.start()
      expect(await second.getMessage({ id: 'm1', chatId: 'chat@x' })).toEqual(m)
      expect(await second.getChat('chat@x')).toEqual({ id: 'chat@x', name: 'Chat', kind: 'group' })
      expect(await second.getContact('u@x')).toEqual({ id: 'u@x', name: 'Alice', phoneNumber: '+1' })
      expect(await second.getCheckpoint('u@x')).toEqual(cp)
      expect(await second.listCheckpoints()).toEqual([['u@x', cp]])
      expect(await second.getConversation('chat@x')).toEqual(convo)
      expect(await second.getCursor('tg:updates')).toBe('4242')
    })

    it('rejects calls after stop() on an own-pool store (no silent reconnect)', async () => {
      const store = makeStore()
      await store.start()
      await store.stop()
      await expect(store.getChat('x')).rejects.toThrow(/start/)
    })

    it('works with an injected real pg.Pool and never ends it', async () => {
      const pool = new pg.Pool({ connectionString, max: 2 })
      try {
        const store = new PostgresStore({ pool, tablePrefix: nextPrefix() })
        await store.start()
        await store.upsertChat({ id: 'c1', name: 'injected' })
        await store.stop()
        expect(pool.ended).toBe(false)
        const { rows } = await pool.query('SELECT 1 AS one')
        expect(rows[0].one).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })

  describe('messages', () => {
    it('returns the window oldest→newest by timestamp, whatever the insertion order', async () => {
      const store = makeStore()
      await store.start()
      // Numeric (BIGINT) ordering, not lexicographic: 9 < 10 < 100 < epoch-ms.
      const stamps = [9, 10, 100, 1_000, 99_999, 1_700_000_000_000, 1_700_000_000_001, 2_000_000_000_000]
      for (const ts of shuffled(stamps)) await store.saveMessage(msg('c@x', `m${ts}`, `t${ts}`, ts))
      expect((await store.getMessagesByChat('c@x')).map((m) => m.timestamp)).toEqual(stamps)
      expect((await store.getMessagesByChat('c@x', 3)).map((m) => m.timestamp)).toEqual(stamps.slice(-3))
      expect((await store.getMessagesByChat('c@x', 1)).map((m) => m.timestamp)).toEqual([2_000_000_000_000])
      expect(await store.getMessagesByChat('c@x', 100)).toHaveLength(stamps.length)
      expect(await store.getMessagesByChat('c@x', 0)).toEqual([])
      expect(await store.getMessagesByChat('nobody@x')).toEqual([])
      // Timestamps come back as numbers (from the JSONB doc), never BIGINT strings.
      for (const m of await store.getMessagesByChat('c@x')) expect(typeof m.timestamp).toBe('number')
    })

    it('defaults to the latest 50 messages', async () => {
      const store = makeStore()
      await store.start()
      for (let i = 0; i < 60; i++) await store.saveMessage(msg('c@x', `m${i}`, `msg ${i}`, 1_000 + i))
      const win = await store.getMessagesByChat('c@x')
      expect(win).toHaveLength(50)
      expect(win[0].body).toBe('msg 10')
      expect(win[49].body).toBe('msg 59')
    })

    it('re-saving a ref updates it in place and re-sorts it by its new timestamp', async () => {
      const store = makeStore()
      await store.start()
      await store.saveMessage(msg('c@x', 'a', 'a v1', 1))
      await store.saveMessage(msg('c@x', 'b', 'b', 2))
      await store.saveMessage(msg('c@x', 'a', 'a v2', 3, { status: 'delivered' }))
      const all = await store.getMessagesByChat('c@x')
      expect(all.map((m) => m.body)).toEqual(['b', 'a v2'])
      expect(all[1].status).toBe('delivered')
    })

    it('message ids are namespaced per chat (same id in two chats)', async () => {
      const store = makeStore()
      await store.start()
      await store.saveMessage(msg('a@x', 'same', 'in a', 1))
      await store.saveMessage(msg('b@x', 'same', 'in b', 2))
      expect((await store.getMessage({ id: 'same', chatId: 'a@x' }))?.body).toBe('in a')
      expect((await store.getMessage({ id: 'same', chatId: 'b@x' }))?.body).toBe('in b')
      await store.deleteMessage({ id: 'same', chatId: 'a@x' })
      expect(await store.getMessage({ id: 'same', chatId: 'a@x' })).toBeUndefined()
      expect((await store.getMessage({ id: 'same', chatId: 'b@x' }))?.body).toBe('in b')
    })

    it('accepts fractional timestamps (BIGINT sort key) and keeps the exact value in the document', async () => {
      // Regression: `timestamp` is a JS number; a non-integer used to be sent
      // verbatim to the BIGINT column and real PostgreSQL rejected the insert
      // (22P02 invalid input syntax for type bigint).
      const store = makeStore()
      await store.start()
      await store.saveMessage(msg('c@x', 'late', 'late', 1_700_000_000_001.75))
      await store.saveMessage(msg('c@x', 'early', 'early', 1_700_000_000_000.25))
      const all = await store.getMessagesByChat('c@x')
      expect(all.map((m) => m.body)).toEqual(['early', 'late'])
      expect(all.map((m) => m.timestamp)).toEqual([1_700_000_000_000.25, 1_700_000_000_001.75])
    })
  })

  describe('maxMessagesPerChat', () => {
    it('prunes the oldest rows by timestamp beyond the cap, per chat', async () => {
      const store = makeStore({ maxMessagesPerChat: 3 })
      await store.start()
      const t = `${prefixOf(store)}messages`
      // Out-of-order arrival: the cap keeps the newest by TIMESTAMP, not by insertion.
      for (const ts of [5, 1, 6, 2, 4, 3]) await store.saveMessage(msg('c@x', `m${ts}`, `msg ${ts}`, ts))
      expect((await store.getMessagesByChat('c@x')).map((m) => m.body)).toEqual(['msg 4', 'msg 5', 'msg 6'])
      expect(await count(t, 'chat_id = $1', ['c@x'])).toBe(3)
      expect(await store.getMessage({ id: 'm1', chatId: 'c@x' })).toBeUndefined()
      // Other chats are untouched by this chat's trimming.
      await store.saveMessage(msg('other@x', 'o1', 'keep', 0))
      expect(await store.getMessagesByChat('other@x')).toHaveLength(1)
      expect(await count(t)).toBe(4)
    })

    it('timestamp ties: the window shows exactly the rows the cap keeps (id tie-break)', async () => {
      const capped = makeStore({ maxMessagesPerChat: 2 })
      await capped.start()
      for (const id of ['m3', 'm1', 'm4', 'm2']) await capped.saveMessage(msg('c@x', id, id, 7))
      expect((await capped.getMessagesByChat('c@x')).map((m) => m.ref.id)).toEqual(['m3', 'm4'])
      const store = makeStore()
      await store.start()
      for (const id of ['x3', 'x1', 'x4', 'x2']) await store.saveMessage(msg('d@x', id, id, 7))
      expect((await store.getMessagesByChat('d@x', 2)).map((m) => m.ref.id)).toEqual(['x3', 'x4'])
    })

    it('a cap of 1 keeps only the newest message', async () => {
      const store = makeStore({ maxMessagesPerChat: 1 })
      await store.start()
      for (let i = 0; i < 4; i++) await store.saveMessage(msg('c@x', `m${i}`, `msg ${i}`, 10 + i))
      expect((await store.getMessagesByChat('c@x')).map((m) => m.body)).toEqual(['msg 3'])
    })
  })

  describe('deleteChat', () => {
    it('removes the chat record and purges its whole message log from the table', async () => {
      const store = makeStore()
      await store.start()
      const t = `${prefixOf(store)}messages`
      for (let i = 0; i < 5; i++) await store.saveMessage(msg('gone@x', `g${i}`, 'x', i))
      await store.saveMessage(msg('stays@x', 's1', 'y', 1))
      await store.upsertChat({ id: 'gone@x', name: 'Gone' })
      await store.upsertChat({ id: 'stays@x', name: 'Stays' })
      await store.deleteChat('gone@x')
      expect(await count(t, 'chat_id = $1', ['gone@x'])).toBe(0)
      expect(await store.getMessage({ id: 'g0', chatId: 'gone@x' })).toBeUndefined()
      expect(await store.getChat('gone@x')).toBeUndefined()
      expect(await store.getMessagesByChat('stays@x')).toHaveLength(1)
      expect((await store.listChats()).map((c) => c.id)).toEqual(['stays@x'])
      await store.deleteChat('never-existed@x') // no-op, no throw
    })
  })

  describe('upsertChat / upsertContact', () => {
    it('shallow-merges: top-level fields are kept, a nested object is replaced (not deep-merged)', async () => {
      const store = makeStore()
      await store.start()
      await store.upsertChat({ id: 'c@x', name: 'Group', kind: 'group', raw: { a: 1, b: 2 } })
      await store.upsertChat({ id: 'c@x', updatedAt: 5, raw: { b: 3 } })
      expect(await store.getChat('c@x')).toEqual({ id: 'c@x', name: 'Group', kind: 'group', updatedAt: 5, raw: { b: 3 } })

      await store.upsertContact({ id: 'u@x', name: 'Alice', phoneNumber: '+1', raw: { x: [1, 2] } })
      await store.upsertContact({ id: 'u@x', username: 'alice', raw: { y: true } })
      expect(await store.getContact('u@x')).toEqual({
        id: 'u@x', name: 'Alice', phoneNumber: '+1', username: 'alice', raw: { y: true },
      })
    })

    it('matches MemoryStore merge semantics exactly, including keys explicitly set to undefined', async () => {
      // `{ ...existing, ...patch }`: an explicit `undefined` removes the field.
      const store = makeStore()
      await store.start()
      const reference = new MemoryStore()
      const steps: StoredChat[] = [
        { id: 'c@x', name: 'Group', kind: 'group', lastMessageAt: 1 },
        { id: 'c@x', name: undefined, updatedAt: 2 },
        { id: 'c@x', kind: undefined, raw: { a: 1 } },
        { id: 'c@x', name: 'Back' },
      ]
      for (const step of steps) {
        await store.upsertChat(step)
        await reference.upsertChat(step)
        expect(await store.getChat('c@x')).toEqual(await reference.getChat('c@x'))
      }
      expect(await store.getChat('c@x')).toEqual({ id: 'c@x', name: 'Back', lastMessageAt: 1, updatedAt: 2, raw: { a: 1 } })

      await store.upsertContact({ id: 'u@x', name: 'Alice', username: 'alice' })
      await store.upsertContact({ id: 'u@x', username: undefined })
      expect(await store.getContact('u@x')).toEqual({ id: 'u@x', name: 'Alice' })
    })

    it('concurrent partial upserts of the same id never lose each other\'s fields', async () => {
      // Regression: the merge was read-modify-write in JS, so two concurrent
      // partial upserts (two replicas, or overlapping provider events) each
      // read the old record and the last write silently dropped the other's
      // fields. The merge now happens atomically in SQL (jsonb `||`).
      const store = makeStore()
      await store.start()
      for (let round = 0; round < 5; round++) {
        const id = `c${round}@x`
        await store.upsertChat({ id, name: 'base' })
        await store.upsertContact({ id, name: 'base' })
        // Each call sets ONE distinct field; all of them must survive.
        await Promise.all([
          ...CHAT_PARTIALS.map((p) => store.upsertChat({ id, ...p })),
          ...CONTACT_PARTIALS.map((p) => store.upsertContact({ id, ...p })),
        ])
        expect(await store.getChat(id)).toEqual({ id, name: 'base', ...Object.assign({}, ...CHAT_PARTIALS) })
        expect(await store.getContact(id)).toEqual({ id, name: 'base', ...Object.assign({}, ...CONTACT_PARTIALS) })
      }
    })

    it('concurrent first-time upserts of a brand-new id merge too', async () => {
      const store = makeStore()
      await store.start()
      for (let round = 0; round < 5; round++) {
        const id = `new${round}@x`
        await Promise.all(CHAT_PARTIALS.map((p) => store.upsertChat({ id, ...p })))
        expect(await store.getChat(id)).toEqual({ id, ...Object.assign({}, ...CHAT_PARTIALS) })
      }
    })
  })

  describe('unicode and large values', () => {
    it('round-trips emoji, ZWJ/skin-tone sequences, CJK, RTL and combining marks in ids, keys and values', async () => {
      const store = makeStore()
      await store.start()
      const text = '👋🏽 hola ñandú — 中文 · العربية · עברית · e\u0301 · 👨‍👩‍👧‍👦 · 🏳️‍🌈 · \u200b\u2028\u2029 "q" \\ \n\t'
      const chatId = 'chat-💬-ñ@x'
      const m = msg(chatId, 'id-🔥', text, 1, { raw: { 'clé-🔑': text, list: ['😀', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'] } })
      await store.saveMessage(m)
      expect(await store.getMessage({ id: 'id-🔥', chatId })).toEqual(m)
      expect(await store.getMessagesByChat(chatId)).toEqual([m])

      await store.upsertChat({ id: chatId, name: text })
      expect((await store.getChat(chatId))?.name).toBe(text)
      await store.upsertContact({ id: 'usuario-😀', name: 'José 👩‍💻' })
      expect((await store.getContact('usuario-😀'))?.name).toBe('José 👩‍💻')
      const cp: FlowCheckpoint = { flowId: 'flujo-🌮', step: 1, state: { 'nombre-✨': text }, updatedAt: 1 }
      await store.setCheckpoint(`${chatId}:usuario-😀`, cp)
      expect(await store.getCheckpoint(`${chatId}:usuario-😀`)).toEqual(cp)
      await store.setConversation(chatId, [{ role: 'user', content: text }])
      expect(await store.getConversation(chatId)).toEqual([{ role: 'user', content: text }])
      await store.setCursor('cursor-🧭', 'valor-✅')
      expect(await store.getCursor('cursor-🧭')).toBe('valor-✅')
    })

    it('stores strings PostgreSQL JSONB cannot hold (U+0000, lone surrogates) instead of throwing', async () => {
      // Regression: JSONB rejects the \u0000 escape (22P05) and unpaired UTF-16
      // surrogates (22P02), so one such character anywhere in a message body or
      // raw payload (e.g. text truncated mid-emoji) made saveMessage throw.
      // They are now replaced with U+FFFD; everything else is preserved.
      const store = makeStore()
      await store.start()
      const truncatedEmoji = 'ok 👋'.slice(0, -1) // ends in a lone high surrogate
      const m = msg('c@x', 'm1', `a\u0000b ${truncatedEmoji}`, 1, {
        raw: { ['k\u0000ey']: '\udc00x', nested: [{ v: 'y\u0000' }], fine: '👋 \\u0000 literal' },
      })
      await store.saveMessage(m)
      const got = await store.getMessage({ id: 'm1', chatId: 'c@x' })
      expect(got?.body).toBe(`a${FFFD}b ok ${FFFD}`)
      expect(got?.raw).toEqual({ [`k${FFFD}ey`]: `${FFFD}x`, nested: [{ v: `y${FFFD}` }], fine: '👋 \\u0000 literal' })

      await store.upsertChat({ id: 'c@x', name: 'n\u0000' })
      expect((await store.getChat('c@x'))?.name).toBe(`n${FFFD}`)
      await store.upsertContact({ id: 'u@x', name: '\ud83d' })
      expect((await store.getContact('u@x'))?.name).toBe(FFFD)
      await store.setCheckpoint('k', { flowId: 'f', step: 0, state: { s: '\u0000' }, updatedAt: 1 })
      expect((await store.getCheckpoint('k'))?.state).toEqual({ s: FFFD })
      await store.setConversation('k', [{ role: 'user', content: 'x\u0000' }])
      expect(await store.getConversation('k')).toEqual([{ role: 'user', content: `x${FFFD}` }])
    })

    it('round-trips large JSON documents (multi-MB body, deep nesting, big arrays)', async () => {
      const store = makeStore()
      await store.start()
      const bigBody = '🙂abcdefghij'.repeat(200_000) // ~2.4M UTF-16 units, ~2.6 MB UTF-8
      let deep: Record<string, unknown> = { leaf: 'bottom' }
      for (let i = 0; i < 200; i++) deep = { [`level${i}`]: deep }
      const raw = {
        deep,
        items: Array.from({ length: 20_000 }, (_, i) => ({ i, s: `item-${i}`, f: i / 3, b: i % 2 === 0, n: null })),
        numbers: [0, 1, -1, 0.1 + 0.2, 1e-7, 1.7976931348623157e308, 5e-324, Number.MAX_SAFE_INTEGER],
      }
      const m = msg('big@x', 'big', bigBody, 1, { raw })
      await store.saveMessage(m)
      const got = await store.getMessage({ id: 'big', chatId: 'big@x' })
      expect(got?.body?.length).toBe(bigBody.length)
      expect(got).toEqual(m)

      const history = Array.from({ length: 2_000 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `turn ${i} ${'x'.repeat(500)}`,
      }))
      await store.setConversation('long', history)
      expect(await store.getConversation('long')).toEqual(history)

      const cp: FlowCheckpoint = { flowId: 'big', step: 1, state: { blob: bigBody.slice(0, 500_000), raw }, updatedAt: 1 }
      await store.setCheckpoint('big', cp)
      expect(await store.getCheckpoint('big')).toEqual(cp)
    }, 60_000)
  })

  describe('concurrency', () => {
    it('concurrent saveMessage calls on the same chat all land, in timestamp order', async () => {
      const store = makeStore()
      await store.start()
      const N = 100
      const stamps = shuffled(Array.from({ length: N }, (_, i) => 1_000 + i), 7)
      await Promise.all(stamps.map((ts) => store.saveMessage(msg('hot@x', `m${ts}`, `msg ${ts}`, ts))))
      const all = await store.getMessagesByChat('hot@x', N)
      expect(all).toHaveLength(N)
      expect(all.map((m) => m.timestamp)).toEqual([...stamps].sort((a, b) => a - b))
    })

    it('concurrent saves with maxMessagesPerChat converge on exactly the newest N (no deadlock, no over-pruning)', async () => {
      const cap = 10
      const store = makeStore({ maxMessagesPerChat: cap })
      await store.start()
      const t = `${prefixOf(store)}messages`
      for (let round = 0; round < 3; round++) {
        const base = round * 1_000
        const stamps = shuffled(Array.from({ length: 60 }, (_, i) => base + i), round + 1)
        const results = await Promise.allSettled(
          stamps.map((ts) => store.saveMessage(msg('hot@x', `r${round}m${ts}`, `msg ${ts}`, ts))),
        )
        expect(results.filter((r) => r.status === 'rejected')).toEqual([])
        expect(await count(t, 'chat_id = $1', ['hot@x'])).toBe(cap)
        expect((await store.getMessagesByChat('hot@x', 100)).map((m) => m.timestamp)).toEqual(
          Array.from({ length: cap }, (_, i) => base + 50 + i),
        )
      }
    })

    it('concurrent re-saves of the same ref leave exactly one row', async () => {
      const store = makeStore()
      await store.start()
      await Promise.all(Array.from({ length: 30 }, (_, i) => store.saveMessage(msg('c@x', 'same', `v${i}`, i))))
      const all = await store.getMessagesByChat('c@x')
      expect(all).toHaveLength(1)
      expect(all[0].body).toMatch(/^v\d+$/)
    })
  })
})
