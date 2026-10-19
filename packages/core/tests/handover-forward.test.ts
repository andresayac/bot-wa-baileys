/**
 * `coordination.handover`: forwarding conversations that are NOT `.persistent()` flows to
 * the replica that takes their chat — ephemeral checkpoints for DSL flows, stubs plus a
 * fallback (notify / restart / custom) for everything that cannot be forwarded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Bot, MemoryCoordinationHub, MemoryCoordinator, flow,
  type BotConfig, type ConversationHandoverConfig, type ConversationHandoverEvent, type InterruptedConversation,
} from '../src/index.js'
import { MockProvider } from '../src/testing/index.js'
import { GatedCheckpointStore } from './support/gatedCheckpointStore.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const texts = (p: MockProvider) => p.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : m.content.kind))

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

const bots: Bot[] = []
afterEach(async () => { for (const b of bots.splice(0)) await b.stop().catch(() => {}) })

interface Shared { hub: MemoryCoordinationHub; store: GatedCheckpointStore }
const shared = (): Shared => ({ hub: new MemoryCoordinationHub(), store: new GatedCheckpointStore() })

function replica(s: Shared, id: string, handover?: ConversationHandoverConfig, extra: Partial<BotConfig> = {}) {
  const provider = new MockProvider()
  const coordinator = new MemoryCoordinator({ hub: s.hub, replicaId: id })
  const bot = new Bot({
    provider, store: s.store, logger: silent(),
    coordination: { coordinator, ...(handover ? { handover } : {}) },
    ...extra,
  })
  bots.push(bot)
  const events: ConversationHandoverEvent[] = []
  bot.on('coordination:handover', (e) => events.push(e))
  const fallthrough: string[] = []
  bot.onMessage(async (ctx) => { fallthrough.push(ctx.body) })
  return { bot, provider, coordinator, events, fallthrough }
}

/** A flow WITHOUT .persistent(). */
function signup(r: ReturnType<typeof replica>, extra?: (b: ReturnType<typeof flow>) => ReturnType<typeof flow>) {
  let f = flow('signup').say('hi')
  if (extra) f = extra(f)
  r.bot.use(f
    .ask('name?', 'name')
    .ask('email?', 'email')
    .say((_ctx, c) => `done ${String(c.state.name)} ${String(c.state.email)}`))
  return r
}

/** An async conversation (cannot be serialized). */
function quiz(r: ReturnType<typeof replica>) {
  r.bot.conversation('quiz', async (c) => {
    const a = await c.ask('q1?')
    const b = await c.ask('q2?')
    await c.say(`quiz ${String(a)} ${String(b)}`)
  }, { trigger: 'quiz' })
  return r
}

describe("flows: 'forward' — non-persistent flows continue on the replica that takes the chat", () => {
  it('after the replica running it crashed', async () => {
    const s = shared()
    const a = signup(replica(s, 'a', { flows: 'forward' }))
    const b = signup(replica(s, 'b', { flows: 'forward' }))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toMatchObject({
      flowId: 'signup', step: 1, parked: true, handover: { kind: 'ephemeral', shape: expect.any(String) },
    }))
    a.coordinator.crash()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']))
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']))
    expect(b.events).toEqual([{ key: 'c1', name: 'signup', outcome: 'resumed' }])
    expect(b.fallthrough).toEqual([])
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toBeUndefined())
  })

  it('after a graceful stop (rolling deploy)', async () => {
    const s = shared()
    const a = signup(replica(s, 'a', { flows: 'forward' }))
    await a.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    await a.bot.stop()
    expect(await s.store.checkpointOf('c1')).toMatchObject({ step: 1, handover: { kind: 'ephemeral' } })
    const b = signup(replica(s, 'b', { flows: 'forward' }))
    await b.bot.start()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']))
  })

  it("is not forwarded without handover (today's behaviour: the message routes normally)", async () => {
    const s = shared()
    const a = signup(replica(s, 'a'))
    const b = signup(replica(s, 'b'))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    a.coordinator.crash()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(b.fallthrough).toEqual(['Ana']))
    expect(texts(b.provider)).toEqual([])
    expect(s.store.writes).toEqual([])                 // no checkpoint at all for a non-persistent flow
  })

  it('a flow whose state is not plain JSON is not forwarded; the fallback applies', async () => {
    const s = shared()
    class Cart { items: string[] = [] }
    const withCart = (f: ReturnType<typeof flow>) => f.do((_ctx, c) => { c.state.cart = new Cart() })
    const a = signup(replica(s, 'a', { flows: 'forward', fallback: 'notify' }), withCart)
    const b = signup(replica(s, 'b', { flows: 'forward', fallback: 'notify' }), withCart)
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    await vi.waitFor(async () => expect((await s.store.checkpointOf('c1'))?.handover?.kind).toBe('stub'))
    a.coordinator.crash()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['⚠️ La conversación anterior se interrumpió. Por favor, empieza de nuevo.']))
    expect(b.events).toEqual([{ key: 'c1', name: 'signup', outcome: 'notified' }])
    expect(b.fallthrough).toEqual([])
  })

  it('a forwarded flow whose definition changed on the new replica goes to the fallback (reason changed)', async () => {
    const s = shared()
    const seen: InterruptedConversation[] = []
    const fallback = async (info: InterruptedConversation) => { seen.push(info); return true }
    const a = signup(replica(s, 'a', { flows: 'forward', fallback }))
    const b = replica(s, 'b', { flows: 'forward', fallback })
    b.bot.use(flow('signup').ask('email first?', 'email').ask('name?', 'name'))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    await vi.waitFor(async () => expect((await s.store.checkpointOf('c1'))?.parked).toBe(true))
    a.coordinator.crash()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ name: 'signup', key: 'c1', reason: 'changed', startedAt: expect.any(Number) })
    expect(b.events).toEqual([{ key: 'c1', name: 'signup', outcome: 'migrated' }])
    expect(texts(b.provider)).toEqual([])
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toBeUndefined())
  })

  it('an expired ephemeral checkpoint is discarded silently; expired entries are cleared on start', async () => {
    const s = shared()
    const a = signup(replica(s, 'a', { flows: 'forward', ttl: 60 }))
    const b = signup(replica(s, 'b', { flows: 'forward', ttl: 60 }))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    a.provider.incoming('signup', { from: 'c2' })
    await vi.waitFor(() => expect(texts(a.provider).sort()).toEqual(['hi', 'hi', 'name?', 'name?']))
    await a.bot.stop()
    await sleep(100)
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(b.fallthrough).toEqual(['Ana']))
    expect(b.events).toEqual([{ key: 'c1', name: 'signup', outcome: 'expired' }])
    // A restarted replica drops the expired leftovers when it loads checkpoints.
    const c = signup(replica(s, 'c', { flows: 'forward', ttl: 60 }))
    await c.bot.start()
    await vi.waitFor(async () => expect(await s.store.listCheckpoints()).toEqual([]))
  })

  it('a resumed ephemeral checkpoint is cleared by a replica that does not forward (mixed config)', async () => {
    const s = shared()
    const a = signup(replica(s, 'a', { flows: 'forward' }))
    const b = signup(replica(s, 'b'))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toMatchObject({ parked: true }))
    a.coordinator.crash()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']))
    b.provider.incoming('ana@x.co', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?', 'done Ana ana@x.co']))
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toBeUndefined())
    // A replica that takes the chat later does not resume the finished flow.
    const c = signup(replica(s, 'c', { flows: 'forward' }))
    await c.bot.start()
    c.provider.incoming('hola', { from: 'c1' })
    await vi.waitFor(() => expect(c.fallthrough).toEqual(['hola']))
    expect(texts(c.provider)).toEqual([])
  })

  it('a parked wait with a timeout longer than the TTL keeps its ephemeral checkpoint resumable', async () => {
    const s = shared()
    const a = signup(replica(s, 'a', { flows: 'forward', ttl: 50 }), (f) => f.timeout('10s'))
    const b = signup(replica(s, 'b', { flows: 'forward', ttl: 50 }), (f) => f.timeout('10s'))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toMatchObject({ parked: true }))
    await sleep(100)                                   // past the TTL, well within the wait's timeout
    a.coordinator.crash()
    b.provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['email?']))
    expect(b.fallthrough).toEqual([])
    expect(b.events).toEqual([{ key: 'c1', name: 'signup', outcome: 'resumed' }])
  })

  it('every wait of a validation-retry loop refreshes the expiry of its ephemeral checkpoint', async () => {
    const s = shared()
    const make = (id: string) => {
      const r = replica(s, id, { flows: 'forward', ttl: 80 })
      r.bot.use(flow('signup').timeout(300)
        .say('hi')
        .ask('name?', 'name', { retries: Infinity, validate: async (body: string) => (body === 'Ana' ? true : 'again?') })
        .ask('email?', 'email'))
      return r
    }
    const a = make('a')
    const b = make('b')
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['hi', 'name?']))
    let retries = 0
    for (const wrong of ['w', 'x', 'y', 'z']) {
      await sleep(100)
      a.provider.incoming(wrong, { from: 'c1' })
      retries++
      await vi.waitFor(() => expect(texts(a.provider).filter((t) => t === 'again?')).toHaveLength(retries))
    }
    await sleep(20)                                    // the step's first write is older than its wait timeout
    a.coordinator.crash()
    b.provider.incoming('Ana', { from: 'c1' })
    // The step restarts on B (its later waits keep no answer), but the flow is not lost.
    await vi.waitFor(() => expect(b.events).toEqual([{ key: 'c1', name: 'signup', outcome: 'resumed' }]))
    expect(b.fallthrough).toEqual([])
  })
})

describe('fallback for conversations that cannot be forwarded (async bot.conversation)', () => {
  async function interruptQuiz(handover: ConversationHandoverConfig | undefined, bHandover: ConversationHandoverConfig | null | undefined = handover) {
    const s = shared()
    const a = quiz(replica(s, 'a', handover))
    const b = quiz(replica(s, 'b', bHandover ?? undefined))
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('quiz', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['q1?']))
    a.coordinator.crash()
    return { s, a, b }
  }

  it("'notify' tells the user and consumes the message", async () => {
    const { s, b } = await interruptQuiz({ fallback: 'notify', notifyMessage: 'Sorry, start again' })
    expect(await s.store.checkpointOf('c1')).toMatchObject({ step: -1, handover: { kind: 'stub', name: 'quiz' } })
    b.provider.incoming('42', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['Sorry, start again']))
    expect(b.fallthrough).toEqual([])
    expect(b.events).toEqual([{ key: 'c1', name: 'quiz', outcome: 'notified' }])
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toBeUndefined())
  })

  it("'restart' re-enters it from the beginning", async () => {
    const { b } = await interruptQuiz({ fallback: 'restart' })
    b.provider.incoming('42', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['q1?']))
    expect(b.events).toEqual([{ key: 'c1', name: 'quiz', outcome: 'restarted' }])
    b.provider.incoming('1', { from: 'c1' })
    b.provider.incoming('2', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['q1?', 'q2?', 'quiz 1 2']))
  })

  it('a custom function migrates it', async () => {
    const calls: Array<{ info: InterruptedConversation; body: string }> = []
    const { b } = await interruptQuiz({
      fallback: async (info, ctx) => { calls.push({ info, body: ctx.body }); await ctx.reply(`resuming ${info.name}`); return true },
    })
    b.provider.incoming('42', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toEqual(['resuming quiz']))
    expect(calls).toEqual([{ info: expect.objectContaining({ name: 'quiz', key: 'c1', reason: 'unforwardable' }), body: '42' }])
    expect(b.events).toEqual([{ key: 'c1', name: 'quiz', outcome: 'migrated' }])
  })

  it("'drop' keeps today's behaviour and writes nothing", async () => {
    const { s, b } = await interruptQuiz({ fallback: 'drop' })
    expect(s.store.writes).toEqual([])
    b.provider.incoming('42', { from: 'c1' })
    await vi.waitFor(() => expect(b.fallthrough).toEqual(['42']))
  })

  it('a replica without handover config drops a stub it does not handle (mixed versions)', async () => {
    const { s, b } = await interruptQuiz({ fallback: 'notify' }, null)
    b.provider.incoming('42', { from: 'c1' })
    await vi.waitFor(() => expect(b.fallthrough).toEqual(['42']))
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toBeUndefined())
  })

  it('the stub is cleared when the conversation ends, and by handoff', async () => {
    const s = shared()
    const a = quiz(replica(s, 'a', { fallback: 'notify' }))
    await a.bot.start()
    a.provider.incoming('quiz', { from: 'c1' })
    await vi.waitFor(async () => expect((await s.store.checkpointOf('c1'))?.handover?.kind).toBe('stub'))
    a.provider.incoming('1', { from: 'c1' })
    a.provider.incoming('2', { from: 'c1' })
    await vi.waitFor(() => expect(texts(a.provider)).toEqual(['q1?', 'q2?', 'quiz 1 2']))
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c1')).toBeUndefined())
    a.provider.incoming('quiz', { from: 'c2' })
    await vi.waitFor(async () => expect((await s.store.checkpointOf('c2'))?.handover?.kind).toBe('stub'))
    await a.bot.handoff('c2')
    await vi.waitFor(async () => expect(await s.store.checkpointOf('c2')).toBeUndefined())
  })

  it('a graceful stop keeps the stub for the next replica', async () => {
    const s = shared()
    const a = quiz(replica(s, 'a', { fallback: 'notify' }))
    await a.bot.start()
    a.provider.incoming('quiz', { from: 'c1' })
    await vi.waitFor(async () => expect((await s.store.checkpointOf('c1'))?.handover?.kind).toBe('stub'))
    await a.bot.stop()
    expect((await s.store.checkpointOf('c1'))?.handover?.kind).toBe('stub')
    const b = quiz(replica(s, 'b', { fallback: 'notify' }))
    await b.bot.start()
    b.provider.incoming('42', { from: 'c1' })
    await vi.waitFor(() => expect(texts(b.provider)).toHaveLength(1))
  })
})

describe('no extra writes unless configured', () => {
  it('without coordination a persistent flow writes one checkpoint per step, as before', async () => {
    const store = new GatedCheckpointStore()
    const provider = new MockProvider()
    const bot = new Bot({ provider, store, logger: silent() })
    bots.push(bot)
    bot.use(flow('signup').persistent().say('hi').ask('name?', 'name').say('bye'))
    bot.conversation('quiz', async (c) => { await c.ask('q?') }, { trigger: 'quiz' })
    await bot.start()
    provider.incoming('signup', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['hi', 'name?']))
    provider.incoming('Ana', { from: 'c1' })
    await vi.waitFor(() => expect(texts(provider)).toEqual(['hi', 'name?', 'bye']))
    provider.incoming('quiz', { from: 'c2' })
    await vi.waitFor(() => expect(texts(provider)).toContain('q?'))
    await sleep(20)
    expect(store.writes.map((w) => [w.key.split('|').pop(), w.cp.step, w.cp.parked, w.cp.answer, w.cp.handover]))
      .toEqual([['c1', 1, undefined, undefined, undefined], ['c1', 2, undefined, undefined, undefined], ['c1', 3, undefined, undefined, undefined]])
  })

  it('validates the handover config', () => {
    const coordinator = new MemoryCoordinator()
    const make = (handover: unknown) => () => new Bot({
      provider: new MockProvider(), coordination: { coordinator, handover: handover as ConversationHandoverConfig },
    })
    expect(make({ flows: 'x' })).toThrow(/coordination\.handover\.flows/)
    expect(make({ fallback: 'later' })).toThrow(/coordination\.handover\.fallback/)
    expect(make({ maxAnswerBytes: -1 })).toThrow(/maxAnswerBytes/)
    expect(make({ ttl: {} })).toThrow(/coordination\.handover\.ttl/)
    expect(make({ flows: 'forward', fallback: () => true, ttl: '10m', maxAnswerBytes: 0 })).not.toThrow()
  })
})
