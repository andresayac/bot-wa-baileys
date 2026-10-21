/**
 * MongoStore — integration tests against a REAL MongoDB server.
 *
 * The unit tests run against an in-memory fake that pattern-matches the
 * commands MongoStore sends; this file executes them on a real `mongod` to
 * catch what the fake cannot (BSON coercions, `limit(0)` semantics, index
 * creation, concurrency, document size limits).
 *
 * Skipped unless BOTWA_TEST_MONGO_URL is set, so the default `pnpm test` stays
 * hermetic. Locally:
 *
 *   docker run -d --name botwa-it-mongo -p 57017:27017 mongo:7
 *   BOTWA_TEST_MONGO_URL=mongodb://127.0.0.1:57017 pnpm --filter @botmesh/mongo-store test
 *
 * Isolation: each run uses its own database (`botwa_it_<random>`, dropped in
 * afterAll) and every store instance inside it gets a unique collection
 * prefix, so reruns and parallel CI jobs never collide.
 */
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryStore } from '@botmesh/core'
import { legacyMessageKey, type FlowCheckpoint, type IStore, type StoredChat, type StoredContact, type StoredMessage } from '@botmesh/core'
import { MongoStore } from '../src/MongoStore.js'
import type { MongoStoreOptions } from '../src/MongoStore.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

const MONGO_URL = process.env.BOTWA_TEST_MONGO_URL
const DB_NAME = `botwa_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`

const msg = (chatId: string, id: string, body: string, ts: number, extra: Partial<StoredMessage> = {}): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false, ...extra,
})

/** Every path inside `value` that holds `null` (BSON turns `undefined` into null unless told otherwise). */
function nullPaths(value: unknown, path = '$'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) return value.flatMap((v, i) => nullPaths(v, `${path}[${i}]`))
  if (typeof value === 'object' && value !== undefined && !(value instanceof Uint8Array)) {
    return Object.entries(value).flatMap(([k, v]) => nullPaths(v, `${path}.${k}`))
  }
  return []
}

describe.skipIf(!MONGO_URL)('MongoStore — real MongoDB integration', () => {
  let client: MongoClient
  let prefixSeq = 0
  const nextPrefix = (): string => `t${++prefixSeq}_`

  /** A started store on the shared (injected) client, isolated by a fresh prefix. */
  async function makeStore(opts: Partial<MongoStoreOptions> = {}): Promise<{ store: MongoStore; prefix: string }> {
    const prefix = opts.collectionPrefix ?? nextPrefix()
    const store = new MongoStore({ client, dbName: DB_NAME, ...opts, collectionPrefix: prefix })
    await store.start()
    return { store, prefix }
  }

  const collection = (prefix: string, name: string) => client.db(DB_NAME).collection<{ _id: string }>(`${prefix}${name}`)

  beforeAll(async () => {
    // Fail fast on a wrong URL instead of hanging for the driver's 30 s default.
    client = new MongoClient(MONGO_URL ?? '', { serverSelectionTimeoutMS: 5_000 })
    await client.connect()
  })

  afterAll(async () => {
    if (!client) return
    try {
      await client.db(DB_NAME).dropDatabase()
    } finally {
      await client.close()
    }
  })

  /* Shared IStore contract ------------------------------------------------- */

  runStoreConformance('MongoStore (real MongoDB)', {
    async make() {
      const { store, prefix } = await makeStore()
      // A message document exactly as older versions wrote it (unescaped key).
      const seedLegacyMessage = async (m: StoredMessage): Promise<void> => {
        await client.db(DB_NAME).collection<{ _id: string; chatId: string; timestamp: number; msg: StoredMessage }>(`${prefix}messages`)
          .insertOne({ _id: legacyMessageKey(m.ref), chatId: m.chatId, timestamp: m.timestamp, msg: m })
      }
      return { store, teardown: () => store.stop(), seedLegacyMessage }
    },
  })

  runUserDataConformance('MongoStore (real MongoDB)', {
    async make() {
      const { store } = await makeStore()
      return { store, teardown: () => store.stop() }
    },
  })

  describe('user data (ctx.user)', () => {
    it('purges expired documents in batches of purgeBatchSize on the server', async () => {
      const { store } = await makeStore({ purgeBatchSize: 2 })
      const now = Date.now()
      for (let i = 0; i < 5; i++) {
        await store.setUserData({ userId: `u${i}`, namespace: 'g', key: 'old', value: i, expiresAt: now - i, updatedAt: now })
      }
      await store.setUserData({ userId: 'u0', namespace: 'g', key: 'live', value: 1, expiresAt: now + 60_000, updatedAt: now })
      expect(await store.purgeExpiredUserData(now)).toBe(5)
      expect((await store.listUserData('u0')).map((e) => e.key)).toEqual(['live'])
      expect(await store.purgeExpiredUserData(now)).toBe(0)
      await store.stop()
    })

    it('keys with $ and dots, and values with U+0000 or lone surrogates, round-trip exactly', async () => {
      const { store, prefix } = await makeStore()
      const value = { $where: 1, 'a.b': 'a\u0000b', lone: 'x\ud83d' }
      await store.setUserData({ userId: 'u.$x', namespace: 'n.s', key: '$k', value, updatedAt: 1 })
      expect((await store.getUserData('u.$x', 'n.s', '$k'))?.value).toEqual(value)
      const raw = await collection(prefix, 'user_data').findOne({})
      expect(nullPaths(raw)).toEqual(['$.expiresAt']) // only the explicit "no expiry" marker
      await store.stop()
    })
  })

  /* Schema / indexes ------------------------------------------------------- */

  describe('schema and indexes', () => {
    it('start() creates the {chatId, timestamp, _id} index and is idempotent', async () => {
      const { store, prefix } = await makeStore()
      await store.start() // same instance again
      const second = new MongoStore({ client, dbName: DB_NAME, collectionPrefix: prefix })
      await second.start() // another replica booting against the same collections

      const indexes = await collection(prefix, 'messages').listIndexes().toArray()
      expect(indexes.map((i) => i.key).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
        .toEqual([{ _id: 1 }, { chatId: 1, timestamp: 1, _id: 1 }])
    })

    it('the per-chat window query is served by the compound index', async () => {
      const { store, prefix } = await makeStore()
      for (let i = 0; i < 3; i++) await store.saveMessage(msg('c@x', `m${i}`, `b${i}`, 100 + i))
      // Same query shape as getMessagesByChat.
      const plan = await collection(prefix, 'messages').find({ chatId: 'c@x' }).sort({ timestamp: -1, _id: -1 }).limit(2).explain()
      expect(JSON.stringify(plan)).toContain('chatId_1_timestamp_1__id_1')
      expect(JSON.stringify(plan)).not.toContain('"SORT"') // served in index order, no in-memory sort
    })
  })

  /* Lifecycle / persistence ------------------------------------------------ */

  describe('persistence across stop()/start()', () => {
    it('data written through one own-client store is read back by a fresh client', async () => {
      const prefix = nextPrefix()
      const cp: FlowCheckpoint = { flowId: 'reg', step: 3, state: { name: 'Ana', tags: ['a', 'b'] }, updatedAt: 1_760_000_000_000 }

      const first = new MongoStore({ url: MONGO_URL, dbName: DB_NAME, collectionPrefix: prefix })
      await first.start()
      await first.saveMessage(msg('c@x', 'm1', 'persisted', 1_760_000_000_001))
      await first.upsertChat({ id: 'c@x', name: 'Chat', kind: 'group' })
      await first.upsertContact({ id: 'u@x', name: 'Ana', phoneNumber: '+57300' })
      await first.setCheckpoint('u@x', cp)
      await first.setConversation('c@x', [{ role: 'user', content: 'hola' }])
      await first.setCursor('tg:updates', '9001')
      await first.stop()

      const second = new MongoStore({ url: MONGO_URL, dbName: DB_NAME, collectionPrefix: prefix })
      await second.start()
      try {
        expect((await second.getMessage({ id: 'm1', chatId: 'c@x' }))?.body).toBe('persisted')
        expect(await second.getChat('c@x')).toEqual({ id: 'c@x', name: 'Chat', kind: 'group' })
        expect(await second.getContact('u@x')).toEqual({ id: 'u@x', name: 'Ana', phoneNumber: '+57300' })
        expect(await second.getCheckpoint('u@x')).toEqual(cp)
        expect(await second.listCheckpoints()).toEqual([['u@x', cp]])
        expect(await second.getConversation('c@x')).toEqual([{ role: 'user', content: 'hola' }])
        expect(await second.getCursor('tg:updates')).toBe('9001')
      } finally {
        await second.stop()
      }
    })

    it('the same own-client store instance can be restarted after stop()', async () => {
      const store = new MongoStore({ url: MONGO_URL, dbName: DB_NAME, collectionPrefix: nextPrefix() })
      await store.start()
      await store.upsertChat({ id: 'c@x', name: 'before' })
      await store.stop()
      await store.start()
      try {
        expect((await store.getChat('c@x'))?.name).toBe('before')
      } finally {
        await store.stop()
      }
    })

    it('stop() leaves an injected client open and usable', async () => {
      const { store } = await makeStore()
      await store.stop()
      expect((await client.db(DB_NAME).command({ ping: 1 })).ok).toBe(1)
      // The store keeps working because its (caller-owned) client is still open.
      await store.setCursor('k', 'v')
      expect(await store.getCursor('k')).toBe('v')
    })
  })

  /* maxMessagesPerChat ----------------------------------------------------- */

  describe('maxMessagesPerChat', () => {
    it('trims each chat to its newest N messages, independently per chat', async () => {
      const { store, prefix } = await makeStore({ maxMessagesPerChat: 3 })
      for (let i = 0; i < 6; i++) await store.saveMessage(msg('a@x', `a${i}`, `a${i}`, 1000 + i))
      await store.saveMessage(msg('b@x', 'b0', 'b0', 1))

      expect((await store.getMessagesByChat('a@x')).map((m) => m.body)).toEqual(['a3', 'a4', 'a5'])
      expect(await collection(prefix, 'messages').countDocuments({ chatId: 'a@x' })).toBe(3)
      expect(await store.getMessage({ id: 'a0', chatId: 'a@x' })).toBeUndefined()
      expect(await store.getMessagesByChat('b@x')).toHaveLength(1)
    })

    it('trims by timestamp, not insertion order (a late, older message is evicted at once)', async () => {
      const { store } = await makeStore({ maxMessagesPerChat: 2 })
      await store.saveMessage(msg('c@x', 'new1', 'new1', 200))
      await store.saveMessage(msg('c@x', 'new2', 'new2', 300))
      await store.saveMessage(msg('c@x', 'late-old', 'late-old', 100))
      expect((await store.getMessagesByChat('c@x')).map((m) => m.body)).toEqual(['new1', 'new2'])
    })

    it('re-saving an existing message (status update) does not evict anything', async () => {
      const { store } = await makeStore({ maxMessagesPerChat: 3 })
      for (let i = 0; i < 3; i++) await store.saveMessage(msg('c@x', `m${i}`, `m${i}`, 10 + i))
      await store.saveMessage(msg('c@x', 'm0', 'm0', 10, { status: 'read' }))
      const kept = await store.getMessagesByChat('c@x')
      expect(kept.map((m) => m.ref.id)).toEqual(['m0', 'm1', 'm2'])
      expect(kept[0].status).toBe('read')
    })
  })

  /* deleteChat ------------------------------------------------------------- */

  describe('deleteChat', () => {
    it('purges the chat document and every message of that chat, nothing else', async () => {
      const { store, prefix } = await makeStore()
      for (let i = 0; i < 5; i++) await store.saveMessage(msg('gone@x', `g${i}`, 'x', i))
      await store.saveMessage(msg('stays@x', 's1', 'y', 1))
      await store.upsertChat({ id: 'gone@x', name: 'Gone' })
      await store.upsertChat({ id: 'stays@x', name: 'Stays' })
      await store.upsertContact({ id: 'gone@x', name: 'Same id as the chat' })

      await store.deleteChat('gone@x')

      expect(await collection(prefix, 'messages').countDocuments({ chatId: 'gone@x' })).toBe(0)
      expect(await collection(prefix, 'messages').countDocuments({ chatId: 'stays@x' })).toBe(1)
      expect(await store.getChat('gone@x')).toBeUndefined()
      expect((await store.listChats()).map((c) => c.id)).toEqual(['stays@x'])
      expect((await store.getContact('gone@x'))?.name).toBe('Same id as the chat')
      // Deleting a chat that does not exist is a no-op.
      await expect(store.deleteChat('never@x')).resolves.toBeUndefined()
    })
  })

  /* upsertChat / upsertContact merge -------------------------------------- */

  describe('upsertChat / upsertContact shallow merge', () => {
    it('merges top-level fields and replaces nested objects wholesale (shallow, like MemoryStore)', async () => {
      const { store } = await makeStore()
      const memory = new MemoryStore({ autoSaveInterval: 0 })
      for (const s of [store, memory] as IStore[]) {
        await s.upsertChat({ id: 'c@x', name: 'Group', kind: 'group', raw: { a: 1, b: { deep: true } } })
        await s.upsertChat({ id: 'c@x', lastMessageAt: 5, raw: { c: 3 } })
        await s.upsertContact({ id: 'u@x', name: 'Alice', username: 'alice', raw: { x: 1 } })
        await s.upsertContact({ id: 'u@x', phoneNumber: '+1', raw: { y: 2 } })
      }
      const chat = await store.getChat('c@x')
      expect(chat).toEqual({ id: 'c@x', name: 'Group', kind: 'group', lastMessageAt: 5, raw: { c: 3 } })
      expect(chat).toEqual(await memory.getChat('c@x'))
      expect(await store.getContact('u@x')).toEqual(await memory.getContact('u@x'))
      expect(await store.getContact('u@x')).toEqual({ id: 'u@x', name: 'Alice', username: 'alice', phoneNumber: '+1', raw: { y: 2 } })
      // The storage key never leaks into the returned shape.
      expect((await store.listChats()).every((c) => !('_id' in c))).toBe(true)
      expect((await store.listContacts()).every((c) => !('_id' in c))).toBe(true)
    })

    // Regression: the driver serializes `undefined` as BSON null by default, so
    // `upsertChat({ id, name: undefined })` (what Bot.handleInbound sends when a
    // chat has no name) stored `name: null` and getChat() returned it.
    it('an explicit undefined field clears it, exactly like MemoryStore — never null', async () => {
      const { store } = await makeStore()
      const memory = new MemoryStore({ autoSaveInterval: 0 })
      const chatPatch: StoredChat = { id: 'c@x', name: undefined, raw: undefined, updatedAt: 2 }
      const contactPatch: StoredContact = { id: 'u@x', name: undefined, username: 'kept-new', raw: undefined }
      for (const s of [store, memory] as IStore[]) {
        await s.upsertChat({ id: 'c@x', name: 'Named', kind: 'dm', raw: { platform: 1 } })
        await s.upsertChat(chatPatch)
        await s.upsertContact({ id: 'u@x', name: 'Alice', username: 'alice', raw: { p: 1 } })
        await s.upsertContact(contactPatch)
        await s.upsertChat({ id: 'fresh@x', name: undefined, kind: 'group' }) // insert path
      }
      for (const id of ['c@x', 'fresh@x']) {
        const got = await store.getChat(id)
        expect(nullPaths(got)).toEqual([])
        expect(got).toEqual(await memory.getChat(id))
      }
      expect(await store.getChat('c@x')).toEqual({ id: 'c@x', kind: 'dm', updatedAt: 2 })
      const contact = await store.getContact('u@x')
      expect(nullPaths(contact)).toEqual([])
      expect(contact).toEqual(await memory.getContact('u@x'))
      expect(contact).toEqual({ id: 'u@x', username: 'kept-new' })
    })

    it('concurrent partial upserts of the same chat never lose an update', async () => {
      const { store } = await makeStore()
      await Promise.all([
        store.upsertChat({ id: 'race@x', name: 'n' }),
        store.upsertChat({ id: 'race@x', kind: 'group' }),
        store.upsertChat({ id: 'race@x', lastMessageAt: 1 }),
        store.upsertChat({ id: 'race@x', updatedAt: 2 }),
        store.upsertChat({ id: 'race@x', botId: 'b' }),
        store.upsertChat({ id: 'race@x', tenantId: 't' }),
        store.upsertContact({ id: 'race@x', name: 'n' }),
        store.upsertContact({ id: 'race@x', username: 'u' }),
        store.upsertContact({ id: 'race@x', phoneNumber: 'p' }),
      ])
      expect(await store.getChat('race@x')).toEqual({
        id: 'race@x', name: 'n', kind: 'group', lastMessageAt: 1, updatedAt: 2, botId: 'b', tenantId: 't',
      })
      expect(await store.getContact('race@x')).toEqual({ id: 'race@x', name: 'n', username: 'u', phoneNumber: 'p' })
      expect(await store.listChats()).toHaveLength(1)
    })
  })

  /* Value fidelity --------------------------------------------------------- */

  describe('value fidelity (unicode, large JSON, BSON types)', () => {
    // Regression: optional fields left `undefined` (body, quoted, raw — Bot
    // builds StoredMessage that way) came back as `null`, breaking
    // `=== undefined` checks and re-saves that spread the stored message.
    it('a message with undefined optional fields round-trips without nulls', async () => {
      const { store } = await makeStore()
      const input = msg('c@x', 'm1', 'x', 1, {
        body: undefined,
        quoted: undefined,
        raw: { keep: 1, drop: undefined, nested: { gone: undefined, list: [1, 2] } },
        error: undefined,
        ref: { id: 'm1', chatId: 'c@x', native: undefined },
      })
      await store.saveMessage(input)
      const got = await store.getMessage({ id: 'm1', chatId: 'c@x' })
      expect(nullPaths(got)).toEqual([])
      expect(got).toEqual(input)
      expect(got && 'body' in got).toBe(false)
      const [listed] = await store.getMessagesByChat('c@x')
      expect(nullPaths(listed)).toEqual([])

      await store.setCheckpoint('k', { flowId: 'f', step: 1, state: { a: undefined, b: 1 }, updatedAt: 1 })
      expect(await store.getCheckpoint('k')).toEqual({ flowId: 'f', step: 1, state: { b: 1 }, updatedAt: 1 })
      expect(nullPaths(await store.getCheckpoint('k'))).toEqual([])
    })

    it('round-trips unicode and emoji in ids, keys and values', async () => {
      const { store } = await makeStore()
      const chatId = '🤖 grupo:ñandú@x'
      const body = 'Hola 👋🏽 👨‍👩‍👧‍👦 🇨🇴 你好 مرحبا é 𝄞 \u0000 tab\tnl\n"quote" \\ end'
      await store.saveMessage(msg(chatId, 'id-💬-1', body, 1))
      await store.saveMessage(msg(chatId, 'id-💬-2', '✅', 2))
      expect((await store.getMessage({ id: 'id-💬-1', chatId }))?.body).toBe(body)
      expect((await store.getMessagesByChat(chatId)).map((m) => m.body)).toEqual([body, '✅'])

      await store.upsertChat({ id: chatId, name: 'Familia 👨‍👩‍👧' })
      await store.upsertContact({ id: 'usuario-ñ@x', name: 'José 🎉', username: 'жора' })
      expect((await store.getChat(chatId))?.name).toBe('Familia 👨‍👩‍👧')
      expect(await store.getContact('usuario-ñ@x')).toEqual({ id: 'usuario-ñ@x', name: 'José 🎉', username: 'жора' })

      // Keys a user may well put in flow state: emails (dots), "$" prefixes, emoji.
      const state = { 'user@mail.com': 1, 'a.b': { 'c.d': 2 }, $price: 3, nested: { $gt: 4 }, '🔑': 'valor 🔒', '': 'empty key' }
      await store.setCheckpoint('cp:😀', { flowId: 'flujo-ñ', step: 1, state, updatedAt: 1 })
      expect((await store.getCheckpoint('cp:😀'))?.state).toEqual(state)
      await store.setCursor('cursor:🧭', '🧭')
      expect(await store.getCursor('cursor:🧭')).toBe('🧭')
    })

    it('keeps JS number fidelity (epoch-ms timestamps, floats, safe-integer edges)', async () => {
      const { store } = await makeStore()
      const ts = 1_760_000_000_123
      await store.saveMessage(msg('c@x', 'm1', 'x', ts))
      const got = await store.getMessage({ id: 'm1', chatId: 'c@x' })
      expect(typeof got?.timestamp).toBe('number')
      expect(got?.timestamp).toBe(ts)
      const state = { max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER, float: 0.1 + 0.2, int32: 2_147_483_647, neg: -5 }
      await store.setCheckpoint('n', { flowId: 'f', step: 2_147_483_648, state, updatedAt: ts })
      const cp = await store.getCheckpoint('n')
      expect(cp).toEqual({ flowId: 'f', step: 2_147_483_648, state, updatedAt: ts })
      for (const v of Object.values(cp?.state ?? {})) expect(typeof v).toBe('number')
    })

    // Regression: Buffer/Uint8Array inside `raw` came back as the driver's BSON
    // `Binary` class (a driver type leaking through IStore) instead of bytes.
    it('returns binary payloads inside raw as Buffers, not BSON Binary', async () => {
      const { store } = await makeStore()
      const bytes = Buffer.from([0, 1, 2, 250, 255])
      await store.saveMessage(msg('c@x', 'm1', 'x', 1, { raw: { mediaKey: bytes, u8: new Uint8Array([7, 8, 9]) } }))
      const raw = (await store.getMessage({ id: 'm1', chatId: 'c@x' }))?.raw as { mediaKey: unknown; u8: unknown }
      expect(Buffer.isBuffer(raw.mediaKey)).toBe(true)
      expect(Buffer.compare(raw.mediaKey as Buffer, bytes)).toBe(0)
      expect(raw.u8).toBeInstanceOf(Uint8Array)
      expect([...(raw.u8 as Uint8Array)]).toEqual([7, 8, 9])
      const [listed] = await store.getMessagesByChat('c@x')
      expect(Buffer.isBuffer((listed.raw as { mediaKey: unknown }).mediaKey)).toBe(true)

      await store.upsertChat({ id: 'c@x', raw: { avatar: Buffer.from('png') } })
      const chatRaw = (await store.getChat('c@x'))?.raw as { avatar: unknown }
      expect(Buffer.isBuffer(chatRaw.avatar)).toBe(true)
      expect((await store.listChats()).every((c) => Buffer.isBuffer((c.raw as { avatar: unknown }).avatar))).toBe(true)
    })

    it('round-trips large JSON values (MB-sized history, deep and wide state)', async () => {
      const { store } = await makeStore()
      const history = Array.from({ length: 2_000 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `turno ${i} ${'ñ🙂'.repeat(200)}`,
      }))
      await store.setConversation('big', history)
      expect(await store.getConversation('big')).toEqual(history)

      let deep: Record<string, unknown> = { leaf: 'fondo' }
      for (let i = 0; i < 60; i++) deep = { level: i, child: deep }
      const state = { deep, wide: Array.from({ length: 10_000 }, (_, i) => ({ i, s: `v${i}` })) }
      await store.setCheckpoint('big', { flowId: 'f', step: 1, state, updatedAt: 1 })
      expect((await store.getCheckpoint('big'))?.state).toEqual(state)

      const rawText = 'x'.repeat(4 * 1024 * 1024)
      await store.saveMessage(msg('c@x', 'big', 'b', 1, { raw: { rawText } }))
      expect(((await store.getMessage({ id: 'big', chatId: 'c@x' }))?.raw as { rawText: string }).rawText).toHaveLength(rawText.length)
    }, 30_000)

    it('rejects a value above the 16 MB BSON document limit and keeps the previous value', async () => {
      const { store } = await makeStore()
      await store.setConversation('k', [{ role: 'user', content: 'small' }])
      await expect(store.setConversation('k', [{ role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }])).rejects.toThrow()
      expect(await store.getConversation('k')).toEqual([{ role: 'user', content: 'small' }])
    }, 30_000)
  })

  /* getMessagesByChat ordering / limit ------------------------------------ */

  describe('getMessagesByChat ordering and limit', () => {
    it('orders by timestamp (not insertion order) and windows the newest N ascending', async () => {
      const { store } = await makeStore()
      for (const ts of [50, 10, 40, 20, 30]) await store.saveMessage(msg('c@x', `m${ts}`, `t${ts}`, ts))
      expect((await store.getMessagesByChat('c@x')).map((m) => m.body)).toEqual(['t10', 't20', 't30', 't40', 't50'])
      expect((await store.getMessagesByChat('c@x', 2)).map((m) => m.body)).toEqual(['t40', 't50'])
      expect((await store.getMessagesByChat('c@x', 1)).map((m) => m.body)).toEqual(['t50'])
      expect(await store.getMessagesByChat('c@x', 100)).toHaveLength(5)
      expect(await store.getMessagesByChat('c@x', 2_147_483_647)).toHaveLength(5) // Bot's "all" sentinel
      expect(await store.getMessagesByChat('nobody@x')).toEqual([])
    })

    it('defaults to the newest 50 messages', async () => {
      const { store } = await makeStore()
      for (let i = 0; i < 60; i++) await store.saveMessage(msg('c@x', `m${i}`, `b${i}`, 1000 + i))
      const page = await store.getMessagesByChat('c@x')
      expect(page).toHaveLength(50)
      expect(page[0].body).toBe('b10')
      expect(page[49].body).toBe('b59')
    })

    it('re-saving a message with a new timestamp moves it in the order', async () => {
      const { store } = await makeStore()
      await store.saveMessage(msg('c@x', 'a', 'a', 1))
      await store.saveMessage(msg('c@x', 'b', 'b', 2))
      await store.saveMessage(msg('c@x', 'a', 'a-edited', 3))
      expect((await store.getMessagesByChat('c@x')).map((m) => m.body)).toEqual(['b', 'a-edited'])
    })

    // Regression: MongoDB treats `limit(0)` as "no limit" and a negative limit
    // as its absolute value, so limit 0 returned the WHOLE chat log (the fake
    // and MemoryStore both return []).
    it('a non-positive limit returns no messages, like MemoryStore', async () => {
      const { store } = await makeStore()
      const memory = new MemoryStore({ autoSaveInterval: 0 })
      for (const s of [store, memory] as IStore[]) {
        for (let i = 0; i < 4; i++) await s.saveMessage(msg('c@x', `m${i}`, `b${i}`, 10 + i))
      }
      for (const limit of [0, -1, -3]) {
        expect(await store.getMessagesByChat('c@x', limit)).toEqual(await memory.getMessagesByChat('c@x', limit))
        expect(await store.getMessagesByChat('c@x', limit)).toEqual([])
      }
    })
  })

  /* Concurrency ------------------------------------------------------------ */

  describe('concurrent writes on the same chat', () => {
    it('keeps every one of many concurrent saveMessage calls, correctly ordered', async () => {
      const { store } = await makeStore()
      const n = 50
      await Promise.all(Array.from({ length: n }, (_, i) => store.saveMessage(msg('c@x', `m${i}`, `b${i}`, 1000 + i))))
      const all = await store.getMessagesByChat('c@x', 1_000)
      expect(all).toHaveLength(n)
      expect(all.map((m) => m.timestamp)).toEqual(Array.from({ length: n }, (_, i) => 1000 + i))
    })

    it('concurrent upserts of the same new message yield one document and no duplicate-key error', async () => {
      const { store, prefix } = await makeStore()
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.saveMessage(msg('c@x', 'same', `v${i}`, 1))))
      expect(await collection(prefix, 'messages').countDocuments({ chatId: 'c@x' })).toBe(1)
      expect((await store.getMessage({ id: 'same', chatId: 'c@x' }))?.body).toMatch(/^v\d+$/)
    })

    it('concurrent saves with maxMessagesPerChat converge to exactly the newest N', async () => {
      const { store, prefix } = await makeStore({ maxMessagesPerChat: 5 })
      const n = 40
      await Promise.all(Array.from({ length: n }, (_, i) => store.saveMessage(msg('c@x', `m${i}`, `b${i}`, 1000 + i))))
      expect(await collection(prefix, 'messages').countDocuments({ chatId: 'c@x' })).toBe(5)
      expect((await store.getMessagesByChat('c@x')).map((m) => m.timestamp)).toEqual([1035, 1036, 1037, 1038, 1039])
    })
  })
})
