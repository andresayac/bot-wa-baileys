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
