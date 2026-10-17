/**
 * Inbound idempotency — a bounded "seen" set that stops a redelivered inbound
 * event from running handlers twice.
 *
 * Why: webhook transports (WhatsApp Cloud API, Messenger, Instagram, Telegram
 * webhook) retry a delivery whenever they do not see a timely 2xx, and socket
 * transports (Baileys) can replay recent messages after a reconnect / offline
 * sync. Without a guard, the same message would trigger a flow twice, or be
 * consumed as the answer to the NEXT question of a running conversation.
 *
 * Keys are transport-agnostic and built from opaque ids only:
 *  - messages:     `chatId` + `ref.id` (ids are only unique per chat on some
 *                  transports, e.g. Telegram `message_id`);
 *  - interactions: `chatId` + `interactionId` (NOT the ref of the message the
 *                  button belongs to — two clicks on one menu are distinct).
 * A content fingerprint (type + body, hashed — bodies are never retained) is
 * stored with each key so an *edit* that reuses the original id (Telegram
 * `edited_message`) is treated as new input, while an identical retry is not.
 * Messages without an id are never deduplicated.
 *
 * This makes id uniqueness part of the provider contract (INBOUND ID CONTRACT
 * on `IProvider`): an id must name ONE logical event and survive redelivery
 * unchanged. A provider that reuses an id for distinct events (e.g. the sender
 * id for every referral) gets the later ones dropped; it must emit `''` instead.
 *
 * Memory is bounded by `size` (least-recently-seen eviction) and, optionally,
 * by `ttl`. The set lives in process memory: it protects one Bot instance; it
 * does not deduplicate across replicas or across a process restart.
 *
 * @example
 * ```ts
 * new Bot({ provider, dedupe: { size: 5000, ttl: '1h' } }) // tune
 * new Bot({ provider, dedupe: false })                       // opt out
 * ```
 */

import type { InboundEvent } from './provider.js'
import { ConfigValidationError } from '../utils/validateConfig.js'
import { parseDuration } from '../utils/duration.js'

/** Default number of inbound keys remembered by a {@link InboundDeduper}. */
export const DEFAULT_DEDUPE_SIZE = 1000

/** User-facing options for `BotConfig.dedupe`. */
export interface InboundDedupeOptions {
  /**
   * Maximum number of remembered inbound keys. When exceeded, the
   * least-recently-seen key is forgotten. Positive integer; default
   * {@link DEFAULT_DEDUPE_SIZE} (1000).
   */
  size?: number
  /**
   * Optional time-to-live per remembered key, in ms or as a duration string
   * (`'30s'`, `'10m'`, `'1h'`). Measured from when the key was first accepted.
   * `0`/omitted = keys live until evicted by `size`.
   */
  ttl?: string | number
}

/** Constructor options for {@link InboundDeduper} (adds an injectable clock). */
export interface InboundDeduperOptions extends InboundDedupeOptions {
  /** Clock in epoch ms. Defaults to `Date.now`; inject one in tests. */
  now?: () => number
}

/** The idempotency key (and content fingerprint) of one inbound event. */
export interface InboundDedupeKey {
  key: string
  fingerprint: string
}

interface Entry {
  fingerprint: string
  at: number
}

/**
 * Bounded LRU set of inbound keys with optional TTL.
 *
 * `isDuplicate(key, fingerprint)` is check-and-record in one synchronous step,
 * so two deliveries of one event arriving in the same tick (before either has
 * been processed) are still caught.
 */
export class InboundDeduper {
  /** Maximum number of remembered keys. */
  readonly size: number
  /** Time-to-live per key in ms (`0` = no expiry). */
  readonly ttlMs: number
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number

  /** @throws {ConfigValidationError} when `size`/`ttl` are invalid. */
  constructor(options: InboundDeduperOptions = {}) {
    const size = options.size ?? DEFAULT_DEDUPE_SIZE
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      throw new ConfigValidationError('dedupe.size', 'a positive integer', size)
    }
    let ttlMs = 0
    if (options.ttl !== undefined) {
      if (typeof options.ttl !== 'string' && typeof options.ttl !== 'number') {
        throw new ConfigValidationError('dedupe.ttl', 'string | number', options.ttl)
      }
      try { ttlMs = parseDuration(options.ttl) }
      catch { throw new ConfigValidationError('dedupe.ttl', "a duration ('30s', '10m', '1h') or ms", options.ttl) }
      if (!Number.isFinite(ttlMs) || ttlMs < 0) {
        throw new ConfigValidationError('dedupe.ttl', 'a non-negative duration', options.ttl)
      }
    }
    this.size = size
    this.ttlMs = ttlMs
    // Read the global clock on every call (not a captured reference) so fake timers installed later apply.
    this.now = options.now ?? (() => Date.now())
  }

  /** Number of keys currently remembered (expired keys may linger until touched or evicted). */
  get remembered(): number { return this.entries.size }

  /**
   * Check-and-record. Returns `true` when `key` was already accepted with the
   * same `fingerprint` and has not expired (the caller should drop the event);
   * otherwise remembers it and returns `false`.
   */
  isDuplicate(key: string, fingerprint = ''): boolean {
    const now = this.now()
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key) // re-inserted below → most-recently-seen position
      const alive = this.ttlMs <= 0 || now - hit.at < this.ttlMs
      if (alive && hit.fingerprint === fingerprint) {
        this.entries.set(key, hit)
        return true
      }
    }
    this.entries.set(key, { fingerprint, at: now })
    while (this.entries.size > this.size) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return false
  }

  /** Forget `key` (e.g. its processing failed before reaching handlers, so a retry must run). */
  release(key: string): void { this.entries.delete(key) }

  /** Forget everything. */
  clear(): void { this.entries.clear() }

  /**
   * Run `handle` for `event` unless it is a duplicate. A key is released again
   * when `handle` rejects, so a transport retry of an event that never reached
   * the handlers (e.g. the store was down) is processed.
   *
   * @returns `false` when the event was dropped as a duplicate.
   */
  async run(event: InboundEvent, handle: () => Promise<void>, onDuplicate?: () => void): Promise<boolean> {
    const id = inboundDedupeKey(event)
    if (id && this.isDuplicate(id.key, id.fingerprint)) {
      onDuplicate?.()
      return false
    }
    try {
      await handle()
    } catch (error) {
      if (id) this.release(id.key)
      throw error
    }
    return true
  }
}

/**
 * Resolve `BotConfig.dedupe` into a deduper: `undefined` → defaults,
 * `false` → `null` (disabled), an options object → validated deduper.
 *
 * @throws {ConfigValidationError} for any other value or invalid options.
 */
export function createInboundDeduper(config: InboundDedupeOptions | false | undefined): InboundDeduper | null {
  if (config === false) return null
  if (config === undefined) return new InboundDeduper()
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new ConfigValidationError('dedupe', '{ size?, ttl? } | false', config)
  }
  return new InboundDeduper({ size: config.size, ttl: config.ttl })
}

/**
 * The idempotency key of an inbound event, or `undefined` when the event must
 * never be deduplicated (no id, or a kind that is not dispatched to handlers).
 * Keys are length-prefixed so ids containing separators cannot collide.
 */
export function inboundDedupeKey(event: InboundEvent): InboundDedupeKey | undefined {
  if (event.kind === 'message') {
    const m = event.message
    const id = m.ref?.id
    const chat = m.chatId || m.ref?.chatId || ''
    if (typeof id !== 'string' || id === '') return undefined
    return { key: `m:${chat.length}:${chat}:${id}`, fingerprint: fingerprintOf(`${m.type}\u0000${m.body ?? ''}`) }
  }
  if (event.kind === 'interaction') {
    const it = event.interaction
    const id = it.interactionId
    const chat = it.chatId || it.ref?.chatId || ''
    if (typeof id !== 'string' || id === '') return undefined
    return { key: `i:${chat.length}:${chat}:${id}`, fingerprint: fingerprintOf(it.data ?? '') }
  }
  return undefined
}

/** Short, non-reversible content fingerprint (FNV-1a 32-bit + length); bodies are never stored. */
function fingerprintOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${text.length}:${(h >>> 0).toString(36)}`
}
