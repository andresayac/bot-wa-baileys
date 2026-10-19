import { describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import type { BotConfig } from '../src/core/types.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { MemoryCoordinationHub, MemoryCoordinator, TRACE_ATTR } from '../src/index.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { createRecordingTracer, type RecordedSpan, type RecordingTracer } from '../src/testing/recordingTracer.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

async function tracedBot(config: Omit<BotConfig, 'provider' | 'telemetry'> = {}, rec: RecordingTracer = createRecordingTracer()) {
  const provider = new MockProvider()
  const bot = new Bot({ ...config, provider, telemetry: { tracer: rec.tracer, ids: 'raw' } })
  bot.on('error', () => {})
  await bot.start()
  return { rec, bot, provider }
}

const turns = (rec: RecordingTracer): RecordedSpan[] => rec.findAll('bot.conversation.turn')
const dispatchOf = (rec: RecordingTracer, messageId: string) =>
  rec.find('bot.dispatch', (s) => rec.parentOf(s)?.attributes[TRACE_ATTR.messageId] === messageId)!

describe('telemetry: conversation turns', () => {
  it('a turn per stretch between waits: start under the handler, replies under their own dispatch', async () => {
    const { rec, bot, provider } = await tracedBot()
    bot.use(flow('registro').ask('¿nombre?', 'name').ask('¿email?', 'email').say('fin'))
    provider.incoming('registro', { from: 'u1', id: 'm1' })
    await tick()
    provider.incoming('Ana', { from: 'u1', id: 'm2' })
    await tick()
    provider.incoming('a@b.co', { from: 'u1', id: 'm3' })
    await tick()

    const [t1, t2, t3] = turns(rec)
    expect(turns(rec)).toHaveLength(3)
    expect(rec.parentOf(t1!)?.name).toBe('bot.handler')
    expect(t1!.attributes).toMatchObject({
      [TRACE_ATTR.conversationName]: 'registro',
      [TRACE_ATTR.conversationReason]: 'start',
      [TRACE_ATTR.conversationParked]: true,
    })
    const id = t1!.attributes[TRACE_ATTR.conversationId]
    expect(typeof id).toBe('string')
    expect(t2!.attributes).toMatchObject({ [TRACE_ATTR.conversationId]: id, [TRACE_ATTR.conversationReason]: 'reply', [TRACE_ATTR.conversationParked]: true })
    expect(rec.parentOf(t2!)).toBe(dispatchOf(rec, 'm2'))
    expect(dispatchOf(rec, 'm2').attributes[TRACE_ATTR.dispatchStage]).toBe('conversation')
    expect(rec.parentOf(t3!)).toBe(dispatchOf(rec, 'm3'))
    expect(t3!.attributes).toMatchObject({ [TRACE_ATTR.conversationOutcome]: 'completed' })
    expect(t3!.attributes[TRACE_ATTR.conversationParked]).toBeUndefined()
    // Flow steps are events on the turn running them; sends land under that turn.
    expect(t1!.events.map((e) => e.attributes?.['bot.flow.step.index'])).toEqual([0])
    expect(t2!.events.map((e) => e.attributes?.['bot.flow.step.kind'])).toEqual(['ask'])
    expect(t3!.events.map((e) => e.attributes?.['bot.flow.step.kind'])).toEqual(['say'])
    const finSend = rec.childrenOf(t3!).find((s) => s.name === 'bot.pace' || s.name === 'bot.send')
    expect(finSend).toBeDefined()
    for (const s of rec.spans) expect(s.ended, s.name).toBe(true)
    // No answers or state in any attribute.
    expect(rec.allValues().some((v) => v.includes('Ana') || v.includes('a@b.co'))).toBe(false)
    await bot.stop()
  })

  it('a wait timeout opens a root turn linked to the first one', async () => {
    const { rec, bot, provider } = await tracedBot()
    bot.conversation('espera', async (c) => { await c.ask('¿?', { timeout: 15 }) })
    provider.incoming('espera', { from: 'u1' })
    await vi.waitFor(() => expect(turns(rec).at(-1)?.attributes[TRACE_ATTR.conversationOutcome]).toBe('timedOut'))
    const [first, timeout] = turns(rec)
    expect(timeout!.parentId).toBeUndefined()
    expect(timeout!.attributes[TRACE_ATTR.conversationReason]).toBe('timeout')
    expect(timeout!.links.map((l) => l.context.spanId)).toEqual([first!.spanId])
    // The timeout message goes out under the timeout turn.
    await vi.waitFor(() => expect(rec.childrenOf(timeout!).length).toBeGreaterThan(0))
    await bot.stop()
  })

  it('goto starts the target as a new conversation with reason goto', async () => {
    const { rec, bot, provider } = await tracedBot()
    bot.conversation('fin', async (c) => { await c.say('adiós') }, { trigger: '__fin__' })
    bot.conversation('inicio', async (c) => { await c.ask('¿seguir?'); c.goto('fin') })
    provider.incoming('inicio', { from: 'u1' })
    await tick()
    provider.incoming('sí', { from: 'u1' })
    await tick()
    const names = turns(rec).map((t) => [t.attributes[TRACE_ATTR.conversationName], t.attributes[TRACE_ATTR.conversationReason], t.attributes[TRACE_ATTR.conversationOutcome]])
    expect(names).toEqual([
      ['inicio', 'start', undefined],
      ['inicio', 'reply', 'completed'],
      ['fin', 'goto', 'completed'],
    ])
    expect(turns(rec)[1]!.attributes[TRACE_ATTR.conversationGoto]).toBe('fin')
    await bot.stop()
  })

  it('a conversation aborted while parked (/reset) gets a closing turn with outcome cancelled', async () => {
    const { rec, bot, provider } = await tracedBot()
    bot.command('reset', (ctx) => { bot.abortConversation(ctx) })
    bot.conversation('larga', async (c) => { await c.ask('¿algo?') })
    provider.incoming('larga', { from: 'u1' })
    await tick()
    provider.incoming('/reset', { from: 'u1', id: 'r1' })
    await tick()
    const closing = turns(rec).at(-1)!
    expect(closing.attributes).toMatchObject({ [TRACE_ATTR.conversationReason]: 'end', [TRACE_ATTR.conversationOutcome]: 'cancelled' })
    expect(rec.parentOf(closing)?.name).toBe('bot.handler')
    expect(closing.links).toHaveLength(1)
    await bot.stop()
  })

  it('a dormant checkpoint resumed after a restart is a turn with reason dormant', async () => {
    const store = new MemoryStore({})
    const persistent = () => flow('registrar').persistent().say('bienvenido').ask('¿nombre?', 'name').ask('¿email?', 'email')
    const first = await tracedBot({ store })
    first.bot.use(persistent())
    first.provider.incoming('registrar', { from: 'u1' })
    await tick()
    await first.bot.stop()

    const second = await tracedBot({ store })
    second.bot.use(persistent())
    second.provider.incoming('hola?', { from: 'u1', id: 'w1' })
    await tick()
    const turn = turns(second.rec)[0]!
    expect(turn.attributes).toMatchObject({ [TRACE_ATTR.conversationName]: 'registrar', [TRACE_ATTR.conversationReason]: 'dormant' })
    expect(dispatchOf(second.rec, 'w1').attributes[TRACE_ATTR.dispatchStage]).toBe('dormant')
    await second.bot.stop()
  })

  it('a trigger-started conversation is traced under bot.trigger; stop() ends open turns', async () => {
    const { rec, bot } = await tracedBot()
    bot.conversation('aviso', async (c) => { await c.ask('¿confirmas?') }, { trigger: '__never__' })
    await bot.trigger('aviso', { chatId: 'c1' })
    await tick()
    await bot.stop()
    const all = turns(rec)
    expect(rec.parentOf(all[0]!)?.name).toBe('bot.trigger')
    expect(all.at(-1)!.attributes[TRACE_ATTR.conversationOutcome]).toBe('cancelled')
    for (const s of rec.spans) expect(s.ended, s.name).toBe(true)
  })

  it('multi-replica coordination works with tracing on', async () => {
    const hub = new MemoryCoordinationHub()
    const store = new MemoryStore({})
    const rec = createRecordingTracer()
    const { bot, provider } = await tracedBot({ store, coordination: { coordinator: new MemoryCoordinator({ hub, replicaId: 'a' }) } }, rec)
    bot.use(flow('pedido').ask('¿qué?', 'item').say('ok'))
    provider.incoming('pedido', { from: 'u1' })
    await vi.waitFor(() => expect(provider.outbox.length).toBe(1))
    provider.incoming('pan', { from: 'u1' })
    await vi.waitFor(() => expect(provider.outbox.length).toBe(2))
    await vi.waitFor(() => expect(turns(rec).at(-1)?.attributes[TRACE_ATTR.conversationOutcome]).toBe('completed'))
    await bot.stop()
  })
})
