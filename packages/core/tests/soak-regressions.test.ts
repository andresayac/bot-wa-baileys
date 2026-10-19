/**
 * Regressions for leaks and unbounded growth found by the soak harness
 * (`pnpm bench:soak`, scripts/soak/soak.mjs). Each case is the fast, focused
 * version of what the harness measures over thousands of chats.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import { ConversationRuntime, type RuntimeMessage } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import type { MessageContext } from '../src/index.js'

/** Internals the harness samples (private fields, read for diagnostics only). */
interface Internals {
  runtime: { active: Map<string, unknown>; dormant: Map<string, unknown>; preserveOnAbort: Set<string> }
  dispatcher: { queues: Map<string, unknown> }
  scheduler: { tasks: Map<string, unknown> }
  idle: { watches: Set<{ timers: Map<string, unknown> }> }
  inflightSends: Set<unknown>
  inflightEvents: Set<unknown>
  i18n: { reported: Map<string, string> }
}
const internals = (bot: Bot) => bot as unknown as Internals

const silent = () => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l
}

/** Let queued promise jobs (dispatch pipeline, store writes) run under fake timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => { vi.useRealTimers() })

function makeMsg(from: string): RuntimeMessage {
  return { from, sender: from, body: 'x', type: 'text', isGroup: false, reply: async () => {} } as unknown as RuntimeMessage
}

describe('soak regressions: ConversationRuntime', () => {
  it('abortAll() leaves no shutdown-preserve flags behind for non-persistent conversations', async () => {
    const rt = new ConversationRuntime({ controlsFactory: createControls })
    const ended: Promise<void>[] = []
    for (let i = 0; i < 50; i++) {
      ended.push(rt.enter(async (c) => { await (c as unknown as { ask(t: string): Promise<string> }).ask('?') }, makeMsg(`c${i}`)))
    }
    expect(rt.activeCount()).toBe(50)
    expect(rt.abortAll()).toBe(50)
    await Promise.all(ended)
    expect((rt as unknown as Internals['runtime']).preserveOnAbort.size).toBe(0)
    expect(rt.activeCount()).toBe(0)
  })

  it('a closed runtime starts no conversation (and arms no wait timer) until reopened', async () => {
    vi.useFakeTimers()
    const rt = new ConversationRuntime({ controlsFactory: createControls })
    const started = vi.fn()
    rt.close()
    await rt.enter(async (c) => { started(); await (c as unknown as { ask(t: string): Promise<string> }).ask('?') }, makeMsg('a'))
    expect(started).not.toHaveBeenCalled()
    expect(rt.activeCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    rt.open()
    void rt.enter(async () => { started() }, makeMsg('a'))
    await settle()
    expect(started).toHaveBeenCalledOnce()
  })
})

describe('soak regressions: Bot internal maps after many chats', () => {
  it('after N chats finish their flows, per-chat maps and timers are empty', async () => {
    vi.useFakeTimers()
    const provider = new MockProvider()
    const bot = new Bot({ provider, logger: silent() as never, conversation: { timeout: '1s' } })
    bot.use(flow('registro').ask('¿Nombre?', 'name').say('procesando', { delay: 5 }).say('listo'))
    bot.onIdle('2s', async (ctx: MessageContext) => { await ctx.reply('¿sigues?') })
    await bot.start()
    const N = 200
    for (let i = 0; i < N; i++) provider.incoming('registro', { from: `chat-${i}` })
    await settle()
    for (let i = 0; i < N; i++) if (i % 2 === 0) provider.incoming('Ana', { from: `chat-${i}` }) // the rest time out
    await settle()
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    const s = internals(bot)
    expect(s.runtime.active.size).toBe(0)
    expect(s.dispatcher.queues.size).toBe(0)
    expect(s.scheduler.tasks.size).toBe(0)
    expect([...s.idle.watches].reduce((n, w) => n + w.timers.size, 0)).toBe(0)
    expect(s.inflightSends.size).toBe(0)
    expect(s.inflightEvents.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await bot.stop()
  })
})

describe('soak regressions: bot.stop() under load', () => {
  async function loadedBot() {
    vi.useFakeTimers()
    const provider = new MockProvider({ streaming: 'edit' })
    const bot = new Bot({
      provider,
      logger: silent() as never,
      typing: { enabled: true, minMs: 2_000, maxMs: 3_000 },
      conversation: { timeout: '10m' },
    })
    bot.on('error', () => {})
    bot.use(flow('registro').ask('¿Nombre?', 'name').say('listo'))
    bot.conversation('soporte', async (c) => {
      c.idle('1m', async () => { await c.say('¿sigues?') })
      await c.ask('¿En qué te ayudo?')
    })
    bot.when('soporte', async (ctx) => { void bot.enterConversation('soporte', ctx).catch(() => {}) })
    bot.when('cuento', async (ctx) => {
      async function* gen() { for (;;) { await new Promise((r) => setTimeout(r, 1_000)); yield 'bla ' } }
      await ctx.stream(gen(), { throttleMs: 500 })
    })
    bot.when('lento', async (ctx) => { await ctx.reply('pensando…', { delay: '10m' }) })
    bot.onIdle('5m', async (ctx: MessageContext) => { await ctx.reply('¿sigues?') })
    await bot.start()
    return { bot, provider }
  }

  it('leaves no active timers: waits, c.idle, onIdle, paced replies and streams are all released', async () => {
    const { bot, provider } = await loadedBot()
    provider.incoming('registro', { from: 'a' })
    provider.incoming('soporte', { from: 'b' })
    provider.incoming('cuento', { from: 'c' })
    provider.incoming('lento', { from: 'd' })
    await settle()
    await vi.advanceTimersByTimeAsync(1_500)  // the stream is live (typing interval + preview timer)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await bot.stop()
    await settle()
    // Only the stream SOURCE's own pending sleep (user code, suspended in next()) is left:
    // once it settles the source sees return() and nothing re-arms.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(vi.getTimerCount()).toBe(0)
    expect(internals(bot).runtime.active.size).toBe(0)
    expect(internals(bot).runtime.preserveOnAbort.size).toBe(0)
  })

  it('stop({ drain: true }) clears its drain timeout once the sends settle', async () => {
    vi.useFakeTimers()
    const provider = new MockProvider()
    let release!: () => void
    const original = provider.send.bind(provider)
    provider.send = (chatId, content, options) => new Promise((resolve) => { release = () => resolve(original(chatId, content, options)) })
    const bot = new Bot({ provider, logger: silent() as never })
    await bot.start()
    const sending = bot.sendText('x', 'hola')
    await settle()
    const stopping = bot.stop({ drain: true, timeout: 60_000 })
    await settle()
    release()
    await sending
    await stopping
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a message queued before stop() does not start a conversation after it', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider, logger: silent() as never })
    let gate!: () => void
    const blocked = new Promise<void>((r) => { gate = r })
    bot.when('bloquea', async () => { await blocked })
    bot.use(flow('registro').ask('¿Nombre?', 'name').say('listo'))
    await bot.start()
    provider.incoming('bloquea', { from: 'a' })
    provider.incoming('registro', { from: 'a' })   // queued behind the blocked handler
    await new Promise((r) => setTimeout(r, 5))
    const stopping = bot.stop()
    gate()
    await stopping
    await new Promise((r) => setTimeout(r, 5))
    expect(internals(bot).runtime.active.size).toBe(0)
    expect(provider.outbox.map((m) => (m.content as { text?: string }).text)).not.toContain('¿Nombre?')
  })
})

describe('soak regressions: subject erasure', () => {
  it('deleteSubject() forgets the remembered provider language of the subject', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider, logger: silent() as never, i18n: { defaultLocale: 'en' } })
    const done = new Promise<void>((resolve) => bot.once('message', () => resolve()))
    bot.onMessage(async () => {})
    await bot.start()
    provider.incoming('hola', { from: 'u1', language: 'es' })
    await done
    expect(internals(bot).i18n.reported.has('u1')).toBe(true)
    await bot.deleteSubject('u1')
    expect(internals(bot).i18n.reported.has('u1')).toBe(false)
    await bot.stop()
  })
})

describe('soak regressions: ctx.stream() cancelled by bot.stop()', () => {
  async function streamingBot(provider: MockProvider) {
    const calls: Array<[string, string]> = []
    let stopped = false
    const original = { send: provider.send.bind(provider), edit: provider.editMessage?.bind(provider), stop: provider.stop.bind(provider) }
    provider.send = async (chatId, content, options) => {
      if (stopped) calls.push(['send', (content as { text?: string }).text ?? ''])
      return original.send(chatId, content, options)
    }
    if (original.edit) {
      provider.editMessage = async (ref, content) => {
        if (stopped) calls.push(['edit', (content as { text?: string }).text ?? ''])
        return original.edit!(ref, content)
      }
    }
    provider.stop = async () => { stopped = true; await original.stop() }
    const bot = new Bot({ provider, logger: silent() as never })
    bot.on('error', () => {})
    let result: Promise<{ cancelled: boolean }> | undefined
    bot.when('cuento', async (ctx) => {
      async function* gen() { for (let i = 0; ; i++) { await new Promise((r) => setTimeout(r, 20)); yield `bla${i} ` } }
      result = ctx.stream(gen(), { throttleMs: 30 })
      await result.catch(() => {})
    })
    await bot.start()
    return { bot, calls, result: () => result! }
  }

  for (const streaming of ['edit', 'none'] as const) {
    it(`sends and edits nothing after provider.stop() (streaming: ${streaming})`, async () => {
      const provider = new MockProvider({ streaming })
      const { bot, calls, result } = await streamingBot(provider)
      provider.incoming('cuento', { from: 'a' })
      await new Promise((r) => setTimeout(r, 150))
      await bot.stop()
      const r = await result()
      await new Promise((r) => setTimeout(r, 60))
      expect(r.cancelled).toBe(true)
      expect(calls).toEqual([])
    })
  }
})
