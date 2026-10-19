/**
 * Regressions for races and lifecycle edge cases in the core engine: matcher
 * registration during dispatch, stale dormant checkpoints, stop/start cycles of
 * the scheduler, delivery receipts arriving out of order and plugin teardown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import { Dispatcher, type DispatchContext } from '../src/core/Dispatcher.js'
import { HookSystem } from '../src/hooks/HookSystem.js'
import { ConversationRuntime } from '../src/conversations/ConversationRuntime.js'
import { createControls } from '../src/conversations/controls.js'
import { flow } from '../src/flows/FlowBuilder.js'
import { MemoryStore } from '../src/store/MemoryStore.js'
import { Scheduler } from '../src/scheduler/Scheduler.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import type { PluginSpec } from '../src/core/types.js'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
const texts = (provider: MockProvider) => provider.outbox.map((m) => (m.content.kind === 'text' ? m.content.text : ''))

function dctx(body: string): DispatchContext {
  return {
    from: 'u1', sender: 'u1', body, type: 'text', isGroup: false,
    reply: async () => undefined,
    pass() { this._passed = true },
    abort() { this._aborted = true },
  }
}

describe('Dispatcher: matchers registered while a message is being routed', () => {
  it('never runs an already-visited matcher twice', async () => {
    const runtime = new ConversationRuntime()
    const dispatcher = new Dispatcher({ hooks: new HookSystem(), runtime, emit: () => false })
    const calls: string[] = []
    let registered = false
    dispatcher.matcher(() => true, (ctx) => {
      calls.push('A')
      if (!registered) {
        registered = true
        // Higher specificity than A: sorts in front of it.
        dispatcher.matcher(() => true, () => { calls.push('C') }, 50)
      }
      ctx.pass()
    }, 20)
    dispatcher.matcher(() => true, () => { calls.push('B') }, 10)

    await dispatcher.dispatch(dctx('hola'))
    expect(calls).toEqual(['A', 'B'])
    calls.length = 0
    await dispatcher.dispatch(dctx('hola'))
    expect(calls).toEqual(['C'])
  })
})

const persistentFlow = () => flow('registrar').persistent()
  .ask('¿nombre?', 'name')
  .ask('¿email?', 'email')
  .say((_c, c) => `fin ${String(c.state.name)}`)
  .compile()

function msg(body: string) {
  return { from: 'u1', sender: 'u1', body, type: 'text', isGroup: false, reply: vi.fn(async () => {}) }
}

describe('ConversationRuntime: dormant checkpoints', () => {
  it('a conversation entered on a key replaces its dormant checkpoint', async () => {
    const store = new MemoryStore()
    await store.setCheckpoint('u1', { flowId: 'registrar', step: 1, state: { name: 'Ana' }, updatedAt: Date.now() })
    const rt = new ConversationRuntime({ controlsFactory: createControls })
    rt.attachStore(store)
    rt.registerCompiled(persistentFlow())
    await rt.loadDormant()
    expect(rt.hasDormant('u1')).toBe(true)

    await rt.enter(async () => { /* finishes at once */ }, msg('menu'))

    expect(rt.hasDormant('u1')).toBe(false)
    await vi.waitFor(async () => expect(await store.getCheckpoint('u1')).toBeUndefined())
    // The next message no longer wakes the stale flow.
    expect(await rt.resumeDormant(msg('hola'))).toBe(false)
  })

  it('a slow clear of the replaced checkpoint never wipes the checkpoint of the new flow', async () => {
    class SlowClearStore extends MemoryStore {
      override async clearCheckpoint(key: string): Promise<void> {
        await tick(30)
        await super.clearCheckpoint(key)
      }
    }
    const store = new SlowClearStore()
    await store.setCheckpoint('u1', { flowId: 'registrar', step: 1, state: { name: 'Old' }, updatedAt: Date.now() })
    const rt = new ConversationRuntime({ controlsFactory: createControls })
    rt.attachStore(store)
    rt.registerCompiled(persistentFlow())
    await rt.loadDormant()

    void rt.enter('registrar', msg('registrar')).catch(() => {})
    await tick(5)
    rt.deliver(msg('Ana'))
    await tick(80)

    expect(await store.getCheckpoint('u1')).toMatchObject({ flowId: 'registrar', step: 1, state: { name: 'Ana' } })
    rt.abortAll()
  })

  it('loadDormant() mirrors the store: a checkpoint cleared since the last load is gone', async () => {
    const store = new MemoryStore()
    await store.setCheckpoint('u1', { flowId: 'registrar', step: 1, state: {}, updatedAt: Date.now() })
    const rt = new ConversationRuntime({ controlsFactory: createControls })
    rt.attachStore(store)
    rt.registerCompiled(persistentFlow())
    await rt.loadDormant()
    await store.clearCheckpoint('u1')
    await rt.loadDormant()
    expect(rt.hasDormant('u1')).toBe(false)
  })
})

describe('Bot.deleteSubject()', () => {
  it('drops the subject’s in-memory dormant checkpoint, so its flow never resumes', async () => {
    const provider = new MockProvider()
    const store = new MemoryStore()
    const bot = new Bot({ provider, store })
    bot.use(persistentFlow())
    await bot.start()
    provider.incoming('registrar')
    await tick()
    provider.incoming('Ana')
    await tick()
    expect(texts(provider)).toContain('¿email?')
    await bot.stop()          // checkpoint preserved for the restart
    await bot.start()         // …and loaded as dormant

    await bot.deleteSubject('user-1')
    provider.outbox.length = 0
    provider.incoming('hola')
    await tick()
    expect(texts(provider)).not.toContain('¿email?')
    expect(bot.inspectConversation({ from: 'user-1', sender: 'user-1', isGroup: false })).toBeUndefined()
    await bot.stop()
  })

  it('cancels the subject’s live conversation', async () => {
    const { bot, provider } = await createTestBot()
    bot.use(persistentFlow())
    provider.incoming('registrar')
    await tick()
    expect(bot.inspectConversation({ from: 'user-1', sender: 'user-1', isGroup: false })).toBeDefined()
    await bot.deleteSubject('user-1')
    expect(bot.inspectConversation({ from: 'user-1', sender: 'user-1', isGroup: false })).toBeUndefined()
    await bot.stop()
  })
})

describe('Scheduler: stop()/start() while a task is running', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a recurring task keeps a single timer chain', async () => {
    vi.useFakeTimers()
    const s = new Scheduler()
    s.start()
    let release!: () => void
    let runs = 0
    s.every(1000, async () => {
      runs++
      if (runs === 1) await new Promise<void>((resolve) => { release = resolve })
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(1)
    s.stop()
    s.start()
    release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(6)
    s.stop()
  })

  it('a one-shot task never runs twice', async () => {
    vi.useFakeTimers()
    const s = new Scheduler()
    s.start()
    let release!: () => void
    let runs = 0
    s.delay(1000, async () => {
      runs++
      await new Promise<void>((resolve) => { release = resolve })
    })
    await vi.advanceTimersByTimeAsync(1000)
    s.stop()
    s.start()
    await vi.advanceTimersByTimeAsync(10)
    release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(1)
    s.stop()
  })
})

describe('Scheduler: cron expressions', () => {
  afterEach(() => { vi.useRealTimers() })

  it('honours the upper bound of a stepped range', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 5, 0, 0))
    const s = new Scheduler()
    const task = s.cron('0 0 1-5/2 * *', () => {})
    expect(task.nextRun).toEqual(new Date(2026, 1, 1, 0, 0))
  })

  it('accepts 7 as Sunday in the weekday field', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0)) // Thursday
    const s = new Scheduler()
    const task = s.cron('0 9 * * 7', () => {})
    expect(task.nextRun).toEqual(new Date(2026, 0, 4, 9, 0))
  })

  it('rejects a malformed expression with an actionable error', () => {
    const s = new Scheduler()
    expect(() => s.cron('every day', () => {})).toThrow(/5 fields/)
    expect(() => s.cron('0 9 * * mon', () => {})).toThrow(/weekday/)
  })
})

describe('Bot: delivery receipts', () => {
  it('a late "delivered" receipt never regresses a "read" one', async () => {
    const { bot, provider } = await createTestBot()
    const sent = await bot.send('user-1', 'hola')
    const emit = (status: 'read' | 'delivered') => provider['emitEvent']({
      kind: 'status', status: { ref: sent.ref, status, timestamp: Math.floor(Date.now() / 1000) },
    })
    emit('read')
    await tick()
    emit('delivered')
    await tick()
    expect((await bot.getStore().getMessage(sent.ref))?.status).toBe('read')
    await bot.stop()
  })
})

describe('Bot: failed receipts', () => {
  it('a "failed" receipt after "delivered" is recorded with its error', async () => {
    const { bot, provider } = await createTestBot()
    const sent = await bot.send('user-1', 'x')
    const ts = Math.floor(Date.now() / 1000)
    provider['emitEvent']({ kind: 'status', status: { ref: sent.ref, status: 'delivered', timestamp: ts } })
    provider['emitEvent']({ kind: 'status', status: { ref: sent.ref, status: 'failed', timestamp: ts, error: { code: 131047, message: 'expired' } } })
    await vi.waitFor(async () => {
      const row = await bot.getStore().getMessage(sent.ref)
      expect(row?.status).toBe('failed')
      expect(row?.error).toEqual({ code: 131047, message: 'expired' })
    })
    await bot.stop()
  })

  it('a late "failed" receipt never regresses a "read" one, but keeps its error', async () => {
    const { bot, provider } = await createTestBot()
    const sent = await bot.send('user-1', 'x')
    const ts = Math.floor(Date.now() / 1000)
    provider['emitEvent']({ kind: 'status', status: { ref: sent.ref, status: 'read', timestamp: ts } })
    provider['emitEvent']({ kind: 'status', status: { ref: sent.ref, status: 'failed', timestamp: ts, error: { code: 1, message: 'late' } } })
    await vi.waitFor(async () => {
      const row = await bot.getStore().getMessage(sent.ref)
      expect(row?.status).toBe('read')
      expect(row?.error).toEqual({ code: 1, message: 'late' })
    })
    await bot.stop()
  })
})

describe('Bot.plug()', () => {
  it('rolls back what a throwing install() registered', async () => {
    const { bot, provider } = await createTestBot()
    const plugin: PluginSpec = {
      name: 'broken', version: '1.0.0',
      install({ bot: b }) {
        b.command('ping', async (ctx) => { await ctx.reply('pong') })
        throw new Error('bad config')
      },
    }
    expect(() => bot.plug(plugin)).toThrow('bad config')
    provider.incoming('/ping')
    await tick()
    expect(texts(provider)).not.toContain('pong')
    await bot.stop()
  })

  it('routes a rejected async install() to the error event', async () => {
    const { bot } = await createTestBot()
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    bot.plug({ name: 'async', version: '1.0.0', install: async () => { throw new Error('late failure') } })
    await tick()
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toMatch('late failure')
    await bot.stop()
  })

  it('runs uninstall() once and disposes conversations, flows and nested plugins', async () => {
    const { bot, provider } = await createTestBot()
    const uninstall = vi.fn()
    const inner: PluginSpec = { name: 'inner', version: '1.0.0', install({ bot: b }) { b.command('inner', (ctx) => ctx.reply('inner')) } }
    const unplug = bot.plug({
      name: 'outer', version: '1.0.0', uninstall,
      install({ bot: b }) {
        b.conversation('quiz', async (c) => { await c.say('quiz!') })
        b.use(flow('tour').say('tour!'))
        b.use(inner)
      },
    })
    unplug()
    unplug()
    expect(uninstall).toHaveBeenCalledOnce()
    for (const text of ['quiz', 'tour', '/inner']) provider.incoming(text)
    await tick()
    expect(texts(provider)).toEqual([])
    await bot.stop()
  })
})

describe('Bot.broadcast() before start()', () => {
  it('sends nothing and reports every chat as pending', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider })
    const result = await bot.broadcast(['a', 'b'], 'hola')
    expect(provider.outbox).toEqual([])
    expect(result).toMatchObject({ sent: 0, cancelled: true, pending: ['a', 'b'] })
  })
})

describe('c.choose()', () => {
  it('rejects an empty option map with an actionable error', async () => {
    const { bot, provider } = await createTestBot()
    const errors: unknown[] = []
    bot.on('error', ({ error }) => errors.push(error))
    bot.conversation('menu', async (c) => { await c.choose('¿Qué quieres?', {}) })
    provider.incoming('menu')
    await tick()
    expect(String(errors[0])).toMatch(/at least one option/)
    await bot.stop()
  })
})
