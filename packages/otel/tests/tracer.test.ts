import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bot, flow, TRACE_ATTR } from '@bot-wa/core'
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
    // Same trace for the whole message.
    expect(new Set(env.spans().map((s) => s.spanContext().traceId)).size).toBe(1)
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
