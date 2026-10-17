/** Timer helpers — Promise-friendly, supports human-like delays. */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Human-paced typing delay: ~30-50ms per char with jitter. */
export function humanTypingDelay(text: string, msPerChar = 40): number {
  return Math.min(
    Math.round(text.length * msPerChar * (0.85 + Math.random() * 0.3)),
    5000  // cap at 5 seconds
  )
}

/** Parse common durations ("5s", "1m", "2h", "1d") or ms number → ms. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input
  const match = /^(\d+(?:\.\d+)?)\s*(ms|milli|millis|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/.exec(input.trim())
  if (!match) throw new Error(`Invalid duration: ${input}`)
  const value = parseFloat(match[1])
  const unitRaw = (match[2] ?? 'ms').toLowerCase()
  // Normalize to short unit
  const unit = unitRaw.startsWith('ms') || unitRaw.startsWith('milli') ? 'ms'
    : unitRaw.startsWith('s') ? 's'
    : unitRaw.startsWith('m') ? 'm'
    : unitRaw.startsWith('h') ? 'h'
    : unitRaw.startsWith('d') ? 'd'
    : unitRaw.startsWith('w') ? 'w'
    : 'ms'
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }
  return Math.round(value * multipliers[unit])
}

/**
 * Longest delay a Node timer can hold: 2^31 − 1 ms (about 24.8 days). `setTimeout` with a
 * larger delay does not wait — it fires after 1 ms (`TimeoutOverflowWarning`).
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Parse an inactivity period — the single parser behind `bot.onIdle()` and `c.idle()`.
 * Accepts everything {@link parseDuration} does (`'90s'`, `'10m'`, `'2 hours'`, `'1d'`, ms) and
 * requires a positive, finite value of at most {@link MAX_TIMER_MS}; throws `RangeError` otherwise
 * (an unparsable string throws the parser's `Error`). Internal.
 */
export function parseIdlePeriod(duration: string | number, api: string): number {
  const ms = parseDuration(duration)
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`${api} needs a positive, finite duration — got ${JSON.stringify(duration)}`)
  }
  if (ms > MAX_TIMER_MS) {
    throw new RangeError(`${api} supports at most ${MAX_TIMER_MS} ms (about 24 days) — got ${JSON.stringify(duration)}`)
  }
  return ms
}

/** Race a promise against a timeout — rejects with `TimeoutError` if exceeded. */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message)
    this.name = 'TimeoutError'
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(message)),
      ms
    )
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

/** Generate a random ID suitable for tasks, hooks, etc. */
export function randomId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const time = Date.now().toString(36)
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`
}
