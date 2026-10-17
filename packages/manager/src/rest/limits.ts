/**
 * Rate limiting (token bucket) and idempotency-key replay cache for the REST API.
 * Both are in-memory and per process; plug your own for a multi-instance deployment
 * through the {@link RateLimiter} / {@link IdempotencyStore} interfaces.
 */

/** Decision of a {@link RateLimiter}. */
export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  /** Seconds until one more request is allowed (only when `allowed` is false). */
  retryAfterSeconds?: number
}

/** Pluggable rate limiter keyed by principal id (or client address for anonymous calls). */
export interface RateLimiter {
  take(key: string): RateLimitDecision
}

/** Options of {@link TokenBucketRateLimiter}. */
export interface TokenBucketOptions {
  /** Burst size (bucket capacity). Default `60`. */
  capacity?: number
  /** Tokens added per second. Default `1` (60 requests/minute sustained). */
  refillPerSecond?: number
  /** Buckets kept before the least recently used is evicted. Default `10000`. */
  maxKeys?: number
  /** Clock in ms (tests). Default `Date.now`. */
  now?: () => number
}

/** Classic token bucket per key, with LRU eviction of idle buckets. */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  constructor(opts: TokenBucketOptions = {}) {
    this.capacity = opts.capacity ?? 60
    this.refillPerMs = (opts.refillPerSecond ?? 1) / 1000
    this.maxKeys = opts.maxKeys ?? 10_000
    this.now = opts.now ?? Date.now
    if (!(this.capacity >= 1) || !(this.refillPerMs > 0)) throw new RangeError('rate limit capacity must be >= 1 and refillPerSecond > 0')
  }

  take(key: string): RateLimitDecision {
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (bucket) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs)
      bucket.at = now
      this.buckets.delete(key)
    } else {
      bucket = { tokens: this.capacity, at: now }
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!)
    }
    this.buckets.set(key, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true, limit: this.capacity, remaining: Math.floor(bucket.tokens) }
    }
    return {
      allowed: false,
      limit: this.capacity,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000)),
    }
  }
}

/** A completed response kept for idempotent replay. */
export interface StoredResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

/** Pluggable store behind `Idempotency-Key` handling. */
export interface IdempotencyStore {
  /**
   * Run `operation` once per `key`. A repeat with the same `fingerprint` replays the stored
   * response (`replayed: true`); a different fingerprint is a conflict (`'mismatch'`).
   * Concurrent repeats wait for the first one. 5xx outcomes are not kept.
   */
  run(key: string, fingerprint: string, operation: () => Promise<StoredResponse>): Promise<{ response: StoredResponse; replayed: boolean } | 'mismatch'>
}

/** Options of {@link MemoryIdempotencyStore}. */
export interface MemoryIdempotencyOptions {
  /** How long a response is replayable, in ms. Default 24 h. */
  ttlMs?: number
  /** Entries kept before the oldest is evicted. Default `1000`. */
  maxEntries?: number
  now?: () => number
}

/** In-memory {@link IdempotencyStore} with TTL and bounded size. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly entries = new Map<string, { fingerprint: string; at: number; promise: Promise<StoredResponse> }>()

  constructor(opts: MemoryIdempotencyOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000
    this.maxEntries = opts.maxEntries ?? 1000
    this.now = opts.now ?? Date.now
  }

  async run(key: string, fingerprint: string, operation: () => Promise<StoredResponse>): Promise<{ response: StoredResponse; replayed: boolean } | 'mismatch'> {
    const now = this.now()
    const existing = this.entries.get(key)
    if (existing && now - existing.at <= this.ttlMs) {
      if (existing.fingerprint !== fingerprint) return 'mismatch'
      return { response: await existing.promise, replayed: true }
    }
    if (existing) this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
    const promise = operation()
    const entry = { fingerprint, at: now, promise }
    this.entries.set(key, entry)
    try {
      const response = await promise
      if (response.status >= 500 && this.entries.get(key) === entry) this.entries.delete(key)
      return { response, replayed: false }
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    }
  }
}
