import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConversationRuntime, type RuntimeConfig, type RuntimeMessage } from '../src/conversations/ConversationRuntime.js'
import { createControls, type ConversationControls } from '../src/conversations/controls.js'
import { ConversationCancelled } from '../src/conversations/errors.js'
import { Bot } from '../src/core/Bot.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { flow } from '../src/flows/FlowBuilder.js'
import type { IdleEvent, MessageContext } from '../src/index.js'

function makeMsg(body: string, type = 'text') {
  return { from: 'a@s.whatsapp.net', sender: 'a@s.whatsapp.net', body, type, isGroup: false, reply: vi.fn(async (_t: string) => {}) }
}
function makeRt(cfg: RuntimeConfig = {}) {
  return new ConversationRuntime({ ...cfg, controlsFactory: (rt, handle, ctx) => createControls(rt, handle, ctx) })
}
type Conv = (c: ConversationControls, ctx: RuntimeMessage) => Promise<void>
const enter = (rt: ConversationRuntime, fn: Conv, start: RuntimeMessage) => rt.enter(fn as never, start)

/** Let queued promise jobs (dispatch pipeline, store writes) run under fake timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
}

let rejections: unknown[] = []
const onRejection = (e: unknown) => { rejections.push(e) }

beforeEach(() => {
  vi.useFakeTimers()
  rejections = []
  process.on('unhandledRejection', onRejection)
})
afterEach(() => {
  process.off('unhandledRejection', onRejection)
  vi.useRealTimers()
})

describe('c.idle() / c.idleClear() — conversation inactivity', () => {
  it('fires the callback after the idle period; the conversation keeps waiting', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let answer = ''
    const entry = enter(rt, async (c, ctx) => {
      c.idle('2m', async () => { await ctx.reply('¿Sigues ahí?') })
      answer = await c.ask('¿Nombre?', { timeout: '10m' })
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(start.reply).not.toHaveBeenCalledWith('¿Sigues ahí?')
    await vi.advanceTimersByTimeAsync(1)
    expect(start.reply).toHaveBeenCalledWith('¿Sigues ahí?')
    expect(rt.hasActive(rt.keyFor(start))).toBe(true)
    rt.deliver(makeMsg('Ana'))
    await entry
    expect(answer).toBe('Ana')
    expect(vi.getTimerCount()).toBe(0)                       // idle disarmed when the conversation ended
  })

  it('every inbound message reschedules it; it fires once per idle period', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const fired = vi.fn()
    const entry = enter(rt, async (c) => {
      c.idle(1000, fired)
      for (;;) if ((await c.waitText({ timeout: 0 })) === 'fin') return
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(900)
    rt.deliver(makeMsg('hola'))                               // activity at t=900 → idle due at 1900
    await vi.advanceTimersByTimeAsync(900)
    expect(fired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(fired).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)                 // still idle: no repeat
    expect(fired).toHaveBeenCalledTimes(1)
    rt.deliver(makeMsg('volví'))                              // new activity re-arms it
    await vi.advanceTimersByTimeAsync(1000)
    expect(fired).toHaveBeenCalledTimes(2)
    rt.deliver(makeMsg('fin'))
    await entry
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a message the pending wait filters out still counts as activity', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const fired = vi.fn()
    const entry = enter(rt, async (c) => {
      c.idle(1000, fired)
      await c.waitAny({ filter: (m) => m.type === 'image', timeoutMs: 0 })
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(800)
    expect(rt.deliver(makeMsg('texto'))).toBe(false)          // not consumed by the conversation…
    await vi.advanceTimersByTimeAsync(800)
    expect(fired).not.toHaveBeenCalled()                      // …but the user is not idle
    await vi.advanceTimersByTimeAsync(200)
    expect(fired).toHaveBeenCalledTimes(1)
    rt.abort(rt.keyFor(start))
    await entry
  })

  it('callback c.end(farewell) ends the conversation and sends the farewell', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const after = vi.fn()
    const entry = enter(rt, async (c, ctx) => {
      c.idle('30s', async () => {
        await ctx.reply('⏰ Te desconecté por inactividad')
        c.end('👋 Hasta luego')
      })
      await c.ask('Escribe una letra', { timeout: '5m' })
      after()
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    await entry
    expect(start.reply.mock.calls.map((x) => x[0])).toEqual(['Escribe una letra', '⏰ Te desconecté por inactividad', '👋 Hasta luego'])
    expect(after).not.toHaveBeenCalled()
    expect(rt.hasActive(rt.keyFor(start))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)                       // wait timeout + idle timer both cleared
    expect(rejections).toHaveLength(0)
  })

  it('callback c.end() while the conversation is busy ends it at its next wait', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    let release!: () => void
    const busy = new Promise<void>((r) => { release = r })
    const after = vi.fn()
    const entry = enter(rt, async (c) => {
      c.idle(1000, () => c.end('fin por inactividad'))
      await busy                                             // processing — no wait pending
      await c.waitText()
      after()
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(rt.hasActive(rt.keyFor(start))).toBe(true)
    release()
    await entry
    expect(after).not.toHaveBeenCalled()
    expect(start.reply).toHaveBeenCalledWith('fin por inactividad')
  })

  it('callback c.goto(name) moves the conversation to another one', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    rt.register('menu', async (c) => { await c.say('📋 Menú principal') })
    const entry = enter(rt, async (c) => {
      c.idle(500, () => c.goto('menu'))
      await c.waitText({ timeout: 0 })
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(500)
    await entry
    expect(start.reply).toHaveBeenCalledWith('📋 Menú principal')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('callback c.retry() re-prompts the pending wait and counts against its budget', async () => {
    const rt = makeRt({ retriesMessage: 'agotado' })
    const start = makeMsg('start')
    let answer = ''
    const entry = enter(rt, async (c) => {
      c.idle(1000, () => c.retry('¿Sigues ahí? Elige 1 o 2'))
      answer = await c.choose('Elige:', { a: 'A', b: 'B' }, { timeout: 0, retries: 3 })
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(start.reply).toHaveBeenLastCalledWith('¿Sigues ahí? Elige 1 o 2\n\n1) A\n2) B')
    rt.deliver(makeMsg('2'))                                  // the ORIGINAL wait receives the answer
    await entry
    expect(answer).toBe('b')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('idle re-prompts exhaust the retries budget → retriesMessage', async () => {
    const rt = makeRt({ retriesMessage: 'agotado' })
    const start = makeMsg('start')
    const entry = enter(rt, async (c) => {
      c.idle(1000, () => c.retry())
      await c.ask('¿Nombre?', { timeout: 0, retries: 2 })
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(1000)                   // attempt 1: re-prompt
    rt.deliver(makeMsg('tecleando…'))
    await vi.advanceTimersByTimeAsync(0)
    await entry                                              // 'tecleando…' is a valid answer → ends normally
    expect(start.reply.mock.calls.map((x) => x[0])).toEqual(['¿Nombre?', '¿Nombre?'])

    const start2 = makeMsg('start')
    const entry2 = enter(rt, async (c) => {
      c.idle(1000, () => c.retry())
      await c.ask('¿Nombre?', { timeout: 0, retries: 2 })
    }, start2)
    await settle()
    await vi.advanceTimersByTimeAsync(1000)                   // attempt 1
    rt.deliver(makeMsg('x', 'image'))                         // invalid (not text) → attempt 2 → exceeded
    await entry2
    expect(start2.reply).toHaveBeenLastCalledWith('agotado')
  })

  it('c.idleClear() disarms it; c.idle() again replaces the previous one', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const first = vi.fn()
    const second = vi.fn()
    const entry = enter(rt, async (c) => {
      c.idle(1000, first)
      c.idle(5000, second)                                   // replaces `first`
      await c.waitText({ timeout: 0 })
      c.idleClear()
      await c.waitText({ timeout: 0 })
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(4000)
    rt.deliver(makeMsg('uno'))
    await settle()
    expect(vi.getTimerCount()).toBe(0)                       // cleared: nothing armed while waiting again
    await vi.advanceTimersByTimeAsync(60_000)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    rt.deliver(makeMsg('dos'))
    await entry
  })

  it('abort (/reset) and abortAll (bot.stop) disarm it — no leaked timers', async () => {
    const rt = makeRt()
    const a = makeMsg('start')
    const fired = vi.fn()
    const entry = enter(rt, async (c) => { c.idle(1000, fired); await c.waitText({ timeout: 0 }) }, a)
    await settle()
    rt.abort(rt.keyFor(a))
    await entry
    expect(vi.getTimerCount()).toBe(0)

    const b = makeMsg('start')
    const entry2 = enter(rt, async (c) => { c.idle(1000, fired); await c.waitText({ timeout: 0 }) }, b)
    await settle()
    expect(rt.abortAll()).toBe(1)
    await entry2
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).not.toHaveBeenCalled()
  })

  it('callback errors go to onError; the conversation stays alive; no unhandled rejections', async () => {
    const onError = vi.fn()
    const rt = makeRt({ onError })
    const start = makeMsg('start')
    let answer = ''
    const entry = enter(rt, async (c) => {
      c.idle(1000, async () => { throw new Error('idle boom') })
      answer = await c.waitText({ timeout: 0 })
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onError).toHaveBeenCalledOnce()
    expect((onError.mock.calls[0][0] as Error).message).toBe('idle boom')
    expect(rt.hasActive(rt.keyFor(start))).toBe(true)
    rt.deliver(makeMsg('sigo'))
    await entry
    expect(answer).toBe('sigo')
    expect(rejections).toHaveLength(0)
  })

  it('a callback still running when the conversation ends unwinds silently', async () => {
    const onError = vi.fn()
    const rt = makeRt({ onError })
    const start = makeMsg('start')
    let release!: () => void
    const slow = new Promise<void>((r) => { release = r })
    let caught: unknown
    const entry = enter(rt, async (c) => {
      c.idle(1000, async () => {
        await slow
        try { await c.say('tarde') } catch (e) { caught = e; throw e }
      })
      await c.waitText({ timeout: 0 })
    }, start)
    await settle()
    await vi.advanceTimersByTimeAsync(1000)                   // callback starts and parks on `slow`
    rt.deliver(makeMsg('respuesta'))
    await entry                                              // conversation finished meanwhile
    release()
    await settle()
    expect(caught).toBeInstanceOf(ConversationCancelled)
    expect(start.reply).not.toHaveBeenCalledWith('tarde')
    expect(onError).not.toHaveBeenCalled()
    expect(rejections).toHaveLength(0)
  })

  it('rejects invalid durations', async () => {
    const rt = makeRt()
    const start = makeMsg('start')
    const errors: unknown[] = []
    await enter(rt, async (c) => {
      for (const d of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'pronto']) {
        try { c.idle(d, () => {}) } catch (e) { errors.push(e) }
      }
    }, start)
    expect(errors).toHaveLength(5)
    expect(errors[0]).toBeInstanceOf(RangeError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('works from flow .do() steps and survives step boundaries', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    bot.use(flow('encuesta')
      .do(async (ctx, c) => { c.idle('1m', () => c.end('⏰ Encuesta cerrada por inactividad')) })
      .ask('¿Edad?', 'edad', { timeout: '1h' })
      .ask('¿Ciudad?', 'ciudad', { timeout: '1h' })
      .say('gracias'))
    provider.incoming('encuesta')
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    provider.incoming('30')                                   // activity → rescheduled
    await settle()
    await vi.advanceTimersByTimeAsync(59_000)
    const texts = () => provider.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : ''))
    expect(texts()).toEqual(['¿Edad?', '¿Ciudad?'])
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(texts()).toEqual(['¿Edad?', '¿Ciudad?', '⏰ Encuesta cerrada por inactividad'])
    await bot.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('callback errors inside a Bot reach the bot "error" event with the conversation ctx', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const errors: Array<{ error: unknown; ctx?: MessageContext }> = []
    bot.on('error', (e) => errors.push(e))
    await bot.start()
    bot.conversation('juego', async (c) => {
      c.idle(1000, () => { throw new Error('idle falló') })
      await c.waitText({ timeout: 0 })
    })
    provider.incoming('juego')
    await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(errors).toHaveLength(1)
    expect((errors[0].error as Error).message).toBe('idle falló')
    expect(errors[0].ctx?.body).toBe('juego')
    await bot.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(rejections).toHaveLength(0)
  })
})

describe('bot.onIdle() — per-chat inactivity', () => {
  async function startBot() {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    await bot.start()
    return { bot, provider }
  }
  const sent = (provider: MockProvider, chatId: string) =>
    provider.outbox.filter((m) => m.chatId === chatId).map((m) => (m.content.kind === 'text' ? m.content.text : ''))

  it('fires once per chat after the idle period, with the last ctx and an IdleEvent', async () => {
    const { bot, provider } = await startBot()
    const events: IdleEvent[] = []
    bot.onIdle('10m', async (ctx, event) => {
      events.push(event)
      await ctx.reply('¿Sigues ahí?')
    })
    const t0 = Date.now()
    provider.incoming('hola', { from: 'chat-a' })
    await settle()
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    expect(sent(provider, 'chat-a')).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(sent(provider, 'chat-a')).toEqual(['¿Sigues ahí?'])
    expect(events).toEqual([{ chatId: 'chat-a', idleMs: 600_000, lastActivityAt: expect.any(Number) }])
    expect(events[0].lastActivityAt).toBeGreaterThanOrEqual(t0)
    await vi.advanceTimersByTimeAsync(60 * 60_000)            // still idle: not repeated
    expect(sent(provider, 'chat-a')).toEqual(['¿Sigues ahí?'])
    expect(vi.getTimerCount()).toBe(0)
    await bot.stop()
  })

  it('is rescheduled by every inbound message and re-armed after it fired', async () => {
    const { bot, provider } = await startBot()
    const fired = vi.fn()
    bot.onIdle(1000, fired)
    provider.incoming('1', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(700)
    provider.incoming('2', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(700)
    expect(fired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(fired).toHaveBeenCalledTimes(1)
    expect((fired.mock.calls[0][0] as MessageContext).body).toBe('2')
    provider.incoming('3', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fired).toHaveBeenCalledTimes(2)
    await bot.stop()
  })

  it('tracks chats independently and counts messages consumed by conversations', async () => {
    const { bot, provider } = await startBot()
    const fired: string[] = []
    bot.onIdle(1000, (_ctx, e) => { fired.push(e.chatId) })
    bot.conversation('charla', async (c) => { await c.waitText({ timeout: 0 }); await c.waitText({ timeout: 0 }) })
    provider.incoming('charla', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(500)
    provider.incoming('hola', { from: 'chat-b' }); await settle()
    provider.incoming('respuesta', { from: 'chat-a' }); await settle()   // delivered to the conversation
    await vi.advanceTimersByTimeAsync(999)
    expect(fired).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fired.sort()).toEqual(['chat-a', 'chat-b'])
    await bot.stop()
  })

  it('bot.stop() cancels pending idle timers; nothing fires after a restart', async () => {
    const { bot, provider } = await startBot()
    const fired = vi.fn()
    bot.onIdle(1000, fired)
    provider.incoming('hola', { from: 'chat-a' }); await settle()
    await bot.stop()
    expect(vi.getTimerCount()).toBe(0)
    await bot.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).not.toHaveBeenCalled()
    provider.incoming('otra vez', { from: 'chat-a' }); await settle()   // still registered after restart
    await vi.advanceTimersByTimeAsync(1000)
    expect(fired).toHaveBeenCalledTimes(1)
    await bot.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clearIdle(chatId) / clearIdle() cancel pending timers until the next inbound', async () => {
    const { bot, provider } = await startBot()
    const fired: string[] = []
    bot.onIdle(1000, (_ctx, e) => { fired.push(e.chatId) })
    bot.onIdle(2000, (_ctx, e) => { fired.push(`${e.chatId}@2s`) })
    provider.incoming('x', { from: 'chat-a' }); await settle()
    provider.incoming('y', { from: 'chat-b' }); await settle()
    bot.clearIdle('chat-a')
    await vi.advanceTimersByTimeAsync(2000)
    expect(fired.sort()).toEqual(['chat-b', 'chat-b@2s'])
    provider.incoming('z', { from: 'chat-a' }); await settle()
    provider.incoming('w', { from: 'chat-b' }); await settle()
    bot.clearIdle()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).toHaveLength(2)
    await bot.stop()
  })

  it('a "handoff" event for a chat cancels its pending idle timers', async () => {
    const { bot, provider } = await startBot()
    const fired = vi.fn()
    bot.onIdle(1000, fired)
    provider.incoming('humano', { from: 'chat-a' }); await settle()
    bot.emit('handoff', { chatId: 'chat-a', reason: 'agent' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).not.toHaveBeenCalled()
    await bot.stop()
  })

  it('messages dropped by a before("message") hook do not re-arm it', async () => {
    const { bot, provider } = await startBot()
    const fired = vi.fn()
    bot.before('message', async (ctx: { body: string; abort(): void }, next) => {
      if (ctx.body === 'spam') return ctx.abort()
      await next()
    })
    bot.onIdle(1000, fired)
    provider.incoming('spam', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).not.toHaveBeenCalled()
    await bot.stop()
  })

  it('routes handler errors (sync and async) to the bot "error" event, never unhandled', async () => {
    const { bot, provider } = await startBot()
    const errors: Array<{ error: unknown; ctx?: MessageContext }> = []
    bot.on('error', (e) => errors.push(e))
    bot.onIdle(1000, () => { throw new Error('sync boom') })
    bot.onIdle(1000, async () => { throw new Error('async boom') })
    provider.incoming('hola', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(errors.map((e) => (e.error as Error).message).sort()).toEqual(['async boom', 'sync boom'])
    expect(errors.every((e) => e.ctx?.from === 'chat-a')).toBe(true)
    expect(rejections).toHaveLength(0)
    await bot.stop()
  })

  it('the returned unsubscribe stops watching and clears its timers', async () => {
    const { bot, provider } = await startBot()
    const fired = vi.fn()
    const off = bot.onIdle(1000, fired)
    provider.incoming('hola', { from: 'chat-a' }); await settle()
    off()
    expect(vi.getTimerCount()).toBe(0)
    provider.incoming('otra', { from: 'chat-a' }); await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fired).not.toHaveBeenCalled()
    await bot.stop()
  })

  it('rejects invalid durations', async () => {
    const { bot } = await startBot()
    expect(() => bot.onIdle(0, () => {})).toThrow(RangeError)
    expect(() => bot.onIdle(-1, () => {})).toThrow(RangeError)
    expect(() => bot.onIdle(Number.POSITIVE_INFINITY, () => {})).toThrow(RangeError)
    expect(() => bot.onIdle('nunca', () => {})).toThrow()
    await bot.stop()
  })
})
