/**
 * Durability under shared backends, crashes and slow transports: namespace isolation,
 * default instance ids, poison messages, outbox lease heartbeats, diverged replays,
 * per-chat FIFO with a slow journal and live failover between two replicas.
 */
import { hostname } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Bot, KvDurability, MemoryDurability, MemoryKv, MemoryStore, flow,
  type BotConfig, type DurabilityBackend, type OutboundContent, type SendOptions, type SendResult,
} from '../src/index.js'
import { CrashableProvider, MockProvider, crashable } from '../src/testing/index.js'

const bots: Bot[] = []
afterEach(async () => {
  for (const b of bots.splice(0)) await b.stop().catch(() => {})
})

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

function bot(config: Partial<BotConfig> & { provider: BotConfig['provider'] }, track = true): Bot {
  const b = new Bot({ logger: silent(), ...config })
  b.on('error', () => {})
  if (track) bots.push(b)
  return b
}

const texts = (p: MockProvider) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const never = () => new Promise<never>(() => {})

class SlowProvider extends MockProvider {
  constructor(private readonly delayMs: number) { super() }
  override async send(chatId: string, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    await sleep(this.delayMs)
    return super.send(chatId, content, options)
  }
}

describe('several bots on one backend', () => {
  it('each bot claims, replays and deduplicates only its own records', async () => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const pa = new MockProvider()
    const pb = new MockProvider()
    const a = bot({ provider: pa, store, botId: 'bot-a', durability: { journal: shared, pollMs: 10 } })
    const b = bot({ provider: pb, store, botId: 'bot-b', durability: { journal: shared, pollMs: 10 } })
    a.when('hang', flow('hang').do(async () => { await never() }))
    const seenByB: string[] = []
    b.onMessage(async (ctx) => { seenByB.push(ctx.body) })
    await a.start()
    await b.start()
    expect(a.durability!.scope).toBeDefined()
    expect(a.durability!.scope).not.toBe(b.durability!.scope)

    // An explicit key is per bot: both reminders go out, each through its own provider.
    expect(await a.enqueue('u1', 'from A', { idempotencyKey: 'reminder:1' })).toMatchObject({ status: 'queued' })
    expect(await b.enqueue('u1', 'from B', { idempotencyKey: 'reminder:1' })).toMatchObject({ status: 'queued' })
    await vi.waitFor(() => expect([texts(pa), texts(pb)]).toEqual([['from A'], ['from B']]))

    // A's in-flight inbound, released by its stop, is never picked up by B.
    pa.incoming('hang', { from: 'u1', id: 'm1' })
    await vi.waitFor(async () => expect((await a.durability!.inbox.list())[0]?.state).toBe('processing'))
    await a.stop()
    expect((await shared.scope(a.durability!.scope!).inbox.list())[0]).toMatchObject({ state: 'pending' })
    await sleep(60)
    expect(seenByB).toEqual([])
    expect(await b.durability!.inbox.list()).toEqual([])
  })
})

describe('default instanceId', () => {
  it('is stable on a single-process backend and unique per boot on a shared one', () => {
    const provider = new MockProvider()
    const host = hostname()
    const stable = bot({ provider, botId: 'x', durability: { journal: new MemoryDurability() } }, false)
    expect(stable.durability!.instanceId).toBe(`${host}/x/default`)
    const kv = new MemoryKv()
    const one = bot({ provider, botId: 'x', durability: { journal: new KvDurability(kv) } }, false)
    const two = bot({ provider, botId: 'x', durability: { journal: new KvDurability(kv) } }, false)
    expect(one.durability!.instanceId).toMatch(new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/x/default/${process.pid}-`))
    expect(one.durability!.instanceId).not.toBe(two.durability!.instanceId)
    expect(bot({ provider, durability: { journal: new KvDurability(kv), instanceId: 'pod-0' } }, false).durability!.instanceId).toBe('pod-0')
  })

  it('a second process on the same host does not take a live process’s leases', async () => {
    const kv = new MemoryKv() // shared storage, not exclusive (like Postgres/Redis)
    const store = new MemoryStore()
    const pa = new MockProvider()
    const a = bot({ provider: pa, store, botId: 'x', durability: { journal: new KvDurability(kv), inbox: { leaseMs: 10_000 } } })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const runsA: string[] = []
    a.when('go', async (ctx) => { runsA.push(ctx.body); await gate; await ctx.reply('done') })
    await a.start()
    pa.incoming('go', { from: 'u1', id: 'm1' })
    await vi.waitFor(() => expect(runsA).toEqual(['go']))

    const pb = new MockProvider()
    const b = bot({ provider: pb, store, botId: 'x', durability: { journal: new KvDurability(kv), pollMs: 10, inbox: { leaseMs: 10_000 } } })
    const runsB: string[] = []
    b.when('go', async (ctx) => { runsB.push(ctx.body); await ctx.reply('done') })
    await b.start()
    await sleep(50)
    expect(runsB).toEqual([]) // A is alive and holds the lease
    release()
    await vi.waitFor(async () => expect((await a.durability!.inbox.list())[0]?.state).toBe('done'))
    expect([texts(pa), texts(pb)]).toEqual([['done'], []])
    expect(b.durability!.metrics().staleLeases + a.durability!.metrics().staleLeases).toBe(0)
  })
})

describe('poison messages', () => {
  it('a message that crashes the process on every run is dead-lettered after maxAttempts', async () => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const dead = vi.fn()
    let runs = 0
    let last: Bot | undefined
    for (let incarnation = 0; incarnation < 3; incarnation++) {
      const view = crashable(shared)
      const provider = new CrashableProvider(view)
      const b = bot({ provider, store, durability: { journal: view, instanceId: 'r1', inbox: { maxAttempts: 2 } } }, false)
      b.on('durability:dead', dead)
      b.onMessage(async () => { runs++; view.crash(); await never() }) // the process dies on this message
      await b.start()
      if (incarnation === 0) provider.incoming('boom', { from: 'u1', id: 'm1' })
      if (incarnation < 2) await view.whenCrashed // abandoned: a dead process is never stopped
      else last = b
    }
    await vi.waitFor(() => expect(dead).toHaveBeenCalledWith(expect.objectContaining({ kind: 'inbound' })))
    expect(runs).toBe(2)
    const [record] = await shared.scope(last!.durability!.scope!).inbox.list()
    expect(record).toMatchObject({ state: 'dead', lastError: expect.stringMatching(/not completed after 2 attempts/) })
    expect(last!.durability!.metrics().inboundDead).toBe(1)
    bots.push(last!)
  })
})

describe('outbox lease heartbeat', () => {
  it('a send slower than outbox.leaseMs keeps its lease (no ambiguous reclaim, recorded as sent)', async () => {
    const provider = new SlowProvider(150)
    const b = bot({ provider, durability: { pollMs: 10, outbox: { leaseMs: 40 } } })
    const ambiguous = vi.fn()
    b.on('durability:ambiguous', ambiguous)
    await b.start()
    const sent = await b.send('c1', 'big upload', { idempotencyKey: 'k1' })
    expect(await b.durability!.outbox.get('k1')).toMatchObject({ state: 'sent', result: { ref: sent.ref } })
    expect(ambiguous).not.toHaveBeenCalled()
    expect(b.durability!.metrics()).toMatchObject({ outboxAmbiguous: 0, staleLeases: 0 })
    expect(texts(provider)).toEqual(['big upload'])
  })
})

describe('diverged replays', () => {
  const run = async (policy: 'send' | 'skip' | undefined) => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const define = (b: Bot) => {
      // Not persistent: the conversation is lost with the process.
      b.when('pedido', flow('pedido').ask('¿Nombre?', 'name').say((_ctx, c) => `Gracias ${String(c.state.name)}`))
      b.onMessage(async (ctx) => { await ctx.reply(`No entiendo: ${ctx.body}`) })
    }
    const outbox = policy ? { onDiverged: policy } : {}
    const a = crashable(shared)
    a.crashBefore('inbox.ack', 2) // 'Ana' answered by the flow, the process dies before acking it
    const pa = new CrashableProvider(a)
    const botA = bot({ provider: pa, store, durability: { journal: a, instanceId: 'r1', outbox } }, false)
    define(botA)
    await botA.start()
    pa.incoming('pedido', { from: 'u1', id: 'm1' })
    await vi.waitFor(() => expect(texts(pa)).toEqual(['¿Nombre?']))
    pa.incoming('Ana', { from: 'u1', id: 'm2' })
    await a.whenCrashed
    expect(texts(pa)).toEqual(['¿Nombre?', 'Gracias Ana'])

    const pb = new MockProvider()
    const botB = bot({ provider: pb, store, durability: { journal: shared, instanceId: 'r1', outbox } })
    define(botB)
    await botB.start()
    await vi.waitFor(async () => expect((await botB.durability!.inbox.list()).every((r) => r.state === 'done')).toBe(true))
    await sleep(20)
    return { delivered: texts(pb), metrics: botB.durability!.metrics(), outbox: await botB.durability!.outbox.list() }
  }

  it('a replay that takes another path sends its new reply under a new key (default)', async () => {
    const r = await run(undefined)
    expect(r.delivered).toEqual(['No entiendo: Ana'])
    expect(r.metrics.outboxDiverged).toBe(1)
    expect(r.outbox.map((o) => o.state)).toEqual(['sent', 'sent', 'sent'])
  })

  it("onDiverged: 'skip' answers it from the recorded send", async () => {
    const r = await run('skip')
    expect(r.delivered).toEqual([])
    expect(r.metrics.outboxDiverged).toBe(1)
  })

  it('a replay that produces the same content is still deduplicated', async () => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const a = crashable(shared)
    a.crashBefore('inbox.ack', 1)
    const pa = new CrashableProvider(a)
    const botA = bot({ provider: pa, store, durability: { journal: a, instanceId: 'r1' } }, false)
    botA.onMessage(async (ctx) => { await ctx.reply(`eco ${ctx.body}`) })
    await botA.start()
    pa.incoming('hola', { from: 'u1', id: 'm1' })
    await a.whenCrashed
    const pb = new MockProvider()
    const botB = bot({ provider: pb, store, durability: { journal: shared, instanceId: 'r1' } })
    botB.onMessage(async (ctx) => { await ctx.reply(`eco ${ctx.body}`) })
    await botB.start()
    await vi.waitFor(async () => expect((await botB.durability!.inbox.list())[0]?.state).toBe('done'))
    expect([texts(pa), texts(pb)]).toEqual([['eco hola'], []])
    expect(botB.durability!.metrics()).toMatchObject({ outboxDiverged: 0, outboxDeduped: 1 })
  })
})

describe('per-chat FIFO with a slow journal', () => {
  it('messages of one chat are dispatched in arrival order even when appends finish out of order', async () => {
    const inner = new MemoryDurability()
    let n = 0
    const append = inner.inbox.append.bind(inner.inbox)
    const journal: DurabilityBackend = {
      inbox: Object.create(inner.inbox, {
        append: { value: async (...args: Parameters<typeof append>) => { if (n++ === 0) await sleep(40); return append(...args) } },
      }),
      outbox: inner.outbox,
    }
    const provider = new MockProvider()
    const b = bot({ provider, durability: { journal } })
    const seen: string[] = []
    b.onMessage(async (ctx) => { seen.push(ctx.body) })
    await b.start()
    provider.incoming('first', { from: 'u1', id: 'm1' })
    provider.incoming('second', { from: 'u1', id: 'm2' })
    provider.incoming('other chat', { from: 'u2', id: 'm3' })
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    expect(seen.filter((s) => s !== 'other chat')).toEqual(['first', 'second'])
  })
})

describe('two live replicas', () => {
  it('a live replica keeps its lease; when it freezes, the other takes over once the lease expires', async () => {
    const shared = new MemoryDurability()
    const store = new MemoryStore()
    const cfg = { pollMs: 10, inbox: { leaseMs: 60 } }
    const a = crashable(shared)
    const pa = new CrashableProvider(a)
    const botA = bot({ provider: pa, store, durability: { journal: a, instanceId: 'replica-a', ...cfg } }, false)
    const pb = new MockProvider()
    const botB = bot({ provider: pb, store, durability: { journal: shared, instanceId: 'replica-b', ...cfg } })
    const runs: string[] = []
    botA.when('slow', async (ctx) => { runs.push('A:slow'); await sleep(200); await ctx.reply('slow done') })
    botA.when('freeze', async () => { runs.push('A:freeze'); a.crash(); await never() })
    botB.when('slow', async (ctx) => { runs.push('B:slow'); await ctx.reply('slow done') })
    botB.when('freeze', async (ctx) => { runs.push('B:freeze'); await ctx.reply('taken over') })
    await botA.start()
    await botB.start()

    pa.incoming('slow', { from: 'u1', id: 'm1' })
    await vi.waitFor(() => expect(texts(pa)).toEqual(['slow done']), { timeout: 2_000 })
    expect(runs).toEqual(['A:slow']) // 200 ms > leaseMs, but A's heartbeat kept the lease

    pa.incoming('freeze', { from: 'u1', id: 'm2' })
    await vi.waitFor(() => expect(texts(pb)).toEqual(['taken over']), { timeout: 2_000 })
    expect(runs).toEqual(['A:slow', 'A:freeze', 'B:freeze'])
    await vi.waitFor(async () => expect((await botB.durability!.inbox.list()).map((r) => r.state)).toEqual(['done', 'done']))
  })
})

describe('live send racing its own sweeper', () => {
  it('a live send whose record the sweeper claims between put and begin follows that delivery (no SendDeferredError)', async () => {
    class FailOnce extends MockProvider {
      failed = false
      override async send(chatId: string, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
        if (!this.failed) { this.failed = true; throw new Error('transient') }
        return super.send(chatId, content, options)
      }
    }
    let racePut: (() => Promise<void>) | undefined
    class RacingDurability extends MemoryDurability {
      override scope(name: string): KvDurability {
        const view = super.scope(name)
        const put = view.outbox.put.bind(view.outbox)
        Object.assign(view.outbox, {
          put: async (...args: Parameters<typeof put>) => {
            const res = await put(...args)
            if (res.status !== 'created' && racePut) { const race = racePut; racePut = undefined; await race() }
            return res
          },
        })
        return view
      }
    }
    const provider = new FailOnce()
    const b = bot({ provider, durability: { journal: new RacingDurability(), pollMs: '1h', outbox: { inlineMaxMs: 0, backoff: () => 1 } } })
    await b.start()
    // First attempt fails and is deferred: the record is `failed`, due again almost at once.
    await expect(b.send('u1', 'x', { idempotencyKey: 'k1' })).rejects.toThrow(/deferred/)
    await sleep(10)
    // The same key again: right after its put, the sweeper claims the record (`sending`).
    racePut = async () => {
      void b.durability!.sweep()
      for (let i = 0; i < 200; i++) {
        const rec = (await b.durability!.outbox.list()).find((r) => r.key === 'k1')
        if (rec?.state === 'sending') return
        await sleep(1)
      }
      throw new Error('the sweeper never claimed k1')
    }
    const sent = await b.send('u1', 'x', { idempotencyKey: 'k1' })
    expect(sent.id).not.toBe('skipped')
    expect(texts(provider)).toEqual(['x'])
  })
})
