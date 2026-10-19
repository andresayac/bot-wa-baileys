/**
 * Durability × coordination: when an inbound record is acknowledged relative to the
 * checkpoint writes that hand its effect over to another replica (the `parked` marker,
 * the recorded answer of a step cut short), and what the replica that takes the chat
 * does with them. See docs/guide/replicas.md, "Conversation hand-over".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Bot, MemoryCoordinationHub, MemoryCoordinator, MemoryDurability, flow,
  type BotConfig, type DurabilityBackend, type MessageContext,
} from '../src/index.js'
import { CrashableProvider, crashable } from '../src/testing/index.js'
import { GatedCheckpointStore } from './support/gatedCheckpointStore.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

const texts = (...ps: CrashableProvider[]) => ps.flatMap((p) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind)))

interface Shared { hub: MemoryCoordinationHub; store: GatedCheckpointStore; journal: MemoryDurability }
const shared = (): Shared => ({ hub: new MemoryCoordinationHub(), store: new GatedCheckpointStore(), journal: new MemoryDurability() })

const bots: Bot[] = []
afterEach(async () => {
  for (const b of bots.splice(0)) await Promise.race([b.stop().catch(() => {}), sleep(500)])
})

interface ReplicaOpts {
  durable?: boolean
  journal?: DurabilityBackend
  settleMs?: number
  extra?: Partial<BotConfig>
}

function replica(s: Shared, id: string, o: ReplicaOpts = {}) {
  const provider = new CrashableProvider()
  const coordinator = new MemoryCoordinator({ hub: s.hub, replicaId: id })
  const bot = new Bot({
    provider,
    store: s.store,
    botId: 'shop',
    logger: silent(),
    coordination: { coordinator, ...(o.settleMs !== undefined ? { settleMs: o.settleMs } : {}) },
    ...(o.durable === false ? {} : {
      durability: { journal: o.journal ?? s.journal, instanceId: id, pollMs: 10, inbox: { leaseMs: 300 } },
    }),
    ...o.extra,
  })
  bots.push(bot)
  return { bot, provider, coordinator }
}

/** say → ask name (validated) → ask email → done. */
function signup(r: ReturnType<typeof replica>, validate?: (body: string) => Promise<true | string>) {
  r.bot.use(flow('signup').persistent()
    .say('hi')
    .ask('name?', 'name', validate ? { validate } : undefined)
    .ask('email?', 'email')
    .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
  return r
}

async function inboxState(bot: Bot, body?: string): Promise<string | undefined> {
  const records = await bot.durability!.inbox.list()
  const rec = body === undefined
    ? records[records.length - 1]
    : records.find((r) => JSON.stringify(r.payload).includes(`"body":"${body}"`))
  return rec?.state
}

describe('ack ordering: the inbound record is acknowledged only after the parked marker landed', () => {
  it('keeps the record processing while the marker write is in flight', async () => {
    const s = shared()
    const a = signup(replica(s, 'a'))
    await a.bot.start()
    const held = s.store.hold((cp) => cp.parked === true)
    a.provider.incoming('signup', { from: 'c1' })
    await held.reached
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    await sleep(60)
    expect(await inboxState(a.bot, 'signup')).toBe('processing')
    held.release()
    await vi.waitFor(async () => expect(await inboxState(a.bot, 'signup')).toBe('done'))
  })

  it('a crash between the prompt and its marker replays the record on another replica: asked once, answered once', async () => {
    const s = shared()
    const journalA = crashable(s.journal)
    const a = signup(replica(s, 'a', { journal: journalA }))
    const b = signup(replica(s, 'b'))
    await a.bot.start(); await b.bot.start()
    s.store.hold((cp) => cp.parked === true)              // never lands: the process dies with it in flight
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    await sleep(20)
    // A dies: its journal, transport and coordinator stop making progress.
    journalA.crash(); a.provider.crash(); a.coordinator.crash()
    // B's sweeper takes the record over once A's lease lapses and re-runs the parked step
    // under its recorded causation: the prompt is answered from the outbox, not repeated.
    await vi.waitFor(async () => expect(await inboxState(b.bot, 'signup')).toBe('done'), { timeout: 5_000 })
    expect(texts(b.provider)).toEqual([])
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']))
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']))
    expect(texts(a.provider, b.provider).filter((t) => t === 'name?')).toHaveLength(1)
  })
})

describe('a step cut short after its first wait consumed the answer', () => {
  for (const durable of [true, false]) {
    it(`records the answer, acknowledges it as handed over and continues with it on the next replica (durability ${durable ? 'on' : 'off'})`, async () => {
      const s = shared()
      let slow = true
      const validate = async (): Promise<true> => { if (slow) { slow = false; await sleep(400) } return true }
      const a = signup(replica(s, 'a', { durable, settleMs: 40 }), validate)
      const b = signup(replica(s, 'b', { durable }), validate)
      const resumed: unknown[] = []
      b.bot.on('conversation:started', (e) => resumed.push(e.name))
      await a.bot.start(); await b.bot.start()
      a.provider.incoming('signup', { from: 'c1' })
      await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
      a.provider.incoming('Ana', { from: 'c1' })
      // The validator outlives settleMs: A suspends the step. Its answer is in the checkpoint.
      await vi.waitFor(async () => expect((await s.store.checkpointOf('c1'))?.answer).toBeDefined())
      const cp = (await s.store.checkpointOf('c1'))!
      expect(cp).toMatchObject({ step: 1, parked: false })
      if (durable) {
        expect(cp.answer).toMatchObject({ inboundId: expect.any(String) })
        expect(cp.answer!.message).toBeUndefined()
        await vi.waitFor(async () => expect(await inboxState(a.bot, 'Ana')).toBe('done'))
      } else {
        expect(cp.answer).toMatchObject({ message: expect.objectContaining({ body: 'Ana', chatId: 'c1' }) })
      }
      b.provider.incoming('ana@x.co', { from: 'c1' })
      await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']))
      await sleep(450)                                    // A's late validator: fenced, silent
      expect(texts(a.provider)).toEqual(['hi', 'name?'])
      expect(await s.store.checkpointOf('c1')).toBeUndefined()
      expect(resumed).toEqual(['signup'])
    })
  }

  it('a failed answer-marker write releases the record instead (replayed, then taken as the answer)', async () => {
    const s = shared()
    let slow = true
    const validate = async (): Promise<true> => { if (slow) { slow = false; await sleep(300) } return true }
    const a = signup(replica(s, 'a', { settleMs: 40 }), validate)
    const b = signup(replica(s, 'b'), validate)
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    const failed = s.store.failNext((cp) => cp.answer !== undefined)
    a.provider.incoming('Ana', { from: 'c1' })
    await failed
    // Not acknowledged as handed over (the checkpoint does not hold it): released and replayed.
    await vi.waitFor(() => expect(texts(a.provider, b.provider)).toContain('email?'), { timeout: 5_000 })
    await vi.waitFor(async () => expect(await inboxState(a.bot, 'Ana')).toBe('done'), { timeout: 5_000 })
    const all = texts(a.provider, b.provider)
    expect(all.filter((t) => t === 'name?')).toHaveLength(1)
    expect(all.filter((t) => t === 'email?')).toHaveLength(1)
    const owner = texts(a.provider).includes('email?') ? a : b
    owner.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider, b.provider)).toContain('done Ana ana@x.co'))
  })

  it('a turn that ends while the answer marker is in flight acknowledges only once it landed', async () => {
    const s = shared()
    const a = signup(replica(s, 'a', { settleMs: 40 }))
    const b = signup(replica(s, 'b'))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    const held = s.store.hold((cp) => cp.answer !== undefined)
    a.provider.incoming('Ana', { from: 'c1' })
    await held.reached
    await sleep(120)                                     // settleMs elapsed: the step was suspended
    expect(await inboxState(a.bot, 'Ana')).toBe('processing')
    held.release()
    await vi.waitFor(async () => expect(await inboxState(a.bot, 'Ana')).toBe('done'))
    expect((await s.store.checkpointOf('c1'))?.answer).toBeDefined()
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']))
  })

  it('carries what the before-hooks made of the answer (a voice transcript), not the raw message', async () => {
    const s = shared()
    let slow = true
    const validate = async (): Promise<true> => { if (slow) { slow = false; await sleep(300) } return true }
    const a = signup(replica(s, 'a', { settleMs: 40 }), validate)
    const b = signup(replica(s, 'b'), validate)
    a.bot.before('message', async (ctx: MessageContext, next) => {
      if (ctx.type === 'audio') { ctx.body = 'Ana (transcript)'; ctx.type = 'text' }
      await next()
    })
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    a.provider.incoming('', { from: 'c1', type: 'audio' })
    await vi.waitFor(async () => expect((await s.store.checkpointOf('c1'))?.answer?.body).toBe('Ana (transcript)'))
    await vi.waitFor(async () => expect(await inboxState(a.bot)).toBe('done'))
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana (transcript) ana@x.co']))
  })

  it('a step cut short after a LATER wait consumed its answer releases that record (the checkpoint does not hold it)', async () => {
    const s = shared()
    let slow = true
    const make = (id: string, settleMs?: number) => {
      const r = replica(s, id, settleMs !== undefined ? { settleMs } : {})
      r.bot.use(flow('two').persistent()
        .say('hi')
        .do(async (_ctx, c) => {
          c.state.a = await c.ask('q1?')
          c.state.b = await c.ask('q2?')
          if (slow && id === 'a') { slow = false; await sleep(400) }
        })
        .say((_ctx, c) => `done ${String(c.state.a)} ${String(c.state.b)}`))
      return r
    }
    const a = make('a', 40)
    const b = make('b')
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('two', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'q1?']))
    a.provider.incoming('x', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'q1?', 'q2?']))
    a.provider.incoming('y', { from: 'c1' })
    // Suspended mid-step: the answer of q2 is in no checkpoint, so its record is released
    // (redelivered) instead of being acknowledged as handed over.
    await vi.waitFor(async () => {
      const rec = (await a.bot.durability!.inbox.list()).find((r) => JSON.stringify(r.payload).includes('"body":"y"'))
      // Released once, then claimed again (a release does not count as an attempt).
      expect(rec).toMatchObject({ state: 'done', fencingToken: 2 })
    }, { timeout: 5_000 })
  })

  it('a later wait of a multi-wait step drops the recorded answer: the step restarts, as before', async () => {
    const s = shared()
    const make = (id: string) => {
      const r = replica(s, id, { durable: false })
      r.bot.use(flow('two').persistent()
        .say('hi')
        .do(async (_ctx, c) => {
          c.state.a = await c.ask('q1?')
          c.state.b = await c.ask('q2?')
        })
        .say((_ctx, c) => `done ${String(c.state.a)} ${String(c.state.b)}`))
      return r
    }
    const a = make('a')
    const b = make('b')
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('two', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'q1?']))
    a.provider.incoming('x', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'q1?', 'q2?']))
    await vi.waitFor(async () => {
      const cp = await s.store.checkpointOf('c1')
      expect(cp?.answer).toBeUndefined()
      expect(cp?.parked).toBe(false)
    })
    b.provider.incoming('y', { from: 'c1' })                 // meant for q2: the step restarts instead
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['q1?']))
    b.provider.incoming('x2', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['q1?', 'q2?']))
    b.provider.incoming('y2', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['q1?', 'q2?', 'done x2 y2']))
  })
})
