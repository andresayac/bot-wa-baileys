/**
 * Tracing x checkpoints / hand-over: a checkpoint carries the W3C trace context of the turn
 * that wrote it (`FlowCheckpoint.trace`), and the process that resumes it links its first
 * turn to that span (the parent stays the waking message's dispatch).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Bot, MemoryCoordinationHub, MemoryCoordinator, MemoryStore, TRACE_ATTR, flow, formatTraceparent,
  type BotConfig, type ConversationHandoverConfig, type FlowCheckpoint, type InterruptedConversation,
} from '../src/index.js'
import { MockProvider, createRecordingTracer, type RecordedSpan, type RecordingTracer } from '../src/testing/index.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

const bots: Bot[] = []
afterEach(async () => { for (const b of bots.splice(0)) await b.stop().catch(() => {}) })

function traced(config: Omit<BotConfig, 'provider' | 'telemetry'>, rec: RecordingTracer) {
  const provider = new MockProvider()
  const bot = new Bot({ logger: silent(), ...config, provider, telemetry: { tracer: rec.tracer, ids: 'raw' } })
  bot.on('error', () => {})
  bots.push(bot)
  return { bot, provider, rec }
}

const turns = (rec: RecordingTracer): RecordedSpan[] => rec.findAll('bot.conversation.turn')
const dispatchOf = (rec: RecordingTracer, messageId: string) =>
  rec.find('bot.dispatch', (s) => rec.parentOf(s)?.attributes[TRACE_ATTR.messageId] === messageId)!
const traceparentOf = (span: RecordedSpan) => formatTraceparent({ traceId: span.traceId, spanId: span.spanId })!

async function onlyCheckpoint(store: MemoryStore): Promise<FlowCheckpoint | undefined> {
  return (await store.listCheckpoints())[0]?.[1]
}

describe('telemetry: trace context carried by checkpoints', () => {
  it('a persistent flow resumed after a restart links its dormant turn to the turn that wrote the checkpoint', async () => {
    const store = new MemoryStore({})
    const persistent = () => flow('registrar').persistent().say('bienvenido').ask('¿nombre?', 'name').ask('¿email?', 'email')

    const recA = createRecordingTracer({ w3c: true, traceState: 'vendor=a' })
    const first = traced({ store }, recA)
    first.bot.use(persistent())
    await first.bot.start()
    first.provider.incoming('registrar', { from: 'u1', id: 'm1' })
    await tick()
    first.provider.incoming('Ana', { from: 'u1', id: 'm2' })
    await tick()
    await first.bot.stop()

    // The turn that answered 'Ana' wrote the checkpoint and parked (stop() then adds a closing turn).
    const parked = turns(recA).filter((t) => t.attributes[TRACE_ATTR.conversationParked] === true).at(-1)!
    expect(parked.attributes[TRACE_ATTR.conversationReason]).toBe('reply')
    expect((await onlyCheckpoint(store))?.trace).toEqual({ traceparent: traceparentOf(parked), tracestate: 'vendor=a' })

    const recB = createRecordingTracer({ w3c: true })
    const second = traced({ store }, recB)
    second.bot.use(persistent())
    await second.bot.start()
    second.provider.incoming('hola?', { from: 'u1', id: 'w1' })
    await tick()
    const turn = turns(recB)[0]!
    expect(turn.attributes[TRACE_ATTR.conversationReason]).toBe('dormant')
    // Parent: the waking message's own dispatch (its trace stays whole) …
    expect(recB.parentOf(turn)).toBe(dispatchOf(recB, 'w1'))
    // … link: the previous process's last turn, as a remote context with its tracestate.
    expect(turn.links).toEqual([{
      context: { traceId: parked.traceId, spanId: parked.spanId, traceFlags: 1, traceState: 'vendor=a', isRemote: true },
      attributes: { [TRACE_ATTR.linkReason]: 'resume' },
    }])
  })

  it('without telemetry, or with a tracer whose ids are not W3C-shaped, checkpoints carry no trace', async () => {
    for (const telemetry of [undefined, { tracer: createRecordingTracer().tracer }]) {
      const store = new MemoryStore({})
      const provider = new MockProvider()
      const bot = new Bot({ provider, store, logger: silent(), ...(telemetry ? { telemetry } : {}) })
      bots.push(bot)
      bot.use(flow('registrar').persistent().ask('¿nombre?', 'name').ask('¿email?', 'email'))
      await bot.start()
      provider.incoming('registrar', { from: 'u1' })
      await tick()
      provider.incoming('Ana', { from: 'u1' })
      await tick()
      const cp = await onlyCheckpoint(store)
      expect(cp?.step).toBeGreaterThan(0)
      expect(cp && 'trace' in cp).toBe(false)
    }
  })

  it('a malformed stored trace is ignored (the flow resumes without a link)', async () => {
    const store = new MemoryStore({})
    const persistent = () => flow('registrar').persistent().ask('¿nombre?', 'name').ask('¿email?', 'email')
    const recA = createRecordingTracer({ w3c: true })
    const first = traced({ store }, recA)
    first.bot.use(persistent())
    await first.bot.start()
    first.provider.incoming('registrar', { from: 'u1' })
    await tick()
    first.provider.incoming('Ana', { from: 'u1' })
    await tick()
    await first.bot.stop()
    const [[key, cp]] = await store.listCheckpoints() as [[string, FlowCheckpoint]]
    await store.setCheckpoint(key, { ...cp, trace: { traceparent: 'not-a-traceparent' } })

    const recB = createRecordingTracer({ w3c: true })
    const second = traced({ store }, recB)
    second.bot.use(persistent())
    await second.bot.start()
    second.provider.incoming('a@b.co', { from: 'u1' })
    await tick()
    expect(turns(recB)[0]!.attributes[TRACE_ATTR.conversationReason]).toBe('dormant')
    expect(turns(recB)[0]!.links).toEqual([])
  })
})

describe('telemetry: trace context across a multi-replica hand-over', () => {
  function replica(hub: MemoryCoordinationHub, store: MemoryStore, id: string, rec: RecordingTracer, handover: ConversationHandoverConfig) {
    const coordinator = new MemoryCoordinator({ hub, replicaId: id })
    return { ...traced({ store, coordination: { coordinator, handover } }, rec), coordinator }
  }

  it("a forwarded flow continues on the replica that took the chat, linked to the last turn of the replica that ran it", async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore({})
    const recA = createRecordingTracer({ w3c: true, traceState: 'vendor=a' })
    const recB = createRecordingTracer({ w3c: true })
    const signup = () => flow('signup').ask('name?', 'name').ask('email?', 'email').say('done')
    const a = replica(hub, store, 'a', recA, { flows: 'forward' })
    const b = replica(hub, store, 'b', recB, { flows: 'forward' })
    a.bot.use(signup()); b.bot.use(signup())
    await a.bot.start(); await b.bot.start()

    a.provider.incoming('signup', { from: 'c1', id: 'm1' })
    await vi.waitFor(() => expect(a.provider.outbox).toHaveLength(1))
    a.provider.incoming('Ana', { from: 'c1', id: 'm2' })
    await vi.waitFor(() => expect(a.provider.outbox).toHaveLength(2))
    // The marker write of the parked step refreshes the carried context to the latest turn.
    const last = turns(recA).at(-1)!
    await vi.waitFor(async () => expect((await onlyCheckpoint(store))?.trace?.traceparent).toBe(traceparentOf(last)))

    a.coordinator.crash()
    b.provider.incoming('ana@x.co', { from: 'c1', id: 'm3' })
    await vi.waitFor(() => expect(b.provider.outbox.map((m) => m.content.kind === 'text' && m.content.text)).toEqual(['done']))
    const resumed = turns(recB)[0]!
    expect(resumed.attributes[TRACE_ATTR.conversationReason]).toBe('dormant')
    expect(recB.parentOf(resumed)).toBe(dispatchOf(recB, 'm3'))
    expect(resumed.links[0]?.context).toMatchObject({ traceId: last.traceId, spanId: last.spanId, traceState: 'vendor=a', isRemote: true })
  })

  it("a hand-over stub carries the trace: 'restart' links the restarted conversation; a custom fallback receives it", async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore({})
    const recA = createRecordingTracer({ w3c: true })
    const recB = createRecordingTracer({ w3c: true })
    const quiz = (bot: Bot) => bot.conversation('quiz', async (c) => { await c.ask('q1?'); await c.ask('q2?') }, { trigger: 'quiz' })
    const a = replica(hub, store, 'a', recA, { fallback: 'restart' })
    const b = replica(hub, store, 'b', recB, { fallback: 'restart' })
    quiz(a.bot); quiz(b.bot)
    await a.bot.start(); await b.bot.start()
    a.provider.incoming('quiz', { from: 'c1', id: 'm1' })
    await vi.waitFor(async () => expect((await onlyCheckpoint(store))?.handover?.kind).toBe('stub'))
    const stubTurn = turns(recA).at(-1)!
    expect((await onlyCheckpoint(store))?.trace?.traceparent).toBe(traceparentOf(stubTurn))

    a.coordinator.crash()
    b.provider.incoming('x', { from: 'c1', id: 'm2' })
    await vi.waitFor(() => expect(turns(recB)).toHaveLength(1))
    const restarted = turns(recB)[0]!
    expect(restarted.attributes[TRACE_ATTR.conversationReason]).toBe('start')
    expect(restarted.links[0]?.context).toMatchObject({ traceId: stubTurn.traceId, spanId: stubTurn.spanId, isRemote: true })

    // A custom fallback gets the carried context in `info.trace`.
    const hub2 = new MemoryCoordinationHub()
    const store2 = new MemoryStore({})
    const seen: InterruptedConversation[] = []
    const c = replica(hub2, store2, 'c', createRecordingTracer({ w3c: true }), { fallback: 'notify' })
    const d = replica(hub2, store2, 'd', createRecordingTracer({ w3c: true }), { fallback: (info) => { seen.push(info); return true } })
    quiz(c.bot); quiz(d.bot)
    await c.bot.start(); await d.bot.start()
    c.provider.incoming('quiz', { from: 'c1' })
    await vi.waitFor(async () => expect((await onlyCheckpoint(store2))?.handover?.kind).toBe('stub'))
    const stored = (await onlyCheckpoint(store2))!.trace
    c.coordinator.crash()
    d.provider.incoming('x', { from: 'c1' })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]!.trace).toEqual(stored)
  })
})
