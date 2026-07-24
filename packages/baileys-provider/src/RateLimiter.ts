/**
 * RateLimiter — Token bucket rate limiter for outbound messages.
 *
 * WhatsApp bans accounts that send too many messages in a short period. This
 * rate limiter sits in the `before('send')` hook pipeline and enforces:
 *   - Per-chat limits (e.g. max 5 messages per 10 seconds to the same chat)
 *   - Global limits (e.g. max 50 messages per 60 seconds across all chats)
 *   - Optional human-like jitter between sends
 *
 * When a limit is exceeded, the send is queued (not dropped) and released
 * once the bucket refills. A blocked chat never stalls other chats: the queue
 * is scanned for the first send whose buckets currently allow it. Sends that
 * wait longer than `maxWait` are rejected so a caller can never hang forever.
 *
 * @example
 * ```ts
 * const bot = new Bot({
 *   session: 'my-bot',
 *   rateLimit: {
 *     perChat: { max: 5, window: '10s' },
 *     global: { max: 50, window: '60s' },
 *     jitter: { min: 500, max: 1500 },
 *   },
 * })
 * ```
 */

import { parseDuration } from '@bot-wa/core'

export interface RateLimitBucketConfig {
  /** Maximum tokens (messages) allowed in the window. */
  max: number
  /** Time window for the bucket (e.g. '10s', '1m'). */
  window: string | number
}

export interface RateLimitJitterConfig {
  /** Minimum delay in ms between sends. */
  min: number
  /** Maximum delay in ms between sends. */
  max: number
}

export interface RateLimitConfig {
  /** Per-chat rate limit. Default: { max: 5, window: '10s' } */
  perChat?: RateLimitBucketConfig
  /** Global rate limit across all chats. Default: { max: 50, window: '60s' } */
  global?: RateLimitBucketConfig
  /** Human-like jitter between sends. Default: disabled. */
  jitter?: RateLimitJitterConfig
  /** Set to false to disable rate limiting entirely. Default: true. */
  enabled?: boolean
  /**
   * Max time a send may wait in the queue before it is rejected with
   * {@link RateLimiterTimeout}. Prevents a mis-configured limit from hanging a
   * caller forever. Default: '30s'. Set to `0` to wait indefinitely.
   */
  maxWait?: string | number
  /**
   * Max distinct per-chat buckets kept in memory. Idle (fully-refilled) buckets
   * are evicted first, so eviction never lifts an active limit. Default: 5000.
   */
  maxChats?: number
}

interface TokenBucket {
  tokens: number
  lastRefill: number
  max: number
  windowMs: number
}

interface QueuedSend {
  resolve: () => void
  reject: (err: Error) => void
  chatId: string
  enqueuedAt: number
}

const DEFAULT_PER_CHAT: RateLimitBucketConfig = { max: 5, window: '10s' }
const DEFAULT_GLOBAL: RateLimitBucketConfig = { max: 50, window: '60s' }
const DEFAULT_MAX_WAIT = '30s'
const DEFAULT_MAX_CHATS = 5000

/** Thrown when a queued send waits longer than the configured `maxWait`. */
export class RateLimiterTimeout extends Error {
  constructor(public readonly chatId: string, public readonly waitedMs: number) {
    super(`RateLimiter: send to ${chatId} exceeded maxWait after ${waitedMs}ms`)
    this.name = 'RateLimiterTimeout'
  }
}

export class RateLimiter {
  private perChatBuckets = new Map<string, TokenBucket>()
  private globalBucket: TokenBucket
  private queue: QueuedSend[] = []
  private processing = false
  private lastSendAt = 0
  /** Bumped by reset() so an in-flight drain from a previous cycle bails out. */
  private generation = 0
  private readonly perChatMax: number
  private readonly perChatWindowMs: number
  private readonly maxChats: number
  private readonly maxWaitMs: number
  private readonly jitterMin: number
  private readonly jitterMax: number
  private readonly enabled: boolean

  constructor(config: RateLimitConfig = {}) {
    this.enabled = config.enabled !== false

    const perChat = config.perChat ?? DEFAULT_PER_CHAT
    assertPositive('perChat.max', perChat.max)
    this.perChatMax = perChat.max
    this.perChatWindowMs = parseDuration(perChat.window)
    assertPositive('perChat.window', this.perChatWindowMs)

    const global = config.global ?? DEFAULT_GLOBAL
    assertPositive('global.max', global.max)
    const globalWindowMs = parseDuration(global.window)
    assertPositive('global.window', globalWindowMs)
    this.globalBucket = {
      tokens: global.max,
      lastRefill: Date.now(),
      max: global.max,
      windowMs: globalWindowMs,
    }

    this.jitterMin = config.jitter?.min ?? 0
    this.jitterMax = config.jitter?.max ?? 0
    this.maxWaitMs = config.maxWait !== undefined ? parseDuration(config.maxWait) : parseDuration(DEFAULT_MAX_WAIT)
    this.maxChats = config.maxChats ?? DEFAULT_MAX_CHATS
    assertNonNegative('jitter.min', this.jitterMin)
    assertNonNegative('jitter.max', this.jitterMax)
    if (this.jitterMax < this.jitterMin) {
      throw new RangeError('RateLimiter jitter.max must be greater than or equal to jitter.min')
    }
    assertNonNegative('maxWait', this.maxWaitMs)
    assertPositiveInteger('maxChats', this.maxChats)
  }

  /**
   * Acquire permission to send a message to `chatId`. Resolves when the send is
   * allowed (may wait if rate-limited). Rejects with {@link RateLimiterTimeout}
   * if it waits past `maxWait`, or a generic error if the limiter is reset.
   */
  async acquire(chatId: string): Promise<void> {
    if (!this.enabled) return

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, chatId, enqueuedAt: Date.now() })
      this.processQueue()
    })
  }

  /** Number of messages currently waiting in the queue. */
  get pending(): number {
    return this.queue.length
  }

  /** Number of per-chat buckets currently tracked (bounded by `maxChats`). */
  get trackedChats(): number {
    return this.perChatBuckets.size
  }

  private processQueue(): void {
    if (this.processing) return
    this.processing = true
    const gen = this.generation
    void this.drain(gen)
  }

  private async drain(gen: number): Promise<void> {
    while (this.queue.length > 0) {
      if (this.generation !== gen) return // reset() happened — abandon this drain
      const now = Date.now()

      // Reject sends that have waited too long (walk backwards: splicing is safe).
      if (this.maxWaitMs > 0) {
        for (let i = this.queue.length - 1; i >= 0; i--) {
          const it = this.queue[i]!
          const waited = now - it.enqueuedAt
          if (waited >= this.maxWaitMs) {
            this.queue.splice(i, 1)
            it.reject(new RateLimiterTimeout(it.chatId, waited))
          }
        }
        if (this.queue.length === 0) break
      }

      // Send the FIRST queued item whose buckets allow it now — scanning past a
      // blocked head keeps one rate-limited chat from stalling every other chat.
      // FIFO within a chat is preserved: an older blocked item shares its bucket
      // with newer items of the same chat, so they stay blocked together.
      let sent = false
      for (let i = 0; i < this.queue.length; i++) {
        if (this.tryConsume(this.queue[i]!.chatId, now)) {
          const item = this.queue.splice(i, 1)[0]!
          const jitter = this.computeJitter()
          if (jitter > 0) await this.sleep(jitter)
          this.lastSendAt = Date.now()
          item.resolve()
          sent = true
          break
        }
      }

      if (!sent) await this.sleep(this.nextRefillDelay(now))
    }
    if (this.generation === gen) this.processing = false
  }

  private tryConsume(chatId: string, now = Date.now()): boolean {
    // Refill global bucket
    this.refillBucket(this.globalBucket, now)
    if (this.globalBucket.tokens < 1) return false

    // Refill (creating if needed) per-chat bucket
    let chatBucket = this.perChatBuckets.get(chatId)
    if (!chatBucket) {
      chatBucket = {
        tokens: this.perChatMax,
        lastRefill: now,
        max: this.perChatMax,
        windowMs: this.perChatWindowMs,
      }
      this.perChatBuckets.set(chatId, chatBucket)
      this.pruneBuckets(now)
    }
    this.refillBucket(chatBucket, now)
    if (chatBucket.tokens < 1) return false

    // Consume from both
    this.globalBucket.tokens -= 1
    chatBucket.tokens -= 1
    return true
  }

  private refillBucket(bucket: TokenBucket, now: number): void {
    const elapsed = now - bucket.lastRefill
    if (elapsed <= 0) return

    const refillRate = bucket.max / bucket.windowMs
    const tokensToAdd = elapsed * refillRate
    bucket.tokens = Math.min(bucket.max, bucket.tokens + tokensToAdd)
    bucket.lastRefill = now
  }

  /** Time (ms) until the soonest queued send could proceed — used instead of busy-polling. */
  private nextRefillDelay(now: number): number {
    const timeToOneToken = (b: TokenBucket) =>
      b.tokens >= 1 ? 0 : (1 - b.tokens) * (b.windowMs / b.max)

    let wait = Infinity
    // If the global bucket is the blocker, that gates everything.
    wait = Math.min(wait, timeToOneToken(this.globalBucket))
    for (const it of this.queue) {
      const b = this.perChatBuckets.get(it.chatId)
      // No bucket yet ⇒ a fresh full bucket ⇒ sendable immediately.
      wait = b ? Math.min(wait, timeToOneToken(b)) : 0
      if (wait === 0) break
    }
    if (!Number.isFinite(wait)) wait = 100
    // Clamp: never spin faster than 10ms, never sleep past 1s (re-checks bound staleness).
    return Math.max(10, Math.min(Math.ceil(wait), 1000))
  }

  /** Evict idle (fully-refilled) buckets when over `maxChats`; never drops an active limit. */
  private pruneBuckets(now: number): void {
    if (this.perChatBuckets.size <= this.maxChats) return
    for (const [id, b] of this.perChatBuckets) {
      if (this.perChatBuckets.size <= this.maxChats) break
      this.refillBucket(b, now)
      if (b.tokens >= b.max) this.perChatBuckets.delete(id) // idle → recreating it is a no-op
    }
    // All remaining are active; fall back to oldest-first (global bucket still caps totals).
    while (this.perChatBuckets.size > this.maxChats) {
      const oldest = this.perChatBuckets.keys().next()
      if (oldest.done) break
      this.perChatBuckets.delete(oldest.value)
    }
  }

  private computeJitter(): number {
    if (this.jitterMin <= 0 && this.jitterMax <= 0) return 0
    const min = Math.max(this.jitterMin, 0)
    const max = Math.max(this.jitterMax, min)
    return min + Math.random() * (max - min)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** Clear all buckets and the queue (e.g. on bot stop). */
  reset(): void {
    this.generation++
    this.perChatBuckets.clear()
    this.globalBucket.tokens = this.globalBucket.max
    this.globalBucket.lastRefill = Date.now()
    // Reject all queued sends
    for (const item of this.queue) {
      item.reject(new Error('RateLimiter reset'))
    }
    this.queue = []
    this.processing = false
  }
}

function assertPositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`RateLimiter ${field} must be a finite number greater than 0`)
  }
}

function assertNonNegative(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`RateLimiter ${field} must be a finite number greater than or equal to 0`)
  }
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`RateLimiter ${field} must be a positive integer`)
  }
}
