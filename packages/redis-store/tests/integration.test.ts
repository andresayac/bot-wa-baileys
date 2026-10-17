/**
 * RedisStore — integration tests against a REAL Redis server.
 *
 * The hermetic suites (redis-store.test.ts, conformance.test.ts) run against an
 * in-memory fake; real Redis never executes them there. This file does, and it
 * also runs the fake's behaviour probes (redis-probes.ts) against the server so
 * the fake cannot drift from real Redis semantics.
 *
 * Skipped unless BOTWA_TEST_REDIS_URL is set, so `pnpm test` stays hermetic:
 *
 *   docker run -d --name botwa-it-redis -p 56379:6379 redis:7-alpine
 *   BOTWA_TEST_REDIS_URL=redis://localhost:56379 pnpm --filter @bot-wa/redis-store test
 *
 * Isolation: every store gets its own key prefix under a per-run namespace
 * (`botwa-it:<pid>-<uuid>:…`) and every key under that namespace is deleted
 * afterwards, so reruns and CI jobs sharing one server never collide. Nothing
 * outside the namespace is read or written (no FLUSHDB).
 */
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from 'redis'
import type { FlowCheckpoint, StoredMessage } from '@bot-wa/core'
import { RedisStore, type NativeRedisClient, type RedisLikeClient, type RedisStoreOptions } from '../src/index.js'
import { PROBES, meets, outcome } from './redis-probes.js'
import { runStoreConformance } from '../../../test-utils/store-conformance.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

const REDIS_URL = process.env.BOTWA_TEST_REDIS_URL
const RUN = `botwa-it:${process.pid}-${randomUUID().slice(0, 8)}`
let seq = 0
/** A fresh, collision-free key prefix inside this run's namespace. */
const nextPrefix = (tag: string): string => `${RUN}:${tag}${++seq}`

/** Escape Redis glob metacharacters so a prefix is matched literally (test-side helper). */
const globLiteral = (s: string): string => s.replace(/[*?[\]\\]/g, '\\$&')

const msg = (chatId: string, id: string, body: string, ts: number, extra: Partial<StoredMessage> = {}): StoredMessage => ({
  ref: { id, chatId }, chatId, senderId: chatId, timestamp: ts, type: 'text', body, fromMe: false, ...extra,
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Rejects when `p` has not settled within `ms` — turns a hang into a readable failure. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

interface TcpProxy {
  /** Redis URL that routes through the proxy. */
  url: string
  /** Destroy every live connection (simulates a network blip; new connections are accepted). */
  dropConnections(): void
  /** Stop listening and destroy every connection (simulates the server going away). */
  shutdown(): Promise<void>
}

/** Minimal TCP proxy in front of the real server, to cut connections on demand. */
async function startProxy(targetUrl: string): Promise<TcpProxy> {
  const target = new URL(targetUrl)
  const sockets = new Set<net.Socket>()
  const track = (s: net.Socket): void => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  }
  const server = net.createServer((down) => {
    const up = net.connect(Number(target.port || 6379), target.hostname)
    track(down)
    track(up)
    const kill = (): void => {
      down.destroy()
      up.destroy()
    }
    down.on('error', kill)
    up.on('error', kill)
    down.pipe(up).pipe(down)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  const auth = target.username || target.password ? `${target.username}:${target.password}@` : ''
  const dropConnections = (): void => {
    for (const s of sockets) s.destroy()
  }
  return {
    url: `${target.protocol}//${auth}127.0.0.1:${port}${target.pathname}`,
    dropConnections,
    shutdown: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        dropConnections()
      }),
  }
}

/** A TCP port on localhost with nothing listening (connections are refused). */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe.skipIf(!REDIS_URL)('RedisStore against a real Redis server', { timeout: 20_000 }, () => {
  const url = REDIS_URL as string
  let admin: NativeRedisClient
  /** Own-client stores opened by a test; stopped after each test even when it fails. */
  const opened: RedisStore[] = []

  /** A store that creates/owns its connection from the URL (the production path). */
  const own = (opts: Omit<RedisStoreOptions, 'client' | 'url'> & { url?: string } = {}): RedisStore => {
    const store = new RedisStore({ url, ...opts })
    opened.push(store)
    return store
  }
  const keysOf = (prefix: string): Promise<string[]> => admin.keys(`${globLiteral(prefix)}:*`)
  const clientIds = async (): Promise<Set<string>> => {
    const list = String(await admin.sendCommand(['CLIENT', 'LIST']))
    return new Set([...list.matchAll(/^id=(\d+)/gm)].map((m) => m[1]))
  }

  beforeAll(async () => {
    admin = createClient({ url })
    admin.on('error', () => {}) // the admin connection is never cut on purpose
    await admin.connect()
  })
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((s) => s.stop()))
  })
  afterAll(async () => {
    if (!admin?.isOpen) return
    const leftovers = await admin.keys(`${globLiteral(RUN)}*`)
    if (leftovers.length) await admin.del(leftovers)
    await admin.quit()
  })

  /* Shared IStore contract ------------------------------------------------ */

  describe('conformance — injected client', () => {
    runStoreConformance('RedisStore (real server, injected client)', {
      async make() {
        const store = new RedisStore({ client: admin, prefix: nextPrefix('conf-inj') })
        await store.start()
        return { store, teardown: () => store.stop() }
      },
    })

    runUserDataConformance('RedisStore (real server, injected client)', {
      async make() {
        const store = new RedisStore({ client: admin, prefix: nextPrefix('ud-inj') })
        await store.start()
        return { store, teardown: () => store.stop() }
      },
    })
  })

  describe('conformance — store-owned client', () => {
    runStoreConformance('RedisStore (real server, own client)', {
      async make() {
        const store = new RedisStore({ url, prefix: nextPrefix('conf-own') })
        await store.start()
        return { store, teardown: () => store.stop() }
      },
    })
  })

  /* The hermetic fake's expectations ------------------------------------- */

  describe('the in-memory fake models this server (shared probes)', () => {
    for (const probe of PROBES) {
      it(probe.name, async () => {
        const prefix = nextPrefix('probe')
        const actual = await outcome(probe, admin as unknown as RedisLikeClient, {
          k: (name) => `${prefix}:${name}`,
          ns: `${globLiteral(prefix)}:`,
        })
        expect(meets(actual, probe.expected), `got ${JSON.stringify(actual)}`).toBe(true)
      })
    }
  })

  /* Lifecycle ------------------------------------------------------------- */

  describe('user data (ctx.user)', () => {
    it('a glob-hostile prefix only scans its own user-data keys', async () => {
      const base = nextPrefix('ud-glob')
      const hostile = new RedisStore({ client: admin, prefix: `${base}[1]` })
      const neighbour = new RedisStore({ client: admin, prefix: `${base}1` })
      await hostile.start()
      await neighbour.start()
      await hostile.setUserData({ userId: 'u', namespace: 'default', key: 'a', value: 1, updatedAt: 1 })
      await neighbour.setUserData({ userId: 'u', namespace: 'default', key: 'b', value: 2, updatedAt: 1 })
      expect((await hostile.listUserData('u')).map((e) => e.key)).toEqual(['a'])
      await hostile.deleteUserData('u')
      expect((await neighbour.listUserData('u')).map((e) => e.key)).toEqual(['b'])
      expect(await hostile.listUserData('u')).toEqual([])
    })

    it('an entry with a fractional remaining TTL is written with an integer PX and expires natively', async () => {
      const prefix = nextPrefix('ud-px')
      const store = new RedisStore({ client: admin, prefix })
      await store.start()
      await store.setUserData({ userId: 'u', namespace: 'default', key: 'k', value: 1, updatedAt: 1, expiresAt: Date.now() + 150.5 })
      expect((await store.getUserData('u', 'default', 'k'))?.value).toBe(1)
      await new Promise((r) => setTimeout(r, 300))
      expect(await admin.keys(`${globLiteral(prefix)}:ud:*`)).toEqual([]) // Redis dropped it (PX), not just hidden
      expect(await store.listUserData('u')).toEqual([])
    })
  })

  describe('lifecycle', () => {
    it('start() is idempotent: repeated and concurrent starts open a single connection', async () => {
      const before = await clientIds()
      const store = own({ prefix: nextPrefix('idem') })
      await Promise.all([store.start(), store.start()])
      await store.start()
      await store.setCursor('k', 'v')
      expect(await store.getCursor('k')).toBe('v')
      const fresh = [...(await clientIds())].filter((id) => !before.has(id))
      expect(fresh).toHaveLength(1)
    })

    it('persists across stop() and a brand-new instance/connection', async () => {
      const prefix = nextPrefix('persist')
      const cp: FlowCheckpoint = { flowId: 'signup', step: 3, state: { name: 'Ana', tags: ['a', 'b'] }, updatedAt: 1_760_000_000_000 }
      const convo = [{ role: 'user' as const, content: 'hola' }, { role: 'assistant' as const, content: '¿qué tal?' }]

      const first = new RedisStore({ url, prefix })
      await first.start()
      await first.saveMessage(msg('c1', 'm1', 'one', 1_760_000_000_001))
      await first.saveMessage(msg('c1', 'm2', 'two', 1_760_000_000_002))
      await first.upsertChat({ id: 'c1', name: 'Chat 1', kind: 'group' })
      await first.upsertContact({ id: 'u1', name: 'Ana', phoneNumber: '+57 300' })
      await first.setCheckpoint('u1', cp)
      await first.setConversation('c1', convo)
      await first.setCursor('tg:updates', '4242')
      await first.stop()

      const second = own({ prefix })
      await second.start()
      expect((await second.getMessagesByChat('c1')).map((m) => m.body)).toEqual(['one', 'two'])
      expect(await second.getMessage({ chatId: 'c1', id: 'm2' })).toEqual(msg('c1', 'm2', 'two', 1_760_000_000_002))
      expect(await second.getChat('c1')).toEqual({ id: 'c1', name: 'Chat 1', kind: 'group' })
      expect(await second.getContact('u1')).toEqual({ id: 'u1', name: 'Ana', phoneNumber: '+57 300' })
      expect(await second.getCheckpoint('u1')).toEqual(cp)
      expect(await second.listCheckpoints()).toEqual([['u1', cp]])
      expect(await second.getConversation('c1')).toEqual(convo)
      expect(await second.getCursor('tg:updates')).toBe('4242')
    })

    it('the same instance can stop() and start() again; stop() twice is a quiet no-op', async () => {
      const error = vi.fn()
      const store = own({ prefix: nextPrefix('restart'), logger: { error } })
      await store.start()
      await store.setCursor('k', '1')
      await store.stop()
      await store.stop()
      await store.start()
      expect(await store.getCursor('k')).toBe('1')
      await store.stop()
      expect(error).not.toHaveBeenCalled()
    })

    it('never connects or quits an injected client', async () => {
      const store = new RedisStore({ client: admin, prefix: nextPrefix('inj') })
      await store.start()
      await store.stop()
      expect(admin.isOpen).toBe(true)
      expect(await admin.ping()).toBe('PONG')
    })

    it('start() rejects promptly when the server is unreachable, and a retry tries again', async () => {
      const error = vi.fn()
      const store = own({ url: `redis://127.0.0.1:${await closedPort()}`, prefix: nextPrefix('down'), logger: { error } })
      await expect(within(store.start(), 5_000, 'start()')).rejects.toThrow(/ECONNREFUSED/)
      // Not a silent no-op: the second attempt must actually reconnect (and fail again).
      await expect(within(store.start(), 5_000, 'start() retry')).rejects.toThrow(/ECONNREFUSED/)
      await within(store.stop(), 2_000, 'stop()')
    })

    it('survives a dropped connection: the error is logged (not thrown) and the store reconnects', async () => {
      const proxy = await startProxy(url)
      try {
        const error = vi.fn()
        const store = own({ url: proxy.url, prefix: nextPrefix('drop'), logger: { error } })
        await store.start()
        await store.setCursor('k', 'before')
        proxy.dropConnections()
        await vi.waitFor(() => expect(error).toHaveBeenCalled(), { timeout: 3_000 })
        expect(await within(store.getCursor('k'), 5_000, 'getCursor after reconnect')).toBe('before')
        await store.setCursor('k', 'after')
        expect(await store.getCursor('k')).toBe('after')
        await store.stop()
      } finally {
        await proxy.shutdown()
      }
    })

    it('stop() settles when the connection is cut right before it (QUIT reply never arrives)', async () => {
      const proxy = await startProxy(url)
      const store = own({ url: proxy.url, prefix: nextPrefix('cut'), logger: { error: () => {} } })
      await store.start()
      await store.setCursor('k', 'v')
      await proxy.shutdown() // the socket closes cleanly while stop() is sending QUIT
      await within(store.stop(), 5_000, 'stop() right after the connection was cut')
    })

    it('stop() resolves while the server is unreachable (does not wait for a reconnect)', async () => {
      const proxy = await startProxy(url)
      const error = vi.fn()
      const store = own({ url: proxy.url, prefix: nextPrefix('gone'), logger: { error } })
      await store.start()
      await store.setCursor('k', 'v')
      await proxy.shutdown()
      await vi.waitFor(() => expect(error).toHaveBeenCalled(), { timeout: 3_000 })
      await within(store.stop(), 2_000, 'stop() while unreachable')
    })
  })

  /* Message log ----------------------------------------------------------- */

  describe('message log', () => {
    it('getMessagesByChat returns the newest `limit` oldest→newest, whatever the insert order', async () => {
      const store = new RedisStore({ client: admin, prefix: nextPrefix('order') })
      const stamps = [1005, 1001, 1009, 1003, 1007, 1000, 1008, 1002, 1006, 1004]
      for (const ts of stamps) await store.saveMessage(msg('c', `m${ts}`, `b${ts}`, ts))

      expect((await store.getMessagesByChat('c', 3)).map((m) => m.timestamp)).toEqual([1007, 1008, 1009])
      expect((await store.getMessagesByChat('c', 1)).map((m) => m.timestamp)).toEqual([1009])
      const all = (await store.getMessagesByChat('c', 100)).map((m) => m.timestamp)
      expect(all).toEqual([...stamps].sort((a, b) => a - b))
      // The value Bot uses for "everything" is accepted by the server.
      expect(await store.getMessagesByChat('c', 2_147_483_647)).toHaveLength(10)
      expect(await store.getMessagesByChat('missing')).toEqual([])
    })

    it('getMessagesByChat honors the default limit of 50', async () => {
      const store = new RedisStore({ client: admin, prefix: nextPrefix('deflimit') })
      await Promise.all(Array.from({ length: 60 }, (_, i) => store.saveMessage(msg('c', `m${i}`, `b${i}`, 10_000 + i))))
      const page = await store.getMessagesByChat('c')
      expect(page).toHaveLength(50)
      expect(page[0].body).toBe('b10')
      expect(page[49].body).toBe('b59')
    })

    it('getMessagesByChat accepts any numeric limit like MemoryStore (Infinity, fractional, 0, negative)', async () => {
      const store = new RedisStore({ client: admin, prefix: nextPrefix('limits') })
      for (let i = 0; i < 5; i++) await store.saveMessage(msg('c', `m${i}`, `b${i}`, 100 + i))
      // Real Redis rejects non-integer LIMIT counts and treats a negative count as "all".
      expect((await store.getMessagesByChat('c', Number.POSITIVE_INFINITY)).map((m) => m.body)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4'])
      expect((await store.getMessagesByChat('c', 2.5)).map((m) => m.body)).toEqual(['b2', 'b3', 'b4'])
      expect(await store.getMessagesByChat('c', 0)).toEqual([])
      expect(await store.getMessagesByChat('c', -1)).toEqual([])
    })

    it('keeps messages that share a timestamp and re-saving a ref overwrites in place', async () => {
      const prefix = nextPrefix('ties')
      const store = new RedisStore({ client: admin, prefix })
      await store.saveMessage(msg('c', 'a', 'A', 500))
      await store.saveMessage(msg('c', 'b', 'B', 500))
      await store.saveMessage(msg('c', 'a', 'A edited', 600, { status: 'read' }))
      const list = await store.getMessagesByChat('c')
      expect(list.map((m) => m.body)).toEqual(['B', 'A edited'])
      expect(await admin.zCard(`${prefix}:msg:c`)).toBe(2)
    })

    it('deleteMessage removes the item key and the index entry on the server', async () => {
      const prefix = nextPrefix('delmsg')
      const store = new RedisStore({ client: admin, prefix })
      await store.saveMessage(msg('c', 'gone', 'x', 1))
      await store.saveMessage(msg('c', 'kept', 'y', 2))
      await store.deleteMessage({ chatId: 'c', id: 'gone' })
      expect(await admin.exists(`${prefix}:msg:item:c:gone`)).toBe(0)
      expect(await admin.zRange(`${prefix}:msg:c`, 0, -1)).toEqual(['c:kept'])
    })

    it('deleteChat purges the record, the index and every item key (nothing left on the server)', async () => {
      const prefix = nextPrefix('delchat')
      const store = new RedisStore({ client: admin, prefix })
      for (let i = 0; i < 25; i++) await store.saveMessage(msg('doomed', `m${i}`, `b${i}`, i + 1))
      await store.saveMessage(msg('other', 'o1', 'stay', 1))
      await store.upsertChat({ id: 'doomed', name: 'Doomed' })
      await store.upsertChat({ id: 'other', name: 'Other' })

      await store.deleteChat('doomed')

      const left = (await keysOf(prefix)).sort()
      expect(left).toEqual([`${prefix}:chat:other`, `${prefix}:msg:item:other:o1`, `${prefix}:msg:other`].sort())
      expect(await store.getMessagesByChat('doomed')).toEqual([])
      // Deleting an unknown / already-deleted chat is a no-op, not a server error.
      await store.deleteChat('doomed')
      await store.deleteChat('never-existed')
    })

    it('maxMessagesPerChat trims the oldest messages and their item keys on the server', async () => {
      const prefix = nextPrefix('cap')
      const store = new RedisStore({ client: admin, prefix, maxMessagesPerChat: 3 })
      for (let i = 0; i < 8; i++) await store.saveMessage(msg('c', `m${i}`, `b${i}`, 1000 + i))
      await store.saveMessage(msg('quiet', 'q', 'only one', 1))

      expect((await store.getMessagesByChat('c')).map((m) => m.body)).toEqual(['b5', 'b6', 'b7'])
      expect(await admin.zCard(`${prefix}:msg:c`)).toBe(3)
      const items = (await admin.keys(`${globLiteral(prefix)}:msg:item:c:*`)).sort()
      expect(items).toEqual([`${prefix}:msg:item:c:m5`, `${prefix}:msg:item:c:m6`, `${prefix}:msg:item:c:m7`])
      expect(await store.getMessagesByChat('quiet')).toHaveLength(1)
    })

    it('concurrent saveMessage calls on one chat all land, from one or several connections', async () => {
      const prefix = nextPrefix('conc')
      const a = own({ prefix })
      const b = own({ prefix })
      await Promise.all([a.start(), b.start()])
      const writes = Array.from({ length: 200 }, (_, i) =>
        (i % 3 === 0 ? b : a).saveMessage(msg('hot', `m${i}`, `b${i}`, 50_000 + i)))
      await Promise.all(writes)

      const all = await a.getMessagesByChat('hot', 1000)
      expect(all).toHaveLength(200)
      expect(all.map((m) => m.timestamp)).toEqual(Array.from({ length: 200 }, (_, i) => 50_000 + i))
      expect(await admin.zCard(`${prefix}:msg:hot`)).toBe(200)
      expect(await admin.keys(`${globLiteral(prefix)}:msg:item:hot:*`)).toHaveLength(200)
    })

    it('rejects a maxMessagesPerChat the server cannot use as a LIMIT at construction time', () => {
      for (const maxMessagesPerChat of [2.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new RedisStore({ client: admin, maxMessagesPerChat })).toThrow(RangeError)
      }
      expect(() => new RedisStore({ client: admin, maxMessagesPerChat: 0 })).not.toThrow()
    })

    it('maxMessagesPerChat never over-prunes when several replicas trim the same chat concurrently', async () => {
      const prefix = nextPrefix('race')
      const cap = 5
      const replicas = [own({ prefix, maxMessagesPerChat: cap }), own({ prefix, maxMessagesPerChat: cap }), own({ prefix, maxMessagesPerChat: cap })]
      await Promise.all(replicas.map((r) => r.start()))
      let ts = 0
      for (let round = 0; round < 20; round++) {
        // Each replica writes its share sequentially while the others do the same, so
        // trims from one connection interleave with inserts and trims from the others.
        await Promise.all(replicas.map(async (replica) => {
          for (let i = 0; i < 8; i++) {
            const t = ++ts
            await replica.saveMessage(msg('race', `m${t}`, `b${t}`, t))
          }
        }))
        // Once every save has settled, exactly the newest `cap` must remain.
        const kept = await replicas[0].getMessagesByChat('race', 100)
        expect(kept.map((m) => m.timestamp)).toEqual(Array.from({ length: cap }, (_, i) => ts - cap + 1 + i))
        expect(await admin.zCard(`${prefix}:msg:race`)).toBe(cap)
        expect(await admin.keys(`${globLiteral(prefix)}:msg:item:race:*`)).toHaveLength(cap)
      }
    })
  })

  /* Chats, contacts and values -------------------------------------------- */

  describe('records and values', () => {
    it('upsertChat / upsertContact shallow-merge (nested objects are replaced, not deep-merged)', async () => {
      const store = new RedisStore({ client: admin, prefix: nextPrefix('merge') })
      await store.upsertChat({ id: 'c', name: 'Group', kind: 'group', raw: { a: 1, nested: { x: 1 } } })
      await store.upsertChat({ id: 'c', lastMessageAt: 42, raw: { nested: { y: 2 } } })
      expect(await store.getChat('c')).toEqual({ id: 'c', name: 'Group', kind: 'group', lastMessageAt: 42, raw: { nested: { y: 2 } } })

      await store.upsertContact({ id: 'u', name: 'Ana', username: 'ana', phoneNumber: '+1' })
      await store.upsertContact({ id: 'u', name: 'Ana B.', phoneNumber: undefined })
      const contact = await store.getContact('u')
      expect(contact?.name).toBe('Ana B.')
      expect(contact?.username).toBe('ana')
      expect(contact?.phoneNumber).toBeUndefined() // explicit undefined clears, like MemoryStore
    })

    it('concurrent partial upserts of one record do not lose each other\'s fields', async () => {
      const store = new RedisStore({ client: admin, prefix: nextPrefix('merge-conc') })
      await store.upsertChat({ id: 'c', name: 'Original' })
      // What Bot does: inbound (name/kind) and outbound (lastMessageAt) upserts racing on one chat.
      await Promise.all([
        store.upsertChat({ id: 'c', kind: 'group', name: 'Renamed' }),
        store.upsertChat({ id: 'c', lastMessageAt: 7 }),
        store.upsertChat({ id: 'c', updatedAt: 8 }),
      ])
      expect(await store.getChat('c')).toEqual({ id: 'c', name: 'Renamed', kind: 'group', lastMessageAt: 7, updatedAt: 8 })

      await Promise.all([
        store.upsertContact({ id: 'u', name: 'Ana' }),
        store.upsertContact({ id: 'u', username: 'ana' }),
        store.upsertContact({ id: 'u', phoneNumber: '+57' }),
      ])
      expect(await store.getContact('u')).toEqual({ id: 'u', name: 'Ana', username: 'ana', phoneNumber: '+57' })
    })

    it('replicas on separate connections upserting one record concurrently never lose fields', async () => {
      const prefix = nextPrefix('merge-replicas')
      // One store per field, each its own connection — separate processes as far as Redis can tell.
      const fields = ['tenantId', 'environmentId', 'botId', 'providerId', 'connectionId', 'name'] as const
      const replicas = fields.map(() => own({ prefix }))
      await Promise.all(replicas.map((r) => r.start()))
      const ROUNDS = 30
      await Promise.all(
        replicas.map(async (replica, i) => {
          const field = fields[i]!
          for (let round = 0; round < ROUNDS; round++) {
            await Promise.all([
              replica.upsertChat({ id: 'c', [field]: `${field}-${round}` }),
              replica.upsertContact({ id: 'u', ...(i % 2 ? { name: `n-${i}` } : {}), updatedAt: round }),
            ])
          }
        }),
      )
      const expected = Object.fromEntries(fields.map((f) => [f, `${f}-${ROUNDS - 1}`]))
      expect(await replicas[0]!.getChat('c')).toEqual({ id: 'c', ...expected })
      const contact = await replicas[1]!.getContact('u')
      expect(contact?.updatedAt).toBe(ROUNDS - 1)
      expect(contact?.name).toMatch(/^n-\d$/)
    })

    it('an explicit undefined from one replica removes the field another replica wrote', async () => {
      const prefix = nextPrefix('merge-undef')
      const [a, b] = [own({ prefix }), own({ prefix })]
      await Promise.all([a.start(), b.start()])
      await a.upsertContact({ id: 'u', name: 'Ana', phoneNumber: '+1' })
      await b.upsertContact({ id: 'u', phoneNumber: undefined })
      const raw = JSON.parse((await admin.get(`${prefix}:contact:u`)) ?? 'null') as Record<string, unknown>
      expect(raw).toEqual({ id: 'u', name: 'Ana' })
    })

    it('merging keeps JSON values byte-exact (empty arrays, floats, slashes survive the upsert)', async () => {
      const prefix = nextPrefix('merge-exact')
      const store = new RedisStore({ client: admin, prefix })
      const raw = { arr: [], obj: {}, float: 0.1 + 0.2, big: Number.MAX_SAFE_INTEGER, url: 'https://x/y', tiny: 5e-324 }
      await store.upsertChat({ id: 'c', raw })
      await store.upsertChat({ id: 'c', name: 'n' })
      expect(await admin.get(`${prefix}:chat:c`)).toBe(JSON.stringify({ id: 'c', raw, name: 'n' }))
    })

    it('round-trips unicode / emoji ids and values (keys, JSON, listings)', async () => {
      const prefix = nextPrefix('unicode-ñ-🦜')
      const store = new RedisStore({ client: admin, prefix })
      const chatId = 'chat:ñandú 🦜@grupo «ü» 中文 עברית'
      const weirdId = 'id[1]*?\\x'
      const body = 'Hola 👋🏽 — familia 👨‍👩‍👧‍👦, flag 🇨🇴, "quotes", \\back\\slash, nul\u0000byte\nnew line'

      await store.saveMessage(msg(chatId, 'm-😀', body, 1))
      await store.saveMessage(msg(weirdId, 'm1', 'glob chars in the id', 2))
      await store.upsertChat({ id: chatId, name: 'Parceros 🇨🇴' })
      await store.upsertChat({ id: weirdId, name: 'brackets' })
      await store.upsertContact({ id: 'usuário 🙂', name: 'Zoë Ångström' })
      await store.setCheckpoint('ключ 🔑', { flowId: 'flujo-ñ', step: 1, state: { answer: '¿sí? 👍' }, updatedAt: 1 })
      await store.setConversation(chatId, [{ role: 'user', content: '🤖 ¿hola?' }])
      await store.setCursor('cursor 🧭', 'valor 🎯')

      expect((await store.getMessage({ chatId, id: 'm-😀' }))?.body).toBe(body)
      expect((await store.getMessagesByChat(chatId)).map((m) => m.body)).toEqual([body])
      expect((await store.getMessagesByChat(weirdId)).map((m) => m.body)).toEqual(['glob chars in the id'])
      expect((await store.listChats()).map((c) => c.id).sort()).toEqual([chatId, weirdId].sort())
      expect(await store.listContacts()).toEqual([{ id: 'usuário 🙂', name: 'Zoë Ångström' }])
      expect((await store.listCheckpoints()).map(([k]) => k)).toEqual(['ключ 🔑'])
      expect(await store.getConversation(chatId)).toEqual([{ role: 'user', content: '🤖 ¿hola?' }])
      expect(await store.getCursor('cursor 🧭')).toBe('valor 🎯')
      await store.deleteChat(chatId)
      // The chat record and its whole message log are gone (its AI conversation is a separate key).
      expect((await keysOf(prefix)).filter((k) => k.includes('ñandú') && !k.startsWith(`${prefix}:conv:`))).toEqual([])
    })

    it('round-trips large JSON values intact (multi-MB body, wide/deep raw payloads)', async () => {
      const store = new RedisStore({ client: admin, prefix: nextPrefix('large') })
      const body = '🦜'.repeat(500_000) + 'x'.repeat(1_000_000) // ≈3 MB of UTF-8
      const raw = {
        rows: Array.from({ length: 10_000 }, (_, i) => ({ i, label: `row ${i}`, ok: i % 2 === 0, none: null })),
        deep: JSON.parse('{"a":'.repeat(200) + '"bottom"' + '}'.repeat(200)) as unknown,
        numbers: { maxSafe: Number.MAX_SAFE_INTEGER, minSafe: Number.MIN_SAFE_INTEGER, float: 0.1 + 0.2, tiny: 5e-324, big: 1.7976931348623157e308 },
        empties: { arr: [], obj: {}, str: '' },
      }
      const big = msg('c', 'big', body, 1, { raw })
      await store.saveMessage(big)
      expect(await store.getMessage({ chatId: 'c', id: 'big' })).toEqual(big)
      expect(await store.getMessagesByChat('c')).toEqual([big])

      const state = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, { v: i, s: 'ü'.repeat(20) }]))
      const cp: FlowCheckpoint = { flowId: 'big', step: 9, state, updatedAt: 1 }
      await store.setCheckpoint('k', cp)
      expect(await store.getCheckpoint('k')).toEqual(cp)
      const history = Array.from({ length: 2_000 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `turn ${i} ✨` }))
      await store.setConversation('k', history)
      expect(await store.getConversation('k')).toEqual(history)
    })

    it('listings stay inside the prefix even when it contains glob metacharacters', async () => {
      const base = nextPrefix('glob')
      const bracket = new RedisStore({ client: admin, prefix: `${base}[1]` })
      const sibling = new RedisStore({ client: admin, prefix: `${base}1` }) // matched by the unescaped pattern `…[1]:chat:*`
      const star = new RedisStore({ client: admin, prefix: `${base}*` })
      const other = new RedisStore({ client: admin, prefix: `${base}-other` }) // matched by the unescaped pattern `…*:chat:*`

      for (const [store, tag] of [[bracket, 'bracket'], [sibling, 'sibling'], [star, 'star'], [other, 'other']] as const) {
        await store.upsertChat({ id: `chat-${tag}` })
        await store.upsertContact({ id: `user-${tag}` })
        await store.setCheckpoint(`cp-${tag}`, { flowId: tag, step: 0, state: {}, updatedAt: 0 })
      }

      expect((await bracket.listChats()).map((c) => c.id)).toEqual(['chat-bracket'])
      expect((await bracket.listContacts()).map((c) => c.id)).toEqual(['user-bracket'])
      expect((await bracket.listCheckpoints()).map(([k]) => k)).toEqual(['cp-bracket'])
      expect((await star.listChats()).map((c) => c.id)).toEqual(['chat-star'])
      expect((await star.listContacts()).map((c) => c.id)).toEqual(['user-star'])
      expect((await star.listCheckpoints()).map(([k]) => k)).toEqual(['cp-star'])
      expect((await sibling.listChats()).map((c) => c.id)).toEqual(['chat-sibling'])
    })
  })

  /* TTL ------------------------------------------------------------------- */

  describe('ttl', () => {
    it('applies the ttl to checkpoint and conversation keys only (checked with PTTL)', async () => {
      const prefix = nextPrefix('ttl')
      const store = new RedisStore({ client: admin, prefix, ttl: 60 })
      await store.setCheckpoint('k', { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
      await store.setConversation('k', [{ role: 'user', content: 'hi' }])
      await store.setCursor('k', 'v')
      await store.saveMessage(msg('c', 'm', 'body', 1))
      await store.upsertChat({ id: 'c' })
      await store.upsertContact({ id: 'u' })

      for (const key of [`${prefix}:cp:k`, `${prefix}:conv:k`]) {
        const pttl = await admin.pTTL(key)
        expect(pttl).toBeGreaterThan(55_000)
        expect(pttl).toBeLessThanOrEqual(60_000)
      }
      for (const key of [`${prefix}:cursor:k`, `${prefix}:msg:c`, `${prefix}:msg:item:c:m`, `${prefix}:chat:c`, `${prefix}:contact:u`]) {
        expect(await admin.pTTL(key)).toBe(-1) // exists, no expiry
      }
    })

    it('a fractional ttl (seconds) is honored instead of being rejected by the server', async () => {
      const prefix = nextPrefix('ttl-frac')
      const store = new RedisStore({ client: admin, prefix, ttl: 0.25 })
      await store.setCheckpoint('k', { flowId: 'f', step: 1, state: {}, updatedAt: 1 })
      await store.setConversation('k', [{ role: 'user', content: 'hi' }])
      const pttl = await admin.pTTL(`${prefix}:cp:k`)
      expect(pttl).toBeGreaterThan(0)
      expect(pttl).toBeLessThanOrEqual(250)
      await sleep(400)
      expect(await store.getCheckpoint('k')).toBeUndefined()
      expect(await store.getConversation('k')).toBeUndefined()
      expect(await store.listCheckpoints()).toEqual([])
    })

    it('rejects a ttl the server cannot honor at construction time, not on the first write', () => {
      for (const ttl of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new RedisStore({ client: admin, ttl })).toThrow(RangeError)
      }
    })
  })

  /* Distributed lock ------------------------------------------------------ */

  describe('distributed lock', () => {
    it('is exclusive under contention from several connections', async () => {
      const prefix = nextPrefix('lock-x')
      const a = own({ prefix })
      const b = own({ prefix })
      await Promise.all([a.start(), b.start()])
      const tokens = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).acquireLock('job', 10_000)))
      const winners = tokens.filter((t): t is string => t !== null)
      expect(winners).toHaveLength(1)
      expect(await admin.get(`${prefix}:lock:job`)).toBe(winners[0])
    })

    it('stores the token with a PX deadline on the server', async () => {
      const prefix = nextPrefix('lock-px')
      const store = new RedisStore({ client: admin, prefix })
      const token = await store.acquireLock('job', 1_500)
      expect(token).toMatch(/^[0-9a-f-]{36}$/)
      const pttl = await admin.pTTL(`${prefix}:lock:job`)
      expect(pttl).toBeGreaterThan(1_000)
      expect(pttl).toBeLessThanOrEqual(1_500)
    })

    it('only the owner releases it (Lua compare-and-delete executed by the server)', async () => {
      const prefix = nextPrefix('lock-own')
      const store = new RedisStore({ client: admin, prefix })
      const token = await store.acquireLock('job', 10_000)
      expect(token).not.toBeNull()
      expect(await store.releaseLock('job', 'someone-else')).toBe(false)
      expect(await admin.get(`${prefix}:lock:job`)).toBe(token)
      expect(await store.releaseLock('job', token as string)).toBe(true)
      expect(await admin.exists(`${prefix}:lock:job`)).toBe(0)
      expect(await store.releaseLock('job', token as string)).toBe(false)
      expect(await store.releaseLock('never-taken', 'x')).toBe(false)
    })

    it('expires after ttlMs; the stale owner can then no longer release the new holder\'s lock', async () => {
      const prefix = nextPrefix('lock-exp')
      const store = new RedisStore({ client: admin, prefix })
      const stale = await store.acquireLock('job', 150)
      expect(stale).not.toBeNull()
      expect(await store.acquireLock('job', 150)).toBeNull()
      await sleep(300)
      const fresh = await store.acquireLock('job', 10_000)
      expect(fresh).not.toBeNull()
      expect(await store.releaseLock('job', stale as string)).toBe(false)
      expect(await admin.get(`${prefix}:lock:job`)).toBe(fresh)
      expect(await store.releaseLock('job', fresh as string)).toBe(true)
    })

    it('locks are namespaced by prefix', async () => {
      const a = new RedisStore({ client: admin, prefix: nextPrefix('lock-ns') })
      const b = new RedisStore({ client: admin, prefix: nextPrefix('lock-ns') })
      expect(await a.acquireLock('same', 5_000)).not.toBeNull()
      expect(await b.acquireLock('same', 5_000)).not.toBeNull()
    })

    it('accepts a fractional ttlMs and rejects a non-positive one with a RangeError', async () => {
      const prefix = nextPrefix('lock-ttl')
      const store = new RedisStore({ client: admin, prefix })
      const token = await store.acquireLock('frac', 1_500.5)
      expect(token).not.toBeNull()
      expect(await admin.pTTL(`${prefix}:lock:frac`)).toBeGreaterThan(1_000)
      for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(store.acquireLock(`bad-${ttlMs}`, ttlMs)).rejects.toThrow(RangeError)
      }
    })
  })
})
