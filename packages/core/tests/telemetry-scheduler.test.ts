/**
 * Scheduled task runs as root `bot.task` spans (plain and durable tasks), with task and
 * leadership attributes; sends made by a task nest under its span.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import type { BotConfig } from '../src/core/types.js'
import { MemoryCoordinationHub, MemoryCoordinator } from '../src/coordination/MemoryCoordinator.js'
import { MemoryLeaseProvider } from '../src/coordination/lease.js'
import { TRACE_ATTR } from '../src/telemetry/attributes.js'
import { MemoryScheduleStore } from '../src/scheduler/ScheduleStore.js'
import { MockProvider } from '../src/testing/MockProvider.js'
import { createRecordingTracer, type RecordingTracer } from '../src/testing/recordingTracer.js'

function silent(): BotConfig['logger'] {
  const noop = () => {}
  const l = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => l, level: 'silent' }
  return l as unknown as BotConfig['logger']
}

const bots: Bot[] = []
afterEach(async () => {
  for (const b of bots.splice(0)) await b.stop().catch(() => {})
  vi.useRealTimers()
})

function tracedBot(config: Omit<BotConfig, 'provider' | 'telemetry'> = {}, rec: RecordingTracer = createRecordingTracer(), ids: 'raw' | 'hash' = 'raw') {
  const provider = new MockProvider()
  const bot = new Bot({ logger: silent(), ...config, provider, telemetry: { tracer: rec.tracer, ids, idKey: 'k' } })
  bot.on('error', () => {})
  bots.push(bot)
  return { bot, provider, rec }
}

describe('telemetry: scheduled task spans', () => {
  it('an in-memory interval task run is a root bot.task span; its sends nest under it', async () => {
    vi.useFakeTimers()
    const { bot, rec } = tracedBot()
    const task = bot.every('1m', async () => { await bot.sendText('c1', 'reporte') })
    await bot.start()
    await vi.advanceTimersByTimeAsync(60_000)
    const span = rec.find('bot.task')!
    expect(span).toBeDefined()
    expect(span.parentId).toBeUndefined()
    expect(span.ended).toBe(true)
    expect(span.attributes).toEqual({
      [TRACE_ATTR.taskId]: task.id,
      [TRACE_ATTR.taskKind]: 'interval',
      [TRACE_ATTR.taskDurable]: false,
      [TRACE_ATTR.taskIntervalMs]: 60_000,
    })
    const send = rec.find('bot.send')!
    let root = send
    while (rec.parentOf(root)) root = rec.parentOf(root)!
    expect(root).toBe(span)
  })

  it('cron and one-shot tasks carry their spec; a failing run is recorded as an error', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-05T08:59:00Z'))
    const { bot, rec } = tracedBot()
    bot.schedule('0 9 * * *', { timeZone: 'UTC' }, () => {})
    bot.delay('30s', () => { throw new TypeError('secreto') })
    await bot.start()
    await vi.advanceTimersByTimeAsync(61_000)
    const cron = rec.find('bot.task', (s) => s.attributes[TRACE_ATTR.taskKind] === 'cron')!
    expect(cron.attributes).toMatchObject({ [TRACE_ATTR.taskCron]: '0 9 * * *', [TRACE_ATTR.taskTimeZone]: 'UTC', [TRACE_ATTR.taskDurable]: false })
    const once = rec.find('bot.task', (s) => s.attributes[TRACE_ATTR.taskKind] === 'once')!
    expect(once.status.code).toBe('error')
    expect(once.attributes[TRACE_ATTR.errorType]).toBe('TypeError')
    expect(rec.allValues().some((v) => v.includes('secreto'))).toBe(false)
  })

  it('a task registered inside a handler still runs in a ROOT span (no stale parent)', async () => {
    const { bot, provider, rec } = tracedBot()
    bot.when('later', () => { bot.delay(10, () => {}) })
    await bot.start()
    provider.incoming('later', { from: 'u1' })
    await vi.waitFor(() => expect(rec.find('bot.task')?.ended).toBe(true))
    expect(rec.find('bot.task')!.parentId).toBeUndefined()
  })

  it('a durable occurrence records its slot, fencing token, missed flag, role and owner', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-05T09:00:00Z'))
    const { bot, rec } = tracedBot({ scheduler: { owner: 'replica-1', lease: new MemoryLeaseProvider() } })
    bot.every('10s', { id: 'reporte:u1' }, async () => {})
    await bot.start()
    await vi.advanceTimersByTimeAsync(10_000)
    const span = rec.find('bot.task')!
    expect(span.parentId).toBeUndefined()
    expect(span.attributes).toMatchObject({
      [TRACE_ATTR.taskId]: 'reporte:u1',
      [TRACE_ATTR.taskKind]: 'interval',
      [TRACE_ATTR.taskDurable]: true,
      [TRACE_ATTR.taskIntervalMs]: 10_000,
      [TRACE_ATTR.taskScheduledAt]: '2026-01-05T09:00:10.000Z',
      [TRACE_ATTR.taskMissed]: false,
      [TRACE_ATTR.schedulerRole]: 'leader',
      [TRACE_ATTR.schedulerOwner]: 'replica-1',
    })
    expect(typeof span.attributes[TRACE_ATTR.taskFencingToken]).toBe('number')
  })

  it("without a leader lease the role is 'single'; task ids follow the ids policy (hashed by default)", async () => {
    vi.useFakeTimers()
    const { bot, rec } = tracedBot({ scheduler: {} }, createRecordingTracer(), 'hash')
    bot.every('10s', { id: 'reporte:573001112233' }, async () => {})
    await bot.start()
    await vi.advanceTimersByTimeAsync(10_000)
    const span = rec.find('bot.task')!
    expect(span.attributes[TRACE_ATTR.schedulerRole]).toBe('single')
    expect(span.attributes[TRACE_ATTR.taskId]).toEqual(expect.any(String))
    expect(rec.allValues().some((v) => v.includes('573001112233'))).toBe(false)
  })

  it("a follower stepping in for an overdue occurrence is recorded with role 'follower'", async () => {
    vi.useFakeTimers()
    const hub = new MemoryCoordinationHub()
    const ca = new MemoryCoordinator({ hub, replicaId: 'a' })
    const cb = new MemoryCoordinator({ hub, replicaId: 'b' })
    await ca.start(); await cb.start()
    const rec = createRecordingTracer()
    // The leader (a) runs its own task, so it campaigns and leads; it does not have 'solo-b':
    // b runs that one once it is overdue for leaderTtlMs.
    const shared = new MemoryScheduleStore()
    const a = tracedBot({ scheduler: { store: shared, owner: 'a', leaderTtlMs: 1000 }, coordination: { coordinator: ca } })
    a.bot.every('1s', { id: 'other' }, () => {})
    await a.bot.start()
    await vi.advanceTimersByTimeAsync(1_100)
    const b = tracedBot({ scheduler: { store: shared, owner: 'b', leaderTtlMs: 1000 }, coordination: { coordinator: cb } }, rec)
    b.bot.every('10s', { id: 'solo-b' }, () => {})
    await b.bot.start()
    await vi.advanceTimersByTimeAsync(15_000)
    const span = rec.find('bot.task')!
    expect(span.attributes).toMatchObject({ [TRACE_ATTR.taskId]: 'solo-b', [TRACE_ATTR.schedulerRole]: 'follower', [TRACE_ATTR.schedulerOwner]: 'b' })
    await a.bot.stop(); await b.bot.stop()
    await ca.stop(); await cb.stop()
  })

  it('per-chat idle watchers (onIdle) are internal timers, not task spans', async () => {
    const { bot, provider, rec } = tracedBot()
    const fired = vi.fn()
    bot.onIdle(30, fired)
    await bot.start()
    provider.incoming('hola', { from: 'u1' })
    await vi.waitFor(() => expect(fired).toHaveBeenCalled())
    expect(rec.findAll('bot.task')).toEqual([])
  })

  it('without telemetry no hook is installed (Scheduler.trace is never set)', async () => {
    const provider = new MockProvider()
    const bot = new Bot({ provider, logger: silent() })
    bots.push(bot)
    const scheduler = (bot as unknown as { scheduler: { tracing?: unknown } }).scheduler
    expect(scheduler.tracing).toBeUndefined()
  })
})
