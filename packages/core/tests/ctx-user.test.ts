/**
 * ctx.user — persistent per-user profile with namespaces, dot paths and TTL
 * (FEATURES.md #1). Exercised through the public entry point and a Bot wired
 * to MockProvider + MemoryStore.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Bot,
  MemoryStore,
  NamespacedStore,
  UserDataError,
  UserDataService,
  buildMessageContext,
  flow,
  userOf,
} from '../src/index.js'
import type { InboundMessage, IStore, UserDataEntry } from '../src/index.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import type { IncomingOpts, MockProvider } from '../src/testing/MockProvider.js'

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

/** Resolve once the bot finished dispatching the next message (reject on a bot error). */
function dispatched(bot: Bot): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMessage = () => { off(); resolve() }
    const onError = (payload: { error: unknown }) => { off(); reject(payload.error) }
    const off = () => { bot.off('message', onMessage); bot.off('error', onError) }
    bot.on('message', onMessage)
    bot.on('error', onError)
  })
}

async function deliver(bot: Bot, provider: MockProvider, text: string, opts: IncomingOpts = {}): Promise<void> {
  const done = dispatched(bot)
  provider.incoming(text, opts)
  await done
}

/** The error a synchronous call throws (fails the test when it does not throw). */
function thrown(fn: () => unknown): unknown {
  try { fn() } catch (error) { return error }
  throw new Error('expected the call to throw')
}

const USER_DATA_METHODS = new Set<PropertyKey>([
  'getUserData', 'setUserData', 'deleteUserData', 'listUserData', 'purgeExpiredUserData',
])

/** A store that predates the user-data contract (methods hidden). */
function legacyStore(inner: MemoryStore): IStore {
  return new Proxy(inner, {
    get(target, prop) {
      if (USER_DATA_METHODS.has(prop)) return undefined
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as IStore
}

/** MemoryStore whose user-data reads/writes yield to the event loop (forces interleaving). */
class SlowStore extends MemoryStore {
  override async getUserData(userId: string, namespace: string, key: string): Promise<UserDataEntry | undefined> {
    const entry = await super.getUserData(userId, namespace, key)
    await new Promise((resolve) => setTimeout(resolve, 5))
    return entry
  }
  override async setUserData(entry: UserDataEntry): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await super.setUserData(entry)
  }
}

/**
 * MemoryStore whose setUserData takes 30 ms, and which can fail one key's read
 * or write immediately — so a batch has a sibling write still in flight when
 * one of its store calls rejects.
 */
class SlowSetStore extends MemoryStore {
  failKey: string | undefined
  failReadKey: string | undefined
  inFlight = 0
  override async getUserData(userId: string, namespace: string, key: string): Promise<UserDataEntry | undefined> {
    if (key === this.failReadKey) throw new Error('store read failed')
    return super.getUserData(userId, namespace, key)
  }
  override async setUserData(entry: UserDataEntry): Promise<void> {
    if (entry.key === this.failKey) throw new Error('store write failed')
    this.inFlight++
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      await super.setUserData(entry)
    } finally {
      this.inFlight--
    }
  }
}

describe('ctx.user — handlers', () => {
  it('persists values per sender across messages', async () => {
    const { bot, provider } = await createTestBot()
    const seen: unknown[] = []
    bot.when('set', async (ctx) => { await ctx.user.set('name', 'Juan') })
    bot.when('get', async (ctx) => { seen.push(await ctx.user.get('name')) })
    await deliver(bot, provider, 'get', { from: 'u1' })
    await deliver(bot, provider, 'set', { from: 'u1' })
    await deliver(bot, provider, 'get', { from: 'u1' })
    expect(seen).toEqual([undefined, 'Juan'])
    await bot.stop()
  })

  it('is keyed by the canonical sender and shared across chats', async () => {
    const { bot, provider } = await createTestBot()
    const seen: Array<[string, string, unknown]> = []
    bot.when('set', async (ctx) => { await ctx.user.set('lang', 'es') })
    bot.when('get', async (ctx) => { seen.push([ctx.from, ctx.user.userId, await ctx.user.get('lang')]) })
    await deliver(bot, provider, 'set', { from: 'group-1', sender: 'alice', isGroup: true })
    await deliver(bot, provider, 'get', { from: 'alice' })
    await deliver(bot, provider, 'get', { from: 'group-2', sender: 'alice', isGroup: true })
    await deliver(bot, provider, 'get', { from: 'group-1', sender: 'bob', isGroup: true })
    expect(seen).toEqual([
      ['alice', 'alice', 'es'],
      ['group-2', 'alice', 'es'],
      ['group-1', 'bob', undefined],
    ])
    await bot.stop()
  })

  it('exposes the default namespace and the sender id on ctx.user', async () => {
    const { bot, provider } = await createTestBot()
    let info: [string, string] | undefined
    bot.when('who', async (ctx) => { info = [ctx.user.userId, ctx.user.namespace] })
    await deliver(bot, provider, 'who', { from: 'chat-9', sender: 'carol', isGroup: true })
    expect(info).toEqual(['carol', 'default'])
    await bot.stop()
  })

  it('serialises read-modify-write of one key when the same user writes from several chats', async () => {
    // Per-chat FIFO does NOT serialise one user across chats: these two messages
    // are dispatched concurrently. The per-key lock must keep both nested writes.
    const { bot, provider } = await createTestBot({ store: new SlowStore() })
    bot.when(/^pick (\w+)$/, async (ctx) => {
      const [, slot] = /^pick (\w+)$/.exec(ctx.body) ?? []
      await ctx.user.set(`picks.${slot}`, ctx.from)
    })
    let handled = 0
    const both = new Promise<void>((resolve) => bot.on('message', () => { if (++handled === 2) resolve() }))
    provider.incoming('pick a', { from: 'group-1', sender: 'dave', isGroup: true })
    provider.incoming('pick b', { from: 'group-2', sender: 'dave', isGroup: true })
    await both
    expect(await bot.user('dave').get('picks')).toEqual({ a: 'group-1', b: 'group-2' })
    await bot.stop()
  })

  it('userOf(ctx) exposes the profile inside flows', async () => {
    const { bot, chat } = await createTestBot()
    bot.use(flow('idioma')
      .ask('¿Idioma?', 'lang')
      .do(async (ctx, c) => { await userOf(ctx).set('lang', c.state.lang) })
      .say('guardado'))
    await chat.send('idioma')
    await chat.expectReply('¿Idioma?')
    await chat.send('es')
    await chat.expectReply('guardado')
    expect(await bot.user(chat.jid).get('lang')).toBe('es')
    await bot.stop()
  })

  it('userOf() throws a typed error for a context without a profile', () => {
    expect(() => userOf({ from: 'x', sender: 'y', body: '', type: 'text', isGroup: false, reply: async () => undefined }))
      .toThrow(UserDataError)
  })

  it('a context built outside a Bot rejects ctx.user calls with UNAVAILABLE', async () => {
    const inbound: InboundMessage = {
      ref: { id: 'm1', chatId: 'c1' },
      chat: { id: 'c1', kind: 'dm', isGroup: false, isBroadcast: false },
      senderInfo: { id: 'u1' },
      from: 'c1', sender: 'u1', chatId: 'c1', senderId: 'u1',
      isGroup: false, isBroadcast: false, fromMe: false,
      type: 'text', body: 'hi', timestamp: 1, mentions: [], raw: {},
    }
    const ctx = buildMessageContext({ inbound, tools: {}, send: async () => ({ ref: { id: 'o1', chatId: 'c1' } }) })
    expect(ctx.user.userId).toBe('u1')
    await expect(ctx.user.get('x')).rejects.toMatchObject({ name: 'UserDataError', code: 'UNAVAILABLE' })
    await expect(ctx.user.set('x', 1)).rejects.toBeInstanceOf(UserDataError)
  })
})

describe('ctx.user — API semantics', () => {
  let bot: Bot
  beforeEach(async () => { ({ bot } = await createTestBot()) })
  afterEach(async () => { await bot.stop() })

  it('reads and writes nested values with dot-notation paths', async () => {
    const user = bot.user('u1')
    await user.set('address.city', 'Bogotá')
    await user.set('address.zip', '110111')
    expect(await user.get('address')).toEqual({ city: 'Bogotá', zip: '110111' })
    expect(await user.get('address.city')).toBe('Bogotá')
    expect(await user.get('address.street')).toBeUndefined()
    expect(await user.get('address.city.length')).toBeUndefined() // never walks into primitives
    expect(await user.get('address.toString')).toBeUndefined() // own properties only
    expect(await user.get('missing.deep.path')).toBeUndefined()

    await user.set('name', 'Juan')
    await user.set('name.first', 'J') // a primitive in the way is replaced by an object
    expect(await user.get('name')).toEqual({ first: 'J' })

    await user.set('list', ['a', 'b'])
    await user.set('list.1', 'B')
    await user.set('list.2', 'c') // append
    expect(await user.get('list')).toEqual(['a', 'B', 'c'])
    expect(await user.get('list.0')).toBe('a')
    await expect(user.set('list.9', 'x')).rejects.toMatchObject({ code: 'INVALID_PATH' }) // no sparse arrays
  })

  it('stores JSON copies: later mutation of the written object has no effect', async () => {
    const user = bot.user('u1')
    const profile = { tags: ['a'], when: new Date(T0) }
    await user.set('profile', profile)
    profile.tags.push('b')
    expect(await user.get('profile')).toEqual({ tags: ['a'], when: new Date(T0).toISOString() })
  })

  it('namespaces keep features from colliding (flat, absolute names)', async () => {
    const user = bot.user('u1')
    await user.set('lang', 'es')
    await user.ns('akinator').set('lang', 'en')
    expect(await user.get('lang')).toBe('es')
    expect(await user.ns('akinator').get('lang')).toBe('en')
    expect(user.namespace).toBe('default')
    expect(user.ns('akinator').namespace).toBe('akinator')
    expect(user.ns('akinator').ns('game').namespace).toBe('game')
    await user.ns('akinator').clear()
    expect(await user.ns('akinator').all()).toEqual({})
    expect(await user.all()).toEqual({ lang: 'es' })
  })

  it('update() applies several paths and leaves the other keys alone', async () => {
    const user = bot.user('u1')
    await user.set('keep', 1)
    await user.set('address', { city: 'Lima', zip: '15001' })
    await user.update({ name: 'Juan', lang: 'es', 'address.city': 'Bogotá' })
    expect(await user.all()).toEqual({ keep: 1, name: 'Juan', lang: 'es', address: { city: 'Bogotá', zip: '15001' } })
  })

  it('update() validates everything before writing anything', async () => {
    const user = bot.user('u1')
    await expect(user.update({ ok: 1, 'bad..path': 2 })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(user.update({ ok: 1, bad: 10n })).rejects.toMatchObject({ code: 'INVALID_VALUE' })
    expect(await user.all()).toEqual({})
  })

  it('update() checks array indexes against the stored values before writing any key', async () => {
    const user = bot.user('u1')
    await user.set('items', [])
    await expect(user.update({ name: 'Juan', 'items.5': 1 })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(user.update({ 'items.0': 'a', 'items.2': 'c' })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(await user.all()).toEqual({ items: [] })
  })

  it('delete() removes a key or a nested path; set(path, undefined) deletes too', async () => {
    const user = bot.user('u1')
    await user.set('address', { city: 'Lima', zip: '1' })
    await user.delete('address.zip')
    expect(await user.get('address')).toEqual({ city: 'Lima' })
    await user.delete('address')
    expect(await user.get('address')).toBeUndefined()
    await user.set('name', 'Juan')
    await user.set('name', undefined)
    expect(await user.get('name')).toBeUndefined()
    await user.set('nested', { a: 1, b: 2 })
    await user.update({ 'nested.a': undefined })
    expect(await user.get('nested')).toEqual({ b: 2 })
    await user.delete('missing.deep.path') // no-op
    await user.delete('missing')
    expect(await user.all()).toEqual({ nested: { b: 2 } })
  })

  it('clear() wipes only its own namespace and user', async () => {
    await bot.user('u1').set('a', 1)
    await bot.user('u1').ns('game').set('b', 2)
    await bot.user('u2').set('a', 3)
    await bot.user('u1').clear()
    expect(await bot.user('u1').all()).toEqual({})
    expect(await bot.user('u1').ns('game').all()).toEqual({ b: 2 })
    expect(await bot.user('u2').all()).toEqual({ a: 3 })
  })

  it('rejects invalid paths, namespaces, values and users with a typed UserDataError', async () => {
    const user = bot.user('u1')
    for (const bad of ['', '.a', 'a.', 'a..b', '__proto__', 'a.__proto__.x', 'constructor.prototype', 'a\u0000b']) {
      await expect(user.set(bad, 1)).rejects.toMatchObject({ name: 'UserDataError', code: 'INVALID_PATH' })
      await expect(user.get(bad)).rejects.toBeInstanceOf(UserDataError)
      await expect(user.delete(bad)).rejects.toBeInstanceOf(UserDataError)
    }
    await expect(user.set('k'.repeat(256), 1)).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(Object.prototype).not.toHaveProperty('x')

    for (const bad of ['', 'x'.repeat(129), 'tab\there']) {
      expect(thrown(() => user.ns(bad))).toMatchObject({ name: 'UserDataError', code: 'INVALID_NAMESPACE' })
    }

    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(user.set('c', circular)).rejects.toMatchObject({ code: 'INVALID_VALUE' })
    await expect(user.set('big', 10n)).rejects.toMatchObject({ code: 'INVALID_VALUE' })
    await expect(user.set('fn', () => 1)).rejects.toMatchObject({ code: 'INVALID_VALUE' })
    await expect(user.set('sym', Symbol('s'))).rejects.toMatchObject({ code: 'INVALID_VALUE' })

    await expect(bot.user('').get('x')).rejects.toMatchObject({ code: 'INVALID_USER' })
  })

  it('bot.user(id) and ctx.user address the same profile', async () => {
    const { bot: b, provider } = await createTestBot()
    await b.user('erin').set('vip', true)
    let vip: unknown
    b.when('vip?', async (ctx) => { vip = await ctx.user.get('vip') })
    await deliver(b, provider, 'vip?', { from: 'erin' })
    expect(vip).toBe(true)
    await b.stop()
  })
})

describe('ctx.user — TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => { vi.useRealTimers() })

  it('accepts duration strings and milliseconds; expired values disappear', async () => {
    const { bot } = await createTestBot()
    const game = bot.user('u1').ns('game')
    await game.set('board', [1], { ttl: '30m' })
    await game.set('turn', 'x', { ttl: 1_000 })
    await game.set('wins', 3, { ttl: '7d' })
    await game.set('name', 'forever')

    vi.setSystemTime(T0 + 1_000)
    expect(await game.get('turn')).toBeUndefined()
    expect(await game.get('board')).toEqual([1])

    vi.setSystemTime(T0 + 30 * 60_000)
    expect(await game.get('board')).toBeUndefined()
    expect(await game.all()).toEqual({ wins: 3, name: 'forever' })
    expect((await bot.exportSubject('u1')).userData.map((e) => e.key).sort()).toEqual(['name', 'wins'])
    await bot.stop()
  })

  it('a nested write keeps the expiry; a top-level set without ttl replaces it', async () => {
    const { bot } = await createTestBot()
    const game = bot.user('u1').ns('game')
    await game.set('board', { turn: 'x' }, { ttl: '1m' })
    vi.setSystemTime(T0 + 30_000)
    await game.set('board.turn', 'o') // keeps the 1m expiry of `board`
    await game.update({ 'board.moves': 1 }) // so does update() on a nested path
    vi.setSystemTime(T0 + 60_000)
    expect(await game.get('board')).toBeUndefined()

    await game.set('score', 1, { ttl: '1m' })
    await game.set('score', 2) // top-level replace: permanent again
    await game.set('streak.days', 3, { ttl: 1_000 }) // ttl on a nested write applies to the top-level key
    vi.setSystemTime(T0 + 10 * 60_000)
    expect(await game.get('score')).toBe(2)
    expect(await game.get('streak')).toBeUndefined()

    const entries = (await bot.getStore().listUserData!('u1', 'game'))
    expect(entries.map((e) => [e.key, e.expiresAt])).toEqual([['score', undefined]])
    await bot.stop()
  })

  it('rejects a non-positive or malformed ttl', async () => {
    const { bot } = await createTestBot()
    const user = bot.user('u1')
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'soon', '']) {
      await expect(user.set('k', 1, { ttl })).rejects.toMatchObject({ name: 'UserDataError', code: 'INVALID_TTL' })
    }
    expect(await user.all()).toEqual({})
    await bot.stop()
  })

  it('rounds a fractional ttl up to whole milliseconds (BIGINT / Redis PX need integers)', async () => {
    const store = new MemoryStore()
    const service = new UserDataService(store)
    await service.for('u1').set('a', 1, { ttl: 1_500.5 })
    await service.for('u1').update({ b: 2 }, { ttl: 0.25 })
    await service.for('u1').set('c', 3, { ttl: '1.0005s' }) // parseDuration already rounds strings
    const expiries = (await store.listUserData('u1')).map((e): [string, number | undefined] => [e.key, e.expiresAt])
    expect(expiries.sort()).toEqual([['a', T0 + 1_501], ['b', T0 + 1], ['c', T0 + 1_001]])
  })

  it('rejects a ttl whose expiry would not be a safe integer epoch', async () => {
    const service = new UserDataService(new MemoryStore())
    const user = service.for('u1')
    for (const ttl of [1e20, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - T0 + 1, '99999999999999999w']) {
      await expect(user.set('k', 1, { ttl })).rejects.toMatchObject({ name: 'UserDataError', code: 'INVALID_TTL' })
    }
    expect(await user.all()).toEqual({})
    await user.set('k', 1, { ttl: Number.MAX_SAFE_INTEGER - T0 }) // the largest accepted ttl
    expect(await user.get('k')).toBe(1)
  })

  it('purges expired entries opportunistically on writes, at most once per interval', async () => {
    const store = new MemoryStore()
    const purge = vi.spyOn(store, 'purgeExpiredUserData')
    const service = new UserDataService(store, { purgeInterval: '1m' })
    await service.for('u1').set('a', 1)
    expect(purge).toHaveBeenCalledTimes(1)
    await service.for('u2').set('b', 2)
    expect(purge).toHaveBeenCalledTimes(1)
    vi.setSystemTime(T0 + 60_000)
    await service.for('u3').set('c', 3)
    expect(purge).toHaveBeenCalledTimes(2)
  })

  it('purgeInterval false disables it, and a failing purge never fails the write', async () => {
    const store = new MemoryStore()
    const purge = vi.spyOn(store, 'purgeExpiredUserData').mockRejectedValue(new Error('db down'))
    const errors: unknown[] = []
    const failing = new UserDataService(store, { logger: { error: (...a: unknown[]) => { errors.push(a) } } })
    await failing.for('u1').set('a', 1)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    expect(await failing.for('u1').get('a')).toBe(1)

    const disabled = new UserDataService(store, { purgeInterval: false })
    vi.setSystemTime(T0 + 3_600_000)
    await disabled.for('u1').set('b', 2)
    expect(purge).toHaveBeenCalledTimes(1)
  })

  it('bot.purgeExpiredUserData() physically removes expired entries', async () => {
    const memory = new MemoryStore()
    const { bot } = await createTestBot({ store: memory })
    await bot.user('u1').set('tmp', 1, { ttl: '1s' })
    vi.setSystemTime(T0 + 5_000)
    expect(await bot.purgeExpiredUserData()).toBe(1)
    expect(await bot.purgeExpiredUserData()).toBe(0)
    await bot.stop()
  })
})

describe('ctx.user — concurrency', () => {
  it('serialises read-modify-write of the same top-level key', async () => {
    const service = new UserDataService(new SlowStore())
    await Promise.all([
      service.for('u1').set('profile.a', 1),
      service.for('u1').set('profile.b', 2),
      service.for('u1').update({ 'profile.c': 3, other: true }),
      service.for('u1').delete('profile.missing'),
    ])
    expect(await service.for('u1').get('profile')).toEqual({ a: 1, b: 2, c: 3 })
    expect(await service.for('u1').get('other')).toBe(true)
  })

  it('applies writes to one key in call order', async () => {
    const service = new UserDataService(new SlowStore())
    const user = service.for('u1')
    await Promise.all([user.set('n', 1), user.set('n', 2), user.delete('n'), user.set('n', 3)])
    expect(await user.get('n')).toBe(3)
  })

  it('erasure waits for in-flight writes of that subject', async () => {
    const service = new UserDataService(new SlowStore())
    const write = service.for('u1').set('profile.name', 'Juan')
    const erased = service.erase('u1')
    await write
    expect(await erased).toBe(1)
    expect(await service.for('u1').all()).toEqual({})
  })

  it('a batch rejected by path validation writes nothing, so erasure cannot be undone', async () => {
    const store = new SlowSetStore()
    const service = new UserDataService(store, { purgeInterval: false })
    await service.for('u1').set('items', [])
    const update = service.for('u1').update({ profile: { secret: 1 }, 'items.5': 1 })
    const erased = service.erase('u1')
    await expect(update).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await erased
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await store.listUserData('u1')).toEqual([])
  })

  it('a failing store write keeps the lock until every sibling write settled', async () => {
    const store = new SlowSetStore()
    store.failKey = 'boom'
    const service = new UserDataService(store, { purgeInterval: false })
    const update = service.for('u1').update({ profile: { secret: 1 }, boom: 1 })
    const erased = service.erase('u1')
    await expect(update).rejects.toThrow('store write failed')
    expect(store.inFlight).toBe(0) // rejected only after the sibling write settled
    await erased
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await store.listUserData('u1')).toEqual([]) // nothing resurrected after erasure
  })

  it('a failing store read keeps the lock until every sibling call settled', async () => {
    const store = new SlowSetStore()
    store.failReadKey = 'boom'
    const service = new UserDataService(store, { purgeInterval: false })
    const update = service.for('u1').update({ profile: { secret: 1 }, 'boom.x': 1 })
    const erased = service.erase('u1')
    await expect(update).rejects.toThrow('store read failed')
    await erased
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await store.listUserData('u1')).toEqual([])
  })
})

describe('ctx.user — privacy (export / erasure)', () => {
  it('exportSubject includes user data and deleteSubject erases every namespace', async () => {
    const { bot, chat } = await createTestBot({ tenantId: 'privacy', botId: 'desk' })
    bot.when('hola', async (ctx) => {
      await ctx.user.set('name', 'Juan')
      await ctx.user.ns('game').set('score', 5, { ttl: '1h' })
      await ctx.reply('ok')
    })
    await chat.send('hola')
    await chat.expectReply('ok')
    await bot.user('someone-else').set('name', 'Ana')

    const exported = await bot.exportSubject(chat.jid)
    expect(exported.userData).toEqual([
      { userId: chat.jid, namespace: 'default', key: 'name', value: 'Juan', updatedAt: expect.any(Number) },
      { userId: chat.jid, namespace: 'game', key: 'score', value: 5, expiresAt: expect.any(Number), updatedAt: expect.any(Number) },
    ])

    const deleted = await bot.deleteSubject(chat.jid)
    expect(deleted).toMatchObject({ contacts: 1, userData: 2 })
    expect(await bot.user(chat.jid).all()).toEqual({})
    expect(await bot.user(chat.jid).ns('game').all()).toEqual({})
    expect(await bot.user('someone-else').get('name')).toBe('Ana')
    expect((await bot.exportSubject(chat.jid)).userData).toEqual([])
    await bot.stop()
  })

  it('stores without user-data support: ctx.user rejects, export/erasure keep working', async () => {
    const { bot, chat } = await createTestBot({ store: legacyStore(new MemoryStore()) })
    let failure: unknown
    bot.when('hola', async (ctx) => {
      try { await ctx.user.get('x') } catch (error) { failure = error }
      await ctx.reply('ok')
    })
    await chat.send('hola')
    await chat.expectReply('ok')
    expect(failure).toMatchObject({ name: 'UserDataError', code: 'UNSUPPORTED_STORE' })
    expect(typeof bot.getStore().getUserData).toBe('undefined')
    expect((await bot.exportSubject(chat.jid)).userData).toEqual([])
    expect((await bot.deleteSubject(chat.jid)).userData).toBe(0)
    expect(await bot.purgeExpiredUserData()).toBe(0)
    await bot.stop()
  })

  it('isolates user data between bots sharing one backend store', async () => {
    const shared = new MemoryStore()
    const a = await createTestBot({ store: shared, botId: 'a' })
    const b = await createTestBot({ store: shared, botId: 'b' })
    await a.bot.user('u1').set('lang', 'es')
    expect(await b.bot.user('u1').get('lang')).toBeUndefined()
    expect((await b.bot.deleteSubject('u1')).userData).toBe(0)
    expect(await a.bot.user('u1').get('lang')).toBe('es')
    expect((await a.bot.exportSubject('u1')).userData).toHaveLength(1)
    await a.bot.stop()
    await b.bot.stop()
  })

  it('NamespacedStore exposes user data only when the inner store supports it', () => {
    const ns = { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'c' }
    expect(typeof new NamespacedStore(new MemoryStore(), ns).getUserData).toBe('function')
    const wrapped = new NamespacedStore(legacyStore(new MemoryStore()), ns)
    expect(wrapped.getUserData).toBeUndefined()
    expect(wrapped.purgeExpiredUserData).toBeUndefined()
  })
})

describe('MemoryStore — user-data persistence', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'botwa-user-data-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('persists live user data to its JSON file and restores it', async () => {
    const file = join(dir, 'store.json')
    const first = new MemoryStore({ file, autoSaveInterval: 0 })
    await first.start()
    await first.setUserData({ userId: 'u1', namespace: 'default', key: 'name', value: 'Juan', updatedAt: 1 })
    await first.setUserData({ userId: 'u1', namespace: 'game', key: 'board', value: [1], expiresAt: Date.now() + 60_000, updatedAt: 2 })
    await first.setUserData({ userId: 'u1', namespace: 'game', key: 'stale', value: 0, expiresAt: Date.now() - 1, updatedAt: 3 })
    await first.stop()

    const raw = JSON.parse(await readFile(file, 'utf8')) as { userData?: UserDataEntry[] }
    expect(raw.userData?.map((e) => e.key).sort()).toEqual(['board', 'name']) // expired entries are not written

    const second = new MemoryStore({ file, autoSaveInterval: 0 })
    await second.start()
    expect((await second.getUserData('u1', 'default', 'name'))?.value).toBe('Juan')
    expect((await second.getUserData('u1', 'game', 'board'))?.value).toEqual([1])
    await second.stop()
  })

  it('still loads a legacy file without user data (backward-compatible format)', async () => {
    const file = join(dir, 'legacy.json')
    await writeFile(file, JSON.stringify({ chats: [{ id: 'c1' }], contacts: [], checkpoints: {}, conversations: {}, cursors: {} }))
    const store = new MemoryStore({ file, autoSaveInterval: 0 })
    await store.start()
    expect(await store.getChat('c1')).toEqual({ id: 'c1' })
    expect(await store.listUserData('u1')).toEqual([])
    await store.stop()
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['chats', 'checkpoints', 'contacts', 'conversations', 'cursors', 'userData'])
  })

  it('skips malformed or expired user-data rows when loading', async () => {
    const file = join(dir, 'odd.json')
    await writeFile(file, JSON.stringify({
      userData: [
        { userId: 'u1', namespace: 'default', key: 'ok', value: 1, updatedAt: 1 },
        { userId: 'u1', namespace: 'default', key: 'old', value: 2, updatedAt: 1, expiresAt: 1 },
        { userId: 42, namespace: 'default', key: 'bad', value: 3, updatedAt: 1 },
        'garbage',
      ],
    }))
    const store = new MemoryStore({ file, autoSaveInterval: 0 })
    await store.start()
    expect((await store.listUserData('u1')).map((e) => e.key)).toEqual(['ok'])
    await store.stop()
  })
})
