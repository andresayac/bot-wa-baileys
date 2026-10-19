/**
 * Scheduler + time zones: plain and durable cron tasks read in an IANA zone, across DST
 * transitions (fake timers; every instant is absolute, so the host zone does not matter).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Bot } from '../src/core/Bot.js'
import type { ScheduledRun } from '../src/core/types.js'
import { cronNextRun } from '../src/scheduler/cron.js'
import { MemoryScheduleStore } from '../src/scheduler/ScheduleStore.js'
import { Scheduler } from '../src/scheduler/Scheduler.js'
import { MockProvider } from '../src/testing/MockProvider.js'

const NY = 'America/New_York'
const MIN = 60_000
const at = (iso: string) => Date.parse(iso)

function useClock(iso: string) {
  vi.useFakeTimers()
  vi.setSystemTime(at(iso))
}

/** Advance the fake clock to `iso`. */
const advanceTo = (iso: string) => vi.advanceTimersByTimeAsync(at(iso) - Date.now())

afterEach(() => {
  vi.useRealTimers()
})

describe('Scheduler: plain cron tasks with a time zone', () => {
  it('fires a fixed-hour task once across the NY fall-back overlap', async () => {
    useClock('2026-10-31T12:00:00Z')
    const s = new Scheduler()
    const fired: string[] = []
    const task = s.cron('30 1 * * *', { timeZone: NY }, () => { fired.push(new Date().toISOString()) })
    expect(task.timeZone).toBe(NY)
    expect(task.durable).toBeUndefined()
    s.start()
    expect(task.nextRun?.toISOString()).toBe('2026-11-01T05:30:00.000Z')
    await advanceTo('2026-11-01T08:00:00Z')
    expect(fired).toEqual(['2026-11-01T05:30:00.000Z'])
    expect(task.nextRun?.toISOString()).toBe('2026-11-02T06:30:00.000Z')
    s.stop()
  })

  it('shifts a fixed-hour task out of the NY spring-forward gap', async () => {
    useClock('2026-03-07T12:00:00Z')
    const s = new Scheduler()
    const fired: string[] = []
    s.cron('30 2 * * *', { timeZone: NY }, () => { fired.push(new Date().toISOString()) })
    s.start()
    await advanceTo('2026-03-09T12:00:00Z')
    expect(fired).toEqual(['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z'])
    s.stop()
  })

  it('uses SchedulerOptions.timeZone as the default, and a task can override it', () => {
    useClock('2026-01-01T00:00:00Z')
    const s = new Scheduler({ timeZone: 'Asia/Kolkata' })
    const def = s.cron('0 9 * * *', () => {})
    expect(def.timeZone).toBe('Asia/Kolkata')
    expect(def.nextRun?.toISOString()).toBe('2026-01-01T03:30:00.000Z')
    const local = s.cron('0 9 * * *', { timeZone: 'local' }, () => {})
    expect(local.timeZone).toBeUndefined()
    expect(local.nextRun?.getTime()).toBe(cronNextRun('0 9 * * *', new Date())?.getTime())
    const utc = s.cron('0 9 * * *', { timeZone: 'UTC' }, () => {})
    expect(utc.nextRun?.toISOString()).toBe('2026-01-01T09:00:00.000Z')
  })

  it('keeps plain tasks without a zone exactly as before', () => {
    useClock('2026-01-01T00:00:00Z')
    const t = new Scheduler().cron('0 9 * * *', () => {})
    expect(t.timeZone).toBeUndefined()
    expect('timeZone' in t).toBe(false)
    expect(t.nextRun?.getTime()).toBe(cronNextRun('0 9 * * *', new Date())?.getTime())
  })

  it('rejects a zone on every/delay (plain and durable)', () => {
    const s = new Scheduler()
    const fn = () => {}
    expect(() => s.every(1000, { timeZone: 'UTC' } as never, fn)).toThrow(new TypeError('timeZone only applies to cron tasks'))
    expect(() => s.delay(1000, { timeZone: 'UTC' } as never, fn)).toThrow(TypeError)
    expect(() => s.every(1000, { id: 'x', timeZone: 'UTC' }, fn)).toThrow('timeZone only applies to cron tasks')
    expect(() => s.delay('1m', { id: 'y', timeZone: 'UTC' }, fn)).toThrow('timeZone only applies to cron tasks')
  })

  it('validates zones when the task or the scheduler is created', () => {
    expect(() => new Scheduler({ timeZone: 'Nope/Nowhere' })).toThrow(RangeError)
    expect(() => new Scheduler({ timeZone: 'America/New York' })).toThrow(RangeError)
    expect(() => new Scheduler({ timeZone: 5 as never })).toThrow(TypeError)
    const s = new Scheduler()
    expect(() => s.cron('0 9 * * *', { timeZone: 'Nope/Nowhere' }, () => {})).toThrow(/unknown timeZone "Nope\/Nowhere"/)
    expect(() => s.cron('0 9 * * *', { id: 'd', timeZone: 'Nope/Nowhere' }, () => {})).toThrow(RangeError)
    expect(() => new Bot({ provider: new MockProvider(), scheduler: { timeZone: 'Nope/Nowhere' } })).toThrow(RangeError)
  })

  it('still routes options without a zone to the durable path (same TypeError as before)', () => {
    const s = new Scheduler()
    expect(() => s.cron('0 9 * * *', {} as never, () => {})).toThrow(/durable task id/)
  })
})

describe('Scheduler: durable cron tasks with a time zone', () => {
  it('stores the zone in the spec and runs a fixed hour once across the fall back', async () => {
    useClock('2026-10-31T12:00:00Z')
    const store = new MemoryScheduleStore()
    const s = new Scheduler({ store })
    const runs: ScheduledRun[] = []
    const task = s.cron('30 1 * * *', { id: 'nightly', timeZone: NY }, (run) => { runs.push(run) })
    expect(task.timeZone).toBe(NY)
    expect(task.cron).toBe('30 1 * * *')
    await s.start()
    expect(await store.get('nightly')).toMatchObject({ spec: `TZ=${NY} 30 1 * * *`, nextRunAt: at('2026-11-01T05:30:00Z') })
    await advanceTo('2026-11-01T08:00:00Z')
    expect(runs.map((r) => r.occurrenceKey)).toEqual(['nightly@2026-11-01T05:30:00.000Z'])
    expect((await store.get('nightly'))?.nextRunAt).toBe(at('2026-11-02T06:30:00Z'))
    s.stop()
  })

  it('runs a wildcard hour in both passes of the overlap, with distinct occurrence keys', async () => {
    useClock('2026-11-01T04:45:00Z')
    const s = new Scheduler({ store: new MemoryScheduleStore() })
    const keys: string[] = []
    s.cron('*/30 * * * *', { id: 'half', timeZone: NY }, (run) => { keys.push(run.occurrenceKey) })
    await s.start()
    await advanceTo('2026-11-01T06:45:00Z')
    expect(keys).toEqual([
      'half@2026-11-01T05:00:00.000Z',
      'half@2026-11-01T05:30:00.000Z',
      'half@2026-11-01T06:00:00.000Z',
      'half@2026-11-01T06:30:00.000Z',
    ])
    s.stop()
  })

  it('takes the scheduler default zone, and changing the zone recomputes the stored row', async () => {
    useClock('2026-01-01T00:00:00Z')
    const store = new MemoryScheduleStore()
    const a = new Scheduler({ store, timeZone: 'Asia/Kolkata' })
    a.cron('0 9 * * *', { id: 'report' }, () => {})
    await a.start()
    expect(await store.get('report')).toMatchObject({ spec: 'TZ=Asia/Kolkata 0 9 * * *', nextRunAt: at('2026-01-01T03:30:00Z') })
    a.stop()

    const b = new Scheduler({ store })
    const t = b.cron('0 9 * * *', { id: 'report', timeZone: 'UTC' }, () => {})
    await b.start()
    expect(await store.get('report')).toMatchObject({ spec: 'TZ=UTC 0 9 * * *', nextRunAt: at('2026-01-01T09:00:00Z') })
    expect(t.nextRun?.toISOString()).toBe('2026-01-01T09:00:00.000Z')
    b.stop()
  })

  it('stores exactly the bare expression without a zone (compatibility)', async () => {
    useClock('2026-01-01T00:00:00Z')
    const store = new MemoryScheduleStore()
    const s = new Scheduler({ store })
    const t = s.cron('0  9 * * *', { id: 'plain' }, () => {})
    const local = s.cron('0 9 * * *', { id: 'local', timeZone: 'local' }, () => {})
    await s.start()
    expect((await store.get('plain'))?.spec).toBe('0 9 * * *')
    expect((await store.get('local'))?.spec).toBe('0 9 * * *')
    expect(t.timeZone).toBeUndefined()
    expect(local.timeZone).toBeUndefined()
    s.stop()
  })

  it('catch-up across the spring-forward gap runs only real slots', async () => {
    useClock('2026-03-08T04:30:00Z') // 23:30 EST
    const store = new MemoryScheduleStore()
    const a = new Scheduler({ store })
    a.cron('0 * * * *', { id: 'hourly', timeZone: NY }, () => {})
    await a.start()
    a.stop()
    expect((await store.get('hourly'))?.nextRunAt).toBe(at('2026-03-08T05:00:00Z'))

    vi.setSystemTime(at('2026-03-08T09:10:00Z')) // down for the night, across 02:00 → 03:00
    const b = new Scheduler({ store })
    const slots: string[] = []
    b.cron('0 * * * *', { id: 'hourly', timeZone: NY, missed: 'catch-up' }, (run) => { slots.push(run.scheduledAt.toISOString()) })
    await b.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(slots).toEqual([
      '2026-03-08T05:00:00.000Z', // 00:00 EST
      '2026-03-08T06:00:00.000Z', // 01:00 EST
      '2026-03-08T07:00:00.000Z', // 03:00 EDT (no 02:00)
      '2026-03-08T08:00:00.000Z',
      '2026-03-08T09:00:00.000Z',
    ])
    expect((await store.get('hourly'))?.nextRunAt).toBe(at('2026-03-08T10:00:00Z'))
    b.stop()
  })
})

describe('Bot.schedule with a time zone', () => {
  it('accepts { timeZone } (plain) and { id, timeZone } (durable), and BotConfig.scheduler.timeZone', async () => {
    useClock('2026-06-01T00:00:00Z')
    const bot = new Bot({ provider: new MockProvider(), scheduler: { timeZone: 'Europe/Madrid' } })
    const plain = bot.schedule('0 9 * * *', { timeZone: 'UTC' }, () => {})
    const byDefault = bot.schedule('0 9 * * *', () => {})
    const durable = bot.schedule('0 9 * * *', { id: 'tz', timeZone: NY }, (run) => { void run.occurrenceKey })
    expect(plain.timeZone).toBe('UTC')
    expect(byDefault.timeZone).toBe('Europe/Madrid')
    expect(durable.timeZone).toBe(NY)
    await bot.start()
    expect(plain.nextRun?.toISOString()).toBe('2026-06-01T09:00:00.000Z')
    expect(byDefault.nextRun?.toISOString()).toBe('2026-06-01T07:00:00.000Z') // 09:00 CEST
    expect(durable.nextRun?.toISOString()).toBe('2026-06-01T13:00:00.000Z') // 09:00 EDT
    await bot.stop()
  })

  it('an unconfigured bot keeps host-local cron tasks', () => {
    useClock('2026-06-01T00:00:00Z')
    const bot = new Bot({ provider: new MockProvider() })
    const t = bot.schedule('0 9 * * *', () => {})
    expect(t.timeZone).toBeUndefined()
    expect(t.nextRun?.getTime() ?? 0).toBeGreaterThan(Date.now() - MIN)
  })
})
