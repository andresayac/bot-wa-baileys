import { describe, it, expect, vi } from 'vitest'
import { Bot } from '../src/core/Bot.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import {
  CoordinationUnavailableError,
  LeaseLostError,
  MemoryCoordinationHub,
  MemoryCoordinator,
  ProviderNotLeaderError,
  type Coordinator,
  type Ticket,
} from '../src/coordination/index.js'
import type { BotConfig } from '../src/core/types.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (p: MockProvider, chatId?: string) => p.outbox
  .filter((m) => chatId === undefined || m.chatId === chatId)
  .map((m) => (m.content.kind === 'text' ? m.content.text : `[${m.content.kind}]`))

/** A coordinator wrapper that resolves `reserved(n)` once `n` reservations have reached the backend. */
function tracked(inner: Coordinator) {
  let count = 0
  const waiters: Array<{ n: number; resolve: () => void }> = []
  const wrapped: Coordinator = {
    replicaId: inner.replicaId,
    start: () => inner.start(),
    stop: () => inner.stop(),
    acquireTurn: (t, o) => inner.acquireTurn(t, o),
    lead: (n, o) => inner.lead(n, o),
    tryLead: (n) => inner.tryLead(n),
    on: (e, l) => inner.on(e, l),
    reserve: async (key: string): Promise<Ticket> => {
      const t = await inner.reserve(key)
      count++
      for (const w of waiters.filter((w) => w.n <= count)) { waiters.splice(waiters.indexOf(w), 1); w.resolve() }
      return t
    },
  }
  const reserved = (n: number) => (count >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve })))
  return { coordinator: wrapped, reserved }
}

function replica(hub: MemoryCoordinationHub, store: MemoryStore, id: string, extra: Partial<BotConfig> = {}, providerOpts = {}) {
  const provider = new MockProvider(providerOpts)
  const coordinator = new MemoryCoordinator({ hub, replicaId: id })
  const bot = new Bot({ provider, store, coordination: { coordinator }, ...extra })
  return { bot, provider, coordinator }
}

describe('MemoryCoordinator (reference contract)', () => {
  it('grants turns of one key in ticket order, one holder at a time, across replicas', async () => {
    const hub = new MemoryCoordinationHub()
    const a = new MemoryCoordinator({ hub, replicaId: 'a' })
    const b = new MemoryCoordinator({ hub, replicaId: 'b' })
    await a.start(); await b.start()
    const t1 = await a.reserve('k')
    const t2 = await b.reserve('k')
    const t3 = await a.reserve('k')
    expect([t1.seq, t2.seq, t3.seq]).toEqual([1, 2, 3])
    const order: number[] = []
    const p3 = a.acquireTurn(t3).then((t) => { order.push(3); return t })
    const p2 = b.acquireTurn(t2).then((t) => { order.push(2); return t })
    const turn1 = await a.acquireTurn(t1)
    expect(turn1.previousHolder).toBeNull()
    await sleep(5)
    expect(order).toEqual([])                       // 2 and 3 wait for 1
    await turn1.release()
    const turn2 = await p2
    expect(turn2.previousHolder).toBe('a')
    expect(order).toEqual([2])
    await turn2.release()
    const turn3 = await p3
    expect(turn3.previousHolder).toBe('b')
    expect(turn3.fence).toBeGreaterThan(turn2.fence)
    await turn3.release()
  })

  it('skips the tickets and frees the turn of a replica that crashed, and aborts its signals', async () => {
    const hub = new MemoryCoordinationHub()
    const a = new MemoryCoordinator({ hub, replicaId: 'a' })
    const b = new MemoryCoordinator({ hub, replicaId: 'b' })
    await a.start(); await b.start()
    const lost = vi.fn()
    a.on('lease-lost', lost)
    const held = await a.acquireTurn(await a.reserve('k'))
    await a.reserve('k')                             // a queued ticket of the dying replica
    const tb = await b.reserve('k')
    const pb = b.acquireTurn(tb)
    a.crash()
    expect(held.signal.aborted).toBe(true)
    expect(() => held.assertHeld()).toThrow(LeaseLostError)
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ key: 'k', holder: 'a', reason: 'expired' }))
    const turn = await pb
    expect(turn.fence).toBe(tb.seq)
    await turn.release()
  })

  it('times out a turn wait and cancels the ticket so later tickets are not blocked', async () => {
    const coord = new MemoryCoordinator({ replicaId: 'a' })
    await coord.start()
    const first = await coord.acquireTurn(await coord.reserve('k'))
    const t2 = await coord.reserve('k')
    const t3 = await coord.reserve('k')
    await expect(coord.acquireTurn(t2, { maxWaitMs: 10 })).rejects.toBeInstanceOf(CoordinationUnavailableError)
    await first.release()
    const turn3 = await coord.acquireTurn(t3)
    expect(turn3.fence).toBe(3)
    await turn3.release()
  })

  it('elects one leader per name with increasing terms, and hands over when it steps down', async () => {
    const hub = new MemoryCoordinationHub()
    const a = new MemoryCoordinator({ hub, replicaId: 'a' })
    const b = new MemoryCoordinator({ hub, replicaId: 'b' })
    await a.start(); await b.start()
    const la = await a.tryLead('job')
    expect(la?.fence).toBe(1)
    expect(await b.tryLead('job')).toBeNull()
    const pb = b.lead('job')
    await la!.release()
    const lb = await pb
    expect(lb.fence).toBe(2)
    await b.stop()
    expect(lb.signal.aborted).toBe(true)
    expect((await a.tryLead('job'))?.fence).toBe(3)
  })
})

describe('Bot with coordination', () => {
  it('two replicas process interleaved messages of one chat strictly in ingress order, never concurrently', async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore()
    const ta = tracked(new MemoryCoordinator({ hub, replicaId: 'a' }))
    const tb = tracked(new MemoryCoordinator({ hub, replicaId: 'b' }))
    const pa = new MockProvider()
    const pb = new MockProvider()
    const a = new Bot({ provider: pa, store, coordination: { coordinator: ta.coordinator } })
    const b = new Bot({ provider: pb, store, coordination: { coordinator: tb.coordinator } })
    const seen: string[] = []
    let running = 0
    let overlap = false
    for (const bot of [a, b]) {
      bot.onMessage(async (ctx) => {
        running++
        if (running > 1) overlap = true
        await sleep(Math.floor(Math.random() * 4))
        seen.push(ctx.body)
        running--
      })
    }
    await a.start(); await b.start()
    const N = 40
    let reservedA = 0
    let reservedB = 0
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) { pa.incoming(`m${i}`, { from: 'chat', id: `id${i}` }); await ta.reserved(++reservedA) }
      else { pb.incoming(`m${i}`, { from: 'chat', id: `id${i}` }); await tb.reserved(++reservedB) }
    }
    await vi.waitFor(() => expect(seen).toHaveLength(N), { timeout: 5000, interval: 10 })
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => `m${i}`))
    expect(overlap).toBe(false)
    await a.stop(); await b.stop()
  })

  it('does not block other chats', async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore()
    const r = replica(hub, store, 'a')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    r.bot.onMessage(async (ctx) => {
      if (ctx.body === 'slow') await gate
      await ctx.reply(`ok ${ctx.body}`)
    })
    await r.bot.start()
    r.provider.incoming('slow', { from: 'c1' })
    r.provider.incoming('fast', { from: 'c2' })
    await vi.waitFor(() => expect(texts(r.provider, 'c2')).toEqual(['ok fast']))
    release()
    await vi.waitFor(() => expect(texts(r.provider, 'c1')).toEqual(['ok slow']))
    await r.bot.stop()
  })

  it('rejects a reply after the chat turn was lost mid-handler and reports the lease loss', async () => {
    const hub = new MemoryCoordinationHub()
    const r = replica(hub, new MemoryStore(), 'a')
    const lost = vi.fn()
    r.bot.on('coordination:lease-lost', lost)
    let replyError: unknown
    let crashNow!: () => void
    const reached = new Promise<void>((resolve) => { crashNow = resolve })
    r.bot.onMessage(async (ctx) => {
      crashNow()
      await sleep(20)
      try { await ctx.reply('too late') } catch (error) { replyError = error }
    })
    await r.bot.start()
    r.provider.incoming('hi', { from: 'c1' })
    await reached
    r.coordinator.crash()
    await vi.waitFor(() => expect(replyError).toBeInstanceOf(LeaseLostError))
    expect(r.provider.outbox).toHaveLength(0)
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ key: 'c1', reason: 'expired' }))
    await r.bot.stop()
  })

  it('drops a message whose turn cannot be had, reports it, and releases its dedupe key', async () => {
    const coordinator = new MemoryCoordinator({ replicaId: 'a' })
    const provider = new MockProvider()
    const bot = new Bot({ provider, coordination: { coordinator, turnWaitMs: 30, settleMs: 10 } })
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    const handled: string[] = []
    bot.onMessage(async (ctx) => { handled.push(ctx.body) })
    await bot.start()
    // Another holder keeps the chat busy longer than turnWaitMs.
    const blocker = await coordinator.acquireTurn(await coordinator.reserve('c1'))
    provider.incoming('first', { from: 'c1', id: 'dup' })
    await vi.waitFor(() => expect(errors.some((e) => e instanceof CoordinationUnavailableError)).toBe(true))
    expect(handled).toEqual([])
    await blocker.release()
    provider.incoming('first', { from: 'c1', id: 'dup' })   // redelivery is processed
    await vi.waitFor(() => expect(handled).toEqual(['first']))
    await bot.stop()
  })

  it('holds the turn until the conversation step it fed settles', async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore()
    const a = replica(hub, store, 'a')
    const order: string[] = []
    a.bot.use(flow('slow').ask('name?', 'name').do(async (_ctx, c) => {
      order.push('step-start')
      await sleep(30)
      order.push(`step-end ${String(c.state.name)}`)
    }).ask('next?', 'next'))
    await a.bot.start()
    // The second replica only sees the chat after the step settled on the first.
    const probe = new MemoryCoordinator({ hub, replicaId: 'probe' })
    await probe.start()
    a.provider.incoming('slow', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toContain('name?'))
    a.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(order).toContain('step-start'))
    const turn = await probe.acquireTurn(await probe.reserve('c1'))
    order.push('probe')
    await turn.release()
    expect(order).toEqual(['step-start', 'step-end Ana', 'probe'])
    await a.bot.stop(); await probe.stop()
  })

  it('hands a persistent flow over: the answer sent to another replica resumes it from the checkpoint', async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore()
    const make = (id: string) => {
      const r = replica(hub, store, id)
      r.bot.use(flow('signup').persistent()
        .say('hi')
        .ask('name?', 'name')
        .ask('email?', 'email')
        .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
      return r
    }
    const a = make('a')
    const b = make('b')
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    b.provider.incoming('Ana', { from: 'c1' })          // answered through the other replica
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']))   // no repeated 'name?'
    a.provider.incoming('ana@x.co', { from: 'c1' })     // and back: A's stale conversation is dropped
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?', 'done Ana ana@x.co']))
    expect(await store.getCheckpoint('c1')).toBeUndefined()
    await a.bot.stop(); await b.bot.stop()
  })

  it('starts an exclusive-session provider on the elected replica only, and fails over when it stops', async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore()
    const a = replica(hub, store, 'a', {}, { exclusiveSession: true })
    const b = replica(hub, store, 'b', {}, { exclusiveSession: true })
    const leaders: string[] = []
    a.bot.on('coordination:leader', () => leaders.push('a'))
    b.bot.on('coordination:leader', () => leaders.push('b'))
    await a.bot.start()
    await vi.waitFor(() => expect(a.provider.starts).toBe(1))
    await b.bot.start()
    await sleep(10)
    expect(b.provider.starts).toBe(0)
    await expect(b.bot.send('c1', 'hi')).rejects.toBeInstanceOf(ProviderNotLeaderError)
    await a.bot.stop()
    expect(a.provider.stops).toBe(1)
    await vi.waitFor(() => expect(b.provider.starts).toBe(1))
    expect(leaders).toEqual(['a', 'b'])
    await b.bot.send('c1', 'hi')
    expect(texts(b.provider)).toEqual(['hi'])
    await b.bot.stop()
  })

  it("'shared' providers start on every replica", async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore()
    const a = replica(hub, store, 'a')
    const b = replica(hub, store, 'b')
    await a.bot.start(); await b.bot.start()
    expect([a.provider.starts, b.provider.starts]).toEqual([1, 1])
    await a.bot.stop(); await b.bot.stop()
  })

  it('validates the coordination config', () => {
    expect(() => new Bot({ provider: new MockProvider(), coordination: { coordinator: {} as Coordinator } })).toThrow(/coordination\.coordinator/)
    expect(() => new Bot({
      provider: new MockProvider(),
      coordination: { coordinator: new MemoryCoordinator(), providerSession: 'x' as 'leader' },
    })).toThrow(/providerSession/)
  })
})
