/**
 * Regression: a `start()` that rejects DURING a scheduled reconnect (e.g. a
 * transient network failure in fetchLatestBaileysVersion) must NOT kill the
 * provider permanently. Because no socket was built, no future
 * `connection: 'close'` event fires — so scheduleReconnect itself has to
 * reschedule the retry with backoff until it succeeds or the cap is hit.
 *
 * The provider is constructed under REAL timers (its internal NodeCache arms a
 * recurring housekeeping interval that would trip vitest's infinite-loop guard),
 * then fake timers are enabled just to drive the reconnect backoff.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { BaileysProvider } from '../src/BaileysProvider.js'
import { MAX_RECONNECT_ATTEMPTS } from '../src/reconnect.js'

type Internals = {
  start: () => Promise<void>
  scheduleReconnect(ms: number): void
  isShuttingDown: boolean
}

afterEach(() => { vi.useRealTimers() })

describe('BaileysProvider reconnect resilience', () => {
  it('reschedules and eventually recovers when start() keeps failing then succeeds', async () => {
    const p = new BaileysProvider({ session: 'test' })
    vi.useFakeTimers()
    let calls = 0
    // Fail the first two reconnect attempts, then succeed.
    ;(p as unknown as Internals).start = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('network blip')
    })

    ;(p as unknown as Internals).scheduleReconnect(0)
    await vi.runAllTimersAsync()

    expect(calls).toBe(3) // initial attempt + 2 backoff retries — provider is alive again
  })

  it('gives up after MAX_RECONNECT_ATTEMPTS and emits a terminal closed event', async () => {
    const p = new BaileysProvider({ session: 'test' })
    const closed: string[] = []
    p.onEvent((e) => {
      if (e.kind === 'connection' && e.update.state === 'closed') {
        closed.push(e.update.detail?.message ?? '')
      }
    })
    vi.useFakeTimers()
    const start = vi.fn(async () => { throw new Error('down') })
    ;(p as unknown as Internals).start = start

    ;(p as unknown as Internals).scheduleReconnect(0)
    await vi.runAllTimersAsync()

    expect(start.mock.calls.length).toBe(MAX_RECONNECT_ATTEMPTS + 1) // initial + MAX retries, then stop
    expect(closed).toContain('reconnect exhausted')
  })

  it('does not retry once shutting down', async () => {
    const p = new BaileysProvider({ session: 'test' })
    vi.useFakeTimers()
    let calls = 0
    ;(p as unknown as Internals).start = vi.fn(async () => { calls++; throw new Error('down') })
    ;(p as unknown as Internals).isShuttingDown = true

    ;(p as unknown as Internals).scheduleReconnect(0)
    await vi.runAllTimersAsync()

    expect(calls).toBe(0) // scheduleReconnect bails immediately when shutting down
  })
})
