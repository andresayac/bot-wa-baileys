import { afterEach, describe, expect, it } from 'vitest'
import { Bot } from '@bot-wa/core'
import { MockProvider } from '@bot-wa/core/testing'

import { lazyOtelTracer, loadOtelApi } from '../src/index.js'
import { api, memoryTracing, tick } from './helpers.js'

let env: ReturnType<typeof memoryTracing> | undefined
afterEach(async () => { await env?.close(); env = undefined })

const missing = () => Promise.reject(Object.assign(new Error("Cannot find package '@opentelemetry/api'"), { code: 'ERR_MODULE_NOT_FOUND' }))

describe('lazy loading of @opentelemetry/api', () => {
  it('loadOtelApi loads the real module, and rejects with an install hint when it is missing', async () => {
    const loaded = await loadOtelApi()
    expect(typeof loaded.trace.getTracer).toBe('function')
    await expect(loadOtelApi(missing)).rejects.toThrow(/pnpm add @opentelemetry\/api/)
    await expect(loadOtelApi(async () => ({ nothing: true }))).rejects.toThrow(/@opentelemetry\/api/)
    // A CommonJS-style default export is accepted too.
    expect((await loadOtelApi(async () => ({ default: api }))).trace).toBe(api.trace)
  })

  it('lazyOtelTracer is a no-op until loaded, and a load failure never breaks the bot', async () => {
    const tracer = lazyOtelTracer({}, missing)
    await expect(tracer.ready).rejects.toThrow(/install|pnpm add/)
    expect(tracer.startSpan('x').isRecording()).toBe(false)
    const provider = new MockProvider()
    const bot = new Bot({ provider, telemetry: { tracer } })
    bot.when('hola', async (ctx) => { await ctx.reply('👋') })
    await bot.start()
    provider.incoming('hola', { from: 'u1' })
    await tick()
    expect(provider.outbox).toHaveLength(1)
    await bot.stop()
  })

  it('lazyOtelTracer delegates to OpenTelemetry once ready', async () => {
    env = memoryTracing()
    const tracer = lazyOtelTracer({ tracerProvider: env.provider, spanMetrics: false }, async () => api)
    await tracer.ready
    tracer.startSpan('after').end()
    expect(env.byName('after')).toBeDefined()
  })
})
