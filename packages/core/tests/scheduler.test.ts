import { afterEach, describe, expect, it, vi } from 'vitest'

import { Scheduler } from '../src/scheduler/Scheduler.js'

afterEach(() => {
  vi.useRealTimers()
  vi.setSystemTime(new Date())
})

describe('Scheduler lifecycle', () => {
  it('schedules tasks registered before start()', async () => {
    vi.useFakeTimers()
    const scheduler = new Scheduler()
    const handler = vi.fn()
    scheduler.every(100, handler)

    await vi.advanceTimersByTimeAsync(500)
    expect(handler).not.toHaveBeenCalled()

    scheduler.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('stop pauses tasks without deleting their definitions', async () => {
    vi.useFakeTimers()
    const scheduler = new Scheduler()
    const handler = vi.fn()
    scheduler.every(100, handler)
    scheduler.start()

    await vi.advanceTimersByTimeAsync(100)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(handler).toHaveBeenCalledTimes(1)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('finds monthly cron runs more than seven days away', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T12:00:00Z'))
    const scheduler = new Scheduler()
    const task = scheduler.cron('0 0 1 * *', () => {})

    expect(task.nextRun).not.toBeNull()
    expect(task.nextRun!.getUTCMonth()).toBe(7)
    expect(task.nextRun!.getUTCDate()).toBe(1)
  })
})

describe('Scheduler: runs further away than the 32-bit timer limit', () => {
  const MAX_TIMER = 2 ** 31 - 1
  const DAY = 24 * 60 * 60 * 1000

  it('never arms a timer longer than the platform limit', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const scheduler = new Scheduler()
    scheduler.start()
    scheduler.delay('40d', () => {})
    scheduler.cron('0 0 1 */3 *', () => {})
    for (const call of spy.mock.calls) expect(Number(call[1] ?? 0)).toBeLessThanOrEqual(MAX_TIMER)
    spy.mockRestore()
    scheduler.stop()
  })

  it('a far one-shot task waits for its date and a quarterly cron runs once per date', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 2, 0, 0))
    const scheduler = new Scheduler()
    scheduler.start()
    const once = vi.fn()
    const quarterly = vi.fn()
    scheduler.delay('40d', once)
    scheduler.cron('0 0 1 */3 *', quarterly) // next: Apr 1

    await vi.advanceTimersByTimeAsync(1000)
    expect(once).not.toHaveBeenCalled()
    expect(quarterly).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(39 * DAY)
    expect(once).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DAY)
    expect(once).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(60 * DAY) // past Apr 1
    expect(quarterly).toHaveBeenCalledOnce()
    scheduler.stop()
  })
})

describe('Scheduler: cron day-of-month / weekday semantics (standard cron)', () => {
  // Local-time dates: the minimal parser evaluates fields in the process timezone.
  const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h, 0, 0, 0)
  const next = (expr: string, from: Date) => {
    vi.useFakeTimers()
    vi.setSystemTime(from)
    return new Scheduler().cron(expr, () => {}).nextRun
  }

  it('ORs day-of-month and weekday when both are restricted', () => {
    // Fri 2026-07-10: "the 13th OR any Friday" → Mon 13th (AND would wait for Fri 13 Nov)
    expect(next('0 9 13 * 5', at(2026, 7, 10))).toEqual(at(2026, 7, 13, 9))
    expect(next('0 9 13 * 5', at(2026, 7, 13))).toEqual(at(2026, 7, 17, 9))
  })

  it('a list day-of-month with a weekday range runs on either', () => {
    // 1st/15th OR Monday–Friday, from Sat 2026-08-01 noon → Mon 3rd
    expect(next('0 8 1,15 * 1-5', at(2026, 8, 1))).toEqual(at(2026, 8, 3, 8))
    // from Fri 14 noon → Sat 15th (the 15th matches even on a weekend)
    expect(next('0 8 1,15 * 1-5', at(2026, 8, 14))).toEqual(at(2026, 8, 15, 8))
  })

  it('only the restricted one applies when the other is *', () => {
    expect(next('0 9 * * 1', at(2026, 7, 10))).toEqual(at(2026, 7, 13, 9))
    expect(next('0 9 20 * *', at(2026, 7, 10))).toEqual(at(2026, 7, 20, 9))
  })

  it('a field starting with * (e.g. */2) counts as unrestricted: the two are ANDed', () => {
    // Odd days AND Mondays, from Tue 2026-07-14: Mon 20 is even → Mon 27
    expect(next('0 9 */2 * 1', at(2026, 7, 14))).toEqual(at(2026, 7, 27, 9))
  })

  it('weekday 7 is still Sunday under the OR rule', () => {
    // 31st OR Sunday, from Fri 2026-07-10 → Sun 12th
    expect(next('0 9 31 * 7', at(2026, 7, 10))).toEqual(at(2026, 7, 12, 9))
  })
})

describe('Scheduler: cron steps start at the field minimum', () => {
  const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h, 0, 0, 0)
  const next = (expr: string, from: Date) => {
    vi.useFakeTimers()
    vi.setSystemTime(from)
    return new Scheduler().cron(expr, () => {}).nextRun
  }

  it('*/3 in the month field is Jan, Apr, Jul, Oct', () => {
    expect(next('0 0 1 */3 *', at(2026, 1, 2))).toEqual(at(2026, 4, 1, 0))
  })

  it('*/2 in the day-of-month field is the odd days', () => {
    expect(next('0 9 */2 * *', at(2026, 7, 1))).toEqual(at(2026, 7, 3, 9))
  })

  it('*/15 in the minute field still starts at 0', () => {
    expect(next('*/15 * * * *', new Date(2026, 6, 1, 10, 50))).toEqual(new Date(2026, 6, 1, 11, 0))
  })
})
