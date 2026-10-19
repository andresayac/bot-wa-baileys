import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bot, flow } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'

import { bridgeMetrics, otelMetricsPlugin, otelTracer, registerOtelMetrics } from '../src/index.js'
import { api, memoryMetrics, memoryTracing, tick } from './helpers.js'

let tracingEnv: ReturnType<typeof memoryTracing> | undefined
afterEach(async () => { await tracingEnv?.close(); tracingEnv = undefined })

/** After dispose the callback no longer runs: new traffic does not move the (cumulative) value. */
async function frozen(m: ReturnType<typeof memoryMetrics>, provider: MockProvider, before: unknown) {
  provider.incoming('otra', { from: 'z' })
  await tick()
  expect(value(await m.points('botwa.messages.inbound'))).toBe(before)
}

async function busyBot(config: Record<string, unknown> = {}) {
  const provider = new MockProvider()
  const bot = new Bot({ provider, botId: 'ventas', ...config })
  bot.on('error', () => {})
  await bot.start()
  bot.use(flow('pedido').ask('¿qué?', 'item').say('ok'))
  bot.onMessage(async (ctx) => { await ctx.reply('eco') })
  bot.blacklist.add('spam')
  provider.incoming('pedido', { from: 'a' })
  provider.incoming('hola', { from: 'b' })
  provider.incoming('hola', { from: 'spam' })
  await tick()
  provider.incoming('pan', { from: 'a' })
  await tick()
  return { bot, provider }
}

const value = (points: Array<{ value: unknown; attributes: Record<string, unknown> }>, attrs: Record<string, unknown> = {}) =>
  points.find((p) => Object.entries(attrs).every(([k, v]) => p.attributes[k] === v))?.value

describe('bot.metrics() → OpenTelemetry', () => {
  it('reports the snapshot as counters and gauges with bot.id', async () => {
    const { bot, provider } = await busyBot()
    const m = memoryMetrics()
    const dispose = bridgeMetrics(api, bot, { meterProvider: m.meterProvider, attributes: { env: 'test' } })
    const snap = bot.metrics()
    expect(value(await m.points('botwa.messages.inbound'), { 'bot.id': 'ventas', env: 'test' })).toBe(snap.messages.in)
    expect(value(await m.points('botwa.messages.outbound'), { result: 'ok' })).toBe(snap.messages.out)
    expect(value(await m.points('botwa.dropped'), { reason: 'blocked' })).toBe(1)
    expect(value(await m.points('botwa.conversations.started'))).toBe(1)
    expect(value(await m.points('botwa.conversations.ended'), { outcome: 'completed' })).toBe(1)
    expect(value(await m.points('botwa.flow.conversations.started'), { flow: 'pedido' })).toBe(1)
    expect(value(await m.points('botwa.flow.conversations.ended'), { flow: 'pedido', outcome: 'completed' })).toBe(1)
    expect(value(await m.points('botwa.conversations.active'))).toBe(0)
    expect(typeof value(await m.points('botwa.uptime'))).toBe('number')
    // A counter reset follows bot.resetMetrics().
    bot.resetMetrics()
    expect(value(await m.points('botwa.messages.inbound'))).toBe(0)
    dispose()
    await frozen(m, provider, 0)
    await bot.stop()
  })

  it('records conversation durations from conversation:ended; dispose removes the listener', async () => {
    const m = memoryMetrics()
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    const dispose = await registerOtelMetrics(bot, { api, meterProvider: m.meterProvider, perFlow: false })
    bot.use(flow('hola').say('hola'))
    provider.incoming('hola', { from: 'u1' })
    await tick()
    const points = await m.points('botwa.conversation.duration') as Array<{ value: { count: number }; attributes: Record<string, unknown> }>
    expect(points[0]!.value.count).toBe(1)
    expect(points[0]!.attributes).toMatchObject({ flow: 'hola', outcome: 'completed' })
    expect(await m.points('botwa.flow.conversations.started')).toEqual([])
    dispose()
    expect(bot.listenerCount('conversation:ended')).toBe(0)
    await bot.stop()
  })

  it('otelMetricsPlugin registers on plug and unregisters on unplug', async () => {
    const m = memoryMetrics()
    const { bot, provider } = await busyBot()
    const unplug = bot.plug(otelMetricsPlugin({ api, meterProvider: m.meterProvider }))
    expect(value(await m.points('botwa.messages.inbound'))).toBe(3)
    unplug()
    await frozen(m, provider, 3)
    await bot.stop()
  })

  it('otelMetricsPlugin without an api loads it lazily (install stays synchronous)', async () => {
    const m = memoryMetrics()
    const { bot } = await busyBot()
    bot.plug(otelMetricsPlugin({ meterProvider: m.meterProvider }))
    await vi.waitFor(async () => expect((await m.points('botwa.messages.inbound')).length).toBe(1))
    await bot.stop()
  })
})

describe('span metrics', () => {
  it('derives latency and token histograms from spans, without ids', async () => {
    tracingEnv = memoryTracing()
    const m = memoryMetrics()
    const tracer = otelTracer({ api, tracerProvider: tracingEnv.provider, spanMetrics: { meterProvider: m.meterProvider } })
    const { bot } = await busyBot({ telemetry: { tracer, ids: 'raw' } })
    // A model call span as @bot-wa/ai writes it.
    bot.tracing.trace('chat acme-1', { kind: 'client', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'acme', 'gen_ai.request.model': 'acme-1' } }, (span) => {
      span.setAttributes({ 'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 7 })
    })
    const metrics = await m.collect()
    const names = metrics.map((x) => x.descriptor.name)
    for (const n of ['botwa.inbound.duration', 'botwa.dispatch.duration', 'botwa.queue.wait', 'botwa.send.duration', 'gen_ai.client.operation.duration', 'gen_ai.client.token.usage']) {
      expect(names, n).toContain(n)
    }
    const inbound = metrics.find((x) => x.descriptor.name === 'botwa.inbound.duration')!
    const outcomes = inbound.dataPoints.map((p) => p.attributes['bot.inbound.outcome']).sort()
    expect(outcomes).toEqual(['blocked', 'dispatched'])
    const tokens = metrics.find((x) => x.descriptor.name === 'gen_ai.client.token.usage')!
    expect(tokens.dataPoints.map((p) => [p.attributes['gen_ai.token.type'], (p.value as { sum: number }).sum]).sort())
      .toEqual([['input', 12], ['output', 7]])
    // Ids (chat a/b/spam) never reach a metric attribute.
    for (const metric of metrics) {
      for (const p of metric.dataPoints) {
        for (const [k, v] of Object.entries(p.attributes)) {
          expect(k).not.toMatch(/chat\.id|sender\.id|message\.id/)
          expect(['a', 'b', 'spam']).not.toContain(v)
        }
      }
    }
    await bot.stop()
  })
})
