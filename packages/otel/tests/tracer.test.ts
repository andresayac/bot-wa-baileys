import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bot, flow, MemoryStore, TRACE_ATTR } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'

import { createOtelTracer, otelTracer } from '../src/index.js'
import { api, memoryTracing, tick } from './helpers.js'

let env: ReturnType<typeof memoryTracing> | undefined
afterEach(async () => { await env?.close(); env = undefined })

async function otelBot(telemetry: Record<string, unknown> = {}) {
  env = memoryTracing()
  const tracer = otelTracer({ api, tracerProvider: env.provider, spanMetrics: false })
  const provider = new MockProvider()
  const bot = new Bot({ provider, telemetry: { tracer, ids: 'raw', ...telemetry } })
  bot.on('error', () => {})
  await bot.start()
  return { bot, provider, env }
}

describe('otelTracer', () => {
  it('maps the bot span tree to OpenTelemetry spans (kinds, parents, attributes)', async () => {
    const { bot, provider, env } = await otelBot()
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    provider.incoming('hola', { from: 'u1' })
    await tick()
    const inbound = env.byName('bot.inbound')!
    expect(inbound.kind).toBe(api.SpanKind.CONSUMER)
    expect(inbound.parentSpanContext).toBeUndefined()
    expect(inbound.attributes).toMatchObject({ [TRACE_ATTR.inboundOutcome]: 'dispatched', [TRACE_ATTR.chatId]: 'u1' })
    const send = env.byName('bot.send')!
    expect(send.kind).toBe(api.SpanKind.CLIENT)
    const chain: string[] = []
    for (let s: typeof send | undefined = send; s; s = env.parentOf(s)) chain.unshift(s.name)
    expect(chain).toEqual(['bot.inbound', 'bot.dispatch', 'bot.handler', 'bot.pace', 'bot.send'])
    // Same trace for the whole message (the lifecycle spans of `bot.start()` are their own traces).
    const message = [inbound, env.byName('bot.dispatch')!, env.byName('bot.handler')!, send]
    expect(new Set(message.map((s) => s.spanContext().traceId)).size).toBe(1)
    await bot.stop()
  })

  it('a user OTel span inside a handler nests under bot.handler (withSpan bridge)', async () => {
    const { bot, provider, env } = await otelBot()
    const tracer = env.provider.getTracer('app')
    bot.when('hola', async () => {
      await tracer.startActiveSpan('erp.lookup', async (span) => { await tick(1); span.end() })
    })
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(env.parentOf(env.byName('erp.lookup')!)?.name).toBe('bot.handler')
    await bot.stop()
  })

  it('an active OTel context (e.g. an HTTP webhook span) parents bot.inbound', async () => {
    const { bot, provider, env } = await otelBot()
    const tracer = env.provider.getTracer('http')
    const webhook = tracer.startSpan('POST /webhook')
    api.context.with(api.trace.setSpan(api.context.active(), webhook), () => provider.incoming('hola', { from: 'u1' }))
    await tick()
    webhook.end()
    expect(env.parentOf(env.byName('bot.inbound')!)?.name).toBe('POST /webhook')
    await bot.stop()
  })

  it('errors map to status ERROR with a sanitized exception event', async () => {
    const { bot, provider, env } = await otelBot()
    bot.when('x', () => { throw new TypeError('secreto 123') })
    provider.incoming('x', { from: 'u1' })
    await tick()
    const handler = env.byName('bot.handler')!
    expect(handler.status.code).toBe(api.SpanStatusCode.ERROR)
    expect(handler.status.message).toBeUndefined()
    expect(handler.attributes[TRACE_ATTR.errorType]).toBe('TypeError')
    const exception = handler.events.find((e) => e.name === 'exception')!
    expect(exception.attributes?.['exception.type']).toBe('TypeError')
    expect(JSON.stringify(env.spans().map((s) => [s.attributes, s.events]))).not.toContain('secreto')
    await bot.stop()
  })

  it('a timed-out conversation turn is a root span linked to the first turn', async () => {
    const { bot, provider, env } = await otelBot()
    bot.conversation('espera', async (c) => { await c.ask('¿?', { timeout: 15 }) })
    provider.incoming('espera', { from: 'u1' })
    await vi.waitFor(() => expect(env.spans().filter((s) => s.name === 'bot.conversation.turn')).toHaveLength(2))
    const [first, timeout] = env.spans().filter((s) => s.name === 'bot.conversation.turn').sort((a, b) =>
      a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1])
    expect(timeout!.parentSpanContext).toBeUndefined()
    expect(timeout!.links.map((l) => l.context.spanId)).toEqual([first!.spanContext().spanId])
    expect(timeout!.spanContext().traceId).not.toBe(first!.spanContext().traceId)
    await bot.stop()
  })

  it('spanContext() reports the W3C tracestate; links carry tracestate and isRemote back to OTel', () => {
    env = memoryTracing()
    const tracer = otelTracer({ api, tracerProvider: env.provider, spanMetrics: false })
    const remote = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: 1, isRemote: true, traceState: api.createTraceState('vendor=a') }
    const parent = api.trace.setSpanContext(api.context.active(), remote)
    const child = api.context.with(parent, () => tracer.startSpan('child'))
    expect(child.spanContext()).toMatchObject({ traceId: remote.traceId, traceState: 'vendor=a' })
    const linked = tracer.startSpan('linked', { links: [{ context: { traceId: remote.traceId, spanId: remote.spanId, traceState: 'vendor=a', isRemote: true } }] })
    child.end(); linked.end()
    const link = env.byName('linked')!.links[0]!
    expect(link.context.isRemote).toBe(true)
    expect(link.context.traceState?.serialize()).toBe('vendor=a')
    // A link without those fields keeps today's mapping.
    const plain = tracer.startSpan('plain', { links: [{ context: { traceId: remote.traceId, spanId: remote.spanId } }] })
    plain.end()
    expect(env.byName('plain')!.links[0]!.context.isRemote).toBe(false)
    expect(env.byName('plain')!.links[0]!.context.traceState).toBeUndefined()
  })

  it('a persistent flow resumed by another process links its dormant turn to the previous turn (remote, with tracestate)', async () => {
    env = memoryTracing()
    const store = new MemoryStore({})
    const tracer = otelTracer({ api, tracerProvider: env.provider, spanMetrics: false })
    const make = async () => {
      const provider = new MockProvider()
      const bot = new Bot({ provider, store, telemetry: { tracer, ids: 'raw' } })
      bot.on('error', () => {})
      bot.use(flow('registrar').persistent().ask('¿nombre?', 'name').ask('¿email?', 'email'))
      await bot.start()
      return { bot, provider }
    }
    const first = await make()
    const remote = api.trace.setSpanContext(api.context.active(), {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: 1, isRemote: true, traceState: api.createTraceState('vendor=a'),
    })
    first.provider.incoming('registrar', { from: 'u1' })
    await tick()
    api.context.with(remote, () => first.provider.incoming('Ana', { from: 'u1' }))
    await tick()
    await first.bot.stop()
    const parked = env.spans().find((s) => s.name === 'bot.conversation.turn' && s.attributes[TRACE_ATTR.conversationParked] === true && s.attributes[TRACE_ATTR.conversationReason] === 'reply')!

    const second = await make()
    second.provider.incoming('a@b.co', { from: 'u1' })
    await tick()
    const resumed = env.spans().find((s) => s.name === 'bot.conversation.turn' && s.attributes[TRACE_ATTR.conversationReason] === 'dormant')!
    expect(resumed.links).toHaveLength(1)
    const link = resumed.links[0]!
    expect(link.context).toMatchObject({ traceId: parked.spanContext().traceId, spanId: parked.spanContext().spanId, isRemote: true })
    expect(link.context.traceState?.serialize()).toBe('vendor=a')
    expect(link.attributes).toEqual({ [TRACE_ATTR.linkReason]: 'resume' })
    expect(resumed.spanContext().traceId).not.toBe(parked.spanContext().traceId)
    await second.bot.stop()
  })

  it('flow steps become span events of the turn', async () => {
    const { bot, provider, env } = await otelBot()
    bot.use(flow('hola').say('uno').say('dos'))
    provider.incoming('hola', { from: 'u1' })
    await tick()
    const turn = env.byName('bot.conversation.turn')!
    expect(turn.events.filter((e) => e.name === 'flow.step').map((e) => e.attributes?.['bot.flow.step.index'])).toEqual([0, 1])
    await bot.stop()
  })

  it('createOtelTracer with an injected api resolves to a working tracer', async () => {
    env = memoryTracing()
    const tracer = await createOtelTracer({ api, tracerProvider: env.provider, spanMetrics: false })
    const span = tracer.startSpan('x', { kind: 'producer', attributes: { a: 1, b: undefined } })
    span.setStatus({ code: 'ok' }).end()
    const x = env.byName('x')!
    expect(x.kind).toBe(api.SpanKind.PRODUCER)
    expect(x.attributes).toEqual({ a: 1 })
    expect(x.status.code).toBe(api.SpanStatusCode.OK)
  })
})
