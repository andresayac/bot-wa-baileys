/**
 * Durable media references: a journaled inbound event keeps a serializable reference to its
 * media (`IProvider.serializeMediaRef`), and a replay (crash recovery, background retry)
 * rebuilds the live token with `IProvider.rehydrateMediaRef` before the handler runs.
 */
import { describe, expect, it } from 'vitest'
import {
  Bot, IMAGE, MediaUnavailableError, MemoryDurability, MemoryStore, ProviderError, loadMediaOf,
  type DurabilityBackend, type InboundEvent, type InboundMessage, type MediaRef, type MessageContext, type SerializedMediaRef,
} from '../src/index.js'
import { CrashableProvider, crashable } from '../src/testing/index.js'
import { encodeInbound } from '../src/durability/codec.js'
import { rehydrateInbound } from '../src/durability/media.js'

/** A live, non-JSON media handle (like a Baileys WAMessage): only an instance can be downloaded. */
class LiveToken {
  constructor(readonly bytes: Buffer, readonly viewOnce = false) {}
  read(): Buffer { return this.bytes }
}

interface MediaOptions {
  /** `false`: the provider has no serialize/rehydrate hooks (today's providers). */
  hooks?: boolean
  rehydrateDelayMs?: number
  failRehydrate?: boolean
  throwOnSerialize?: boolean
}

let seq = 0

class MediaProvider extends CrashableProvider {
  serialized = 0
  rehydrated = 0
  readonly opts: MediaOptions

  constructor(backend?: { crashed: boolean }, opts: MediaOptions = {}) {
    super(backend)
    this.opts = opts
    if (opts.hooks === false) {
      Object.defineProperty(this, 'serializeMediaRef', { value: undefined })
      Object.defineProperty(this, 'rehydrateMediaRef', { value: undefined })
    }
  }

  media(bytes: string, o: { id: string; from?: string; viewOnce?: boolean }): void {
    const from = o.from ?? 'u1'
    const message: InboundMessage = {
      ref: { id: o.id, chatId: from },
      chat: { id: from, kind: 'dm', isGroup: false, isBroadcast: false },
      senderInfo: { id: from, displayName: 'Test User' },
      from, sender: from, chatId: from, senderId: from,
      isGroup: false, isBroadcast: false, fromMe: false,
      type: 'image', body: '', timestamp: Math.floor(Date.now() / 1000) + ++seq, mentions: [],
      media: { kind: 'image', mimetype: 'image/png', token: new LiveToken(Buffer.from(bytes), o.viewOnce) },
      raw: {},
    }
    ;(this as unknown as { emitEvent(e: InboundEvent): void }).emitEvent({ kind: 'message', message })
  }

  override async downloadMedia(ref?: MediaRef): Promise<Buffer> {
    if (!(ref?.token instanceof LiveToken)) throw new ProviderError('downloadMedia requires a live token')
    return ref.token.read()
  }

  serializeMediaRef(ref: MediaRef): SerializedMediaRef | undefined {
    this.serialized++
    if (this.opts.throwOnSerialize) throw new Error('serialize exploded')
    if (!(ref.token instanceof LiveToken) || ref.token.viewOnce) return undefined
    return { v: 1, data: ref.token.bytes.toString('base64') }
  }

  async rehydrateMediaRef(stored: SerializedMediaRef, ref: Omit<MediaRef, 'token'>): Promise<MediaRef> {
    this.rehydrated++
    if (this.opts.rehydrateDelayMs) await new Promise((r) => setTimeout(r, this.opts.rehydrateDelayMs))
    if (this.opts.failRehydrate || stored.v !== 1 || typeof stored.data !== 'string') throw new ProviderError('invalid media reference')
    return { ...ref, token: new LiveToken(Buffer.from(stored.data, 'base64')) }
  }
}

function silentLogger(): never {
  const noop = () => {}
  const l: Record<string, unknown> = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, level: 'silent' }
  l.child = () => l
  return l as never
}

async function until(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const never = () => new Promise<never>(() => {})

/** A store whose first `n` message saves fail: the pipeline fails before dispatch and the record is retried. */
function flakyStore(n = 1): MemoryStore {
  const store = new MemoryStore()
  const save = store.saveMessage.bind(store)
  store.saveMessage = async (m) => { if (n-- > 0) throw new Error('db down'); return save(m) }
  return store
}
const texts = (p: CrashableProvider) => p.outbox.map((m) => (m.content as { text?: string }).text ?? m.content.kind)
const durability = (journal: DurabilityBackend, extra: Record<string, unknown> = {}) => ({
  journal, instanceId: 'replica-1', pollMs: 20,
  inbox: { backoff: () => 5, ...(extra.inbox as object | undefined) },
  outbox: { backoff: () => 5 },
})

/** A handler that reports how the media loaded (bytes, or the error class and reason). */
async function describeMedia(ctx: MessageContext): Promise<string> {
  try {
    const m = await loadMediaOf(ctx, { throwOnError: true })
    return `bytes:${m?.buffer.toString() ?? 'none'}`
  } catch (error) {
    const e = error as MediaUnavailableError
    return `err:${e.name}:${e.reason ?? '-'}:${e instanceof ProviderError}`
  }
}

describe('durable media references', () => {
  it('a crash mid-handler: the restarted bot replays the event and downloads its media', async () => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const a = crashable(shared)
    const pa = new MediaProvider(a)
    const botA = new Bot({ provider: pa, store, logger: silentLogger(), durability: durability(a) })
    botA.on('error', () => {})
    botA.when(IMAGE, async (ctx) => {
      await ctx.reply('recibido')
      a.crash()
      return never()
    })
    await botA.start()
    pa.media('PNG-1', { id: 'm1' })
    await a.whenCrashed
    await until(() => pa.outbox.length === 1, 'A to reply once')

    const pb = new MediaProvider()
    const botB = new Bot({ provider: pb, store, logger: silentLogger(), durability: durability(shared) })
    botB.on('error', () => {})
    botB.when(IMAGE, async (ctx) => {
      await ctx.reply('recibido')
      await ctx.reply(await describeMedia(ctx))
    })
    await botB.start()
    const view = shared.scope!(botB.durability!.scope!)
    await until(async () => (await view.inbox.list({ state: 'done' })).length === 1, 'B to replay m1')

    expect(pb.rehydrated).toBe(1)
    expect([...texts(pa), ...texts(pb)]).toEqual(['recibido', 'bytes:PNG-1']) // the first reply is deduped by the outbox
    await botB.stop()
  })

  it('a background retry (the pipeline failed before dispatch) also gets the media', async () => {
    const p = new MediaProvider()
    const bot = new Bot({ provider: p, store: flakyStore(), logger: silentLogger(), durability: durability(new MemoryDurability()) })
    bot.on('error', () => {})
    bot.when(IMAGE, async (ctx) => { await ctx.reply(await describeMedia(ctx)) })
    await bot.start()
    p.media('JPG-2', { id: 'm2' })
    await until(async () => (await bot.durability!.inbox.list({ state: 'done' })).length === 1, 'the retry')
    expect(texts(p)).toEqual(['bytes:JPG-2'])
    expect(p.rehydrated).toBe(1)
    await bot.stop()
  })

  it('journals a versioned marker, never the live token object', async () => {
    const p = new MediaProvider()
    const bot = new Bot({ provider: p, store: new MemoryStore(), logger: silentLogger(), durability: durability(new MemoryDurability()) })
    bot.when(IMAGE, async (ctx) => { await ctx.reply(await describeMedia(ctx)) })
    await bot.start()
    p.media('LIVE', { id: 'm3' })
    await until(async () => (await bot.durability!.inbox.list({ state: 'done' })).length === 1, 'm3')
    const [record] = await bot.durability!.inbox.list()
    const media = (record.payload as { message: { media: Record<string, unknown> } }).message.media
    expect(media).toEqual({
      kind: 'image', mimetype: 'image/png',
      token: { $botwaMedia: 1, provider: 'mock', ref: { v: 1, data: Buffer.from('LIVE').toString('base64') } },
    })
    expect(JSON.stringify(record.payload)).not.toContain('"bytes"')
    expect(texts(p)).toEqual(['bytes:LIVE']) // the live dispatch keeps the real token
    expect(p.rehydrated).toBe(0)
    await bot.stop()
  })

  it('a provider without hooks journals exactly what it did before', async () => {
    const p = new MediaProvider(undefined, { hooks: false })
    const seen: InboundEvent[] = []
    p.onEvent((e) => { seen.push(e) })
    const bot = new Bot({ provider: p, store: new MemoryStore(), logger: silentLogger(), durability: durability(new MemoryDurability()) })
    bot.when(IMAGE, async (ctx) => { await ctx.reply('ok') })
    await bot.start()
    p.media('RAW', { id: 'm4' })
    await until(async () => (await bot.durability!.inbox.list({ state: 'done' })).length === 1, 'm4')
    const [record] = await bot.durability!.inbox.list()
    expect(record.payload).toEqual(encodeInbound(seen.find((e) => e.kind === 'message')!))
    await bot.stop()
  })

  it('inbox.mediaRefs: false keeps today\'s encoding and never calls the hook', async () => {
    const p = new MediaProvider()
    const seen: InboundEvent[] = []
    p.onEvent((e) => { seen.push(e) })
    const bot = new Bot({
      provider: p, store: new MemoryStore(), logger: silentLogger(),
      durability: durability(new MemoryDurability(), { inbox: { mediaRefs: false } }),
    })
    bot.when(IMAGE, async (ctx) => { await ctx.reply('ok') })
    await bot.start()
    p.media('RAW', { id: 'm5' })
    await until(async () => (await bot.durability!.inbox.list({ state: 'done' })).length === 1, 'm5')
    const [record] = await bot.durability!.inbox.list()
    expect(record.payload).toEqual(encodeInbound(seen.find((e) => e.kind === 'message')!))
    expect(p.serialized).toBe(0)
    await bot.stop()
  })

  it('rejects an invalid inbox.mediaRefs', () => {
    expect(() => new Bot({ provider: new MediaProvider(), durability: { inbox: { mediaRefs: 'yes' as never } } }))
      .toThrow(/mediaRefs/)
  })

  async function retried(opts: MediaOptions, viewOnce = false): Promise<{ replies: string[]; states: string[] }> {
    const p = new MediaProvider(undefined, opts)
    const bot = new Bot({ provider: p, store: flakyStore(), logger: silentLogger(), durability: durability(new MemoryDurability()) })
    bot.on('error', () => {})
    bot.when(IMAGE, async (ctx) => { await ctx.reply(await describeMedia(ctx)) })
    await bot.start()
    p.media('X', { id: 'r1', viewOnce })
    await until(async () => (await bot.durability!.inbox.list({ state: 'done' })).length === 1, 'the retry')
    const result = { replies: texts(p), states: (await bot.durability!.inbox.list()).map((r) => r.state) }
    await bot.stop()
    return result
  }

  it('media the provider declined to serialize: MediaUnavailableError(not-durable), record still done', async () => {
    const r = await retried({}, true)
    expect(r.replies).toEqual(['err:MediaUnavailableError:not-durable:true'])
    expect(r.states).toEqual(['done'])
  })

  it('a rehydrate that throws: MediaUnavailableError(rehydrate-failed), record still done', async () => {
    const r = await retried({ failRehydrate: true })
    expect(r.replies).toEqual(['err:MediaUnavailableError:rehydrate-failed:true'])
    expect(r.states).toEqual(['done'])
  })

  it('a serialize that throws never blocks the journal or the live dispatch (the replay is not-durable)', async () => {
    const r = await retried({ throwOnSerialize: true })
    expect(r.replies).toEqual(['err:MediaUnavailableError:not-durable:true'])
    const p = new MediaProvider(undefined, { throwOnSerialize: true })
    const bot = new Bot({ provider: p, store: new MemoryStore(), logger: silentLogger(), durability: durability(new MemoryDurability()) })
    bot.when(IMAGE, async (ctx) => { await ctx.reply(await describeMedia(ctx)) })
    await bot.start()
    p.media('LIVE', { id: 't1' })
    await until(async () => (await bot.durability!.inbox.list({ state: 'done' })).length === 1, 't1')
    expect(texts(p)).toEqual(['bytes:LIVE'])
    await bot.stop()
  })

  it('a journal written by another provider: provider-mismatch', async () => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const a = crashable(shared)
    a.crashAfter('inbox.append', 1)
    const pa = new MediaProvider(a)
    const botA = new Bot({ provider: pa, store, botId: 'shop', logger: silentLogger(), durability: durability(a) })
    botA.when(IMAGE, async () => {})
    await botA.start()
    pa.media('Y', { id: 'x1' })
    await a.whenCrashed

    const pb = new MediaProvider()
    Object.defineProperty(pb, 'id', { value: 'other-transport' })
    const botB = new Bot({ provider: pb, store, botId: 'shop', logger: silentLogger(), durability: durability(shared) })
    botB.when(IMAGE, async (ctx) => { await ctx.reply(await describeMedia(ctx)) })
    await botB.start()
    const view = shared.scope!(botB.durability!.scope!)
    await until(async () => (await view.inbox.list({ state: 'done' })).length === 1, 'B to replay x1')
    expect(texts(pb)).toEqual(['err:MediaUnavailableError:provider-mismatch:true'])
    expect(pb.rehydrated).toBe(0)
    await botB.stop()
  })

  it('a replay with a slow rehydrate still runs before a live message of its chat', async () => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const a = crashable(shared)
    a.crashAfter('inbox.append', 1)
    const pa = new MediaProvider(a)
    const botA = new Bot({ provider: pa, store, logger: silentLogger(), durability: durability(a) })
    botA.when(IMAGE, async () => {})
    await botA.start()
    pa.media('SLOW', { id: 'f1' })
    await a.whenCrashed

    const pb = new MediaProvider(undefined, { rehydrateDelayMs: 60 })
    const order: string[] = []
    const botB = new Bot({ provider: pb, store, logger: silentLogger(), durability: durability(shared) })
    botB.when(IMAGE, async (ctx) => { order.push(await describeMedia(ctx)) })
    botB.when('hola', async () => { order.push('hola') })
    await botB.start()
    pb.incoming('hola', { from: 'u1', id: 'f2' })
    const view = shared.scope!(botB.durability!.scope!)
    await until(async () => (await view.inbox.list({ state: 'done' })).length === 2, 'both messages')
    expect(order).toEqual(['bytes:SLOW', 'hola'])
    await botB.stop()
  })
})

describe('rehydrateInbound (unit)', () => {
  const log = { debug() {}, warn() {}, error() {} }
  const event = (token: unknown): InboundEvent => ({
    kind: 'message',
    message: {
      ref: { id: 'i', chatId: 'c' }, chat: { id: 'c', kind: 'dm', isGroup: false, isBroadcast: false },
      senderInfo: { id: 'c' }, from: 'c', sender: 'c', chatId: 'c', senderId: 'c',
      isGroup: false, isBroadcast: false, fromMe: false, type: 'image', body: '', timestamp: 1, mentions: [],
      media: { kind: 'image', token }, raw: undefined,
    } as InboundMessage,
  })
  const codec = { providerId: 'p', rehydrate: async (_s: SerializedMediaRef, ref: Omit<MediaRef, 'token'>) => ({ ...ref, token: 'live' }) }

  it('leaves a token that is not a marker untouched (records written before the upgrade)', async () => {
    const e = event({ legacy: true })
    expect(await rehydrateInbound(e, codec, log)).toBe(e)
  })

  it('rebuilds the token through the provider', async () => {
    const out = await rehydrateInbound(event({ $botwaMedia: 1, provider: 'p', ref: { v: 1, data: 'x' } }), codec, log)
    expect(out.kind === 'message' && out.message.media).toEqual({ kind: 'image', token: 'live' })
  })

  it('no codec, another provider, no ref: a sentinel the download guard rejects', async () => {
    const reasons: string[] = []
    for (const [token, c] of [
      [{ $botwaMedia: 1, provider: 'q', ref: { v: 1, data: 'x' } }, codec],
      [{ $botwaMedia: 1, provider: 'p' }, codec],
      [{ $botwaMedia: 1, provider: 'p', ref: { v: 1, data: 'x' } }, undefined],
      [{ $botwaMedia: 1, provider: 'p', ref: { v: 1, data: 'x' } }, { providerId: 'p' }],
    ] as const) {
      const out = await rehydrateInbound(event(token), c, log)
      const t = out.kind === 'message' ? out.message.media?.token : undefined
      const { guardDownload } = await import('../src/core/mediaRefs.js')
      const download = guardDownload(async () => Buffer.from('never'))!
      const error = await download({ kind: 'image', token: t }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MediaUnavailableError)
      reasons.push((error as MediaUnavailableError).reason)
    }
    expect(reasons).toEqual(['provider-mismatch', 'not-durable', 'rehydrate-failed', 'rehydrate-failed'])
  })
})
