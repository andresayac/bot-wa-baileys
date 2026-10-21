/**
 * Echo filter (`BotConfig.echoFilter`, opt-in): a provider-independent guard against the
 * bot's own messages coming back as inbound.
 *
 * Every provider sets `fromMe` on what it can recognise as the bot's own message, and the
 * core drops those before anything else. A few transports only know their own id after a
 * handshake (`selfId`), and a mailbox or a gateway may hand back a message the bot just
 * sent with no such mark. This ring remembers the refs of the sends that succeeded
 * (bounded, least-recent first, optional TTL) and the inbound pipeline drops an inbound
 * message whose ref is in it, before dedupe, journaling and counters, so an echo never
 * counts as a message nor pollutes the journal. Keyed like the deduper (`messageKey`: chat
 * id + message id, both opaque), so ids that are only unique per chat never collide.
 *
 * It complements the provider's `fromMe`, it does not replace it: a socket transport can
 * deliver the echo before the REST send resolves, and that echo is still the provider's to
 * mark.
 */

import { messageKey, type MessageRef } from './provider.js'
import { ConfigValidationError } from '../utils/validateConfig.js'
import { parseDuration } from '../utils/duration.js'

/** Default number of sent refs a {@link SentRefRing} remembers. */
export const DEFAULT_ECHO_FILTER_SIZE = 1000

/** User-facing options of `BotConfig.echoFilter`. */
export interface EchoFilterOptions {
  /** Maximum number of remembered sent refs (least-recent evicted). Positive integer; default 1000. */
  size?: number
  /** Optional time-to-live per remembered ref (`'30s'`, `'10m'` or ms) measured from the send; `0`/omitted = until evicted. */
  ttl?: string | number
}

/** Constructor options of {@link SentRefRing} (adds an injectable clock). */
export interface SentRefRingOptions extends EchoFilterOptions {
  /** Clock in epoch ms. Defaults to `Date.now`; inject one in tests. */
  now?: () => number
}

/** Bounded, least-recent-first set of the refs the bot sent, with optional TTL. */
export class SentRefRing {
  readonly size: number
  readonly ttlMs: number
  private readonly entries = new Map<string, number>()
  private readonly now: () => number

  /** @throws {ConfigValidationError} when `size`/`ttl` are invalid. */
  constructor(options: SentRefRingOptions = {}) {
    const size = options.size ?? DEFAULT_ECHO_FILTER_SIZE
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
      throw new ConfigValidationError('echoFilter.size', 'a positive integer', size)
    }
    let ttlMs = 0
    if (options.ttl !== undefined) {
      if (typeof options.ttl !== 'string' && typeof options.ttl !== 'number') {
        throw new ConfigValidationError('echoFilter.ttl', 'string | number', options.ttl)
      }
      try { ttlMs = parseDuration(options.ttl) }
      catch { throw new ConfigValidationError('echoFilter.ttl', "a duration ('30s', '10m', '1h') or ms", options.ttl) }
      if (!Number.isFinite(ttlMs) || ttlMs < 0) {
        throw new ConfigValidationError('echoFilter.ttl', 'a non-negative duration', options.ttl)
      }
    }
    this.size = size
    this.ttlMs = ttlMs
    this.now = options.now ?? (() => Date.now())
  }

  /** Number of refs currently remembered. */
  get remembered(): number { return this.entries.size }

  /** Record a successful send. A ref without an id or chat id is never remembered. */
  remember(ref: MessageRef): void {
    if (!ref.id || !ref.chatId) return
    const key = messageKey(ref)
    this.entries.delete(key)
    this.entries.set(key, this.now())
    while (this.entries.size > this.size) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /**
   * Check-and-forget: `true` when `ref` is a remembered (unexpired) send, which is then
   * forgotten (an echo is delivered once; a later redelivery is the deduper's business).
   */
  has(ref: MessageRef): boolean {
    if (!ref.id || !ref.chatId) return false
    const key = messageKey(ref)
    const at = this.entries.get(key)
    if (at === undefined) return false
    this.entries.delete(key)
    return !(this.ttlMs > 0 && this.now() - at >= this.ttlMs)
  }

  clear(): void { this.entries.clear() }
}

/** `null` when `config` is `undefined` (filter off). @throws {ConfigValidationError} */
export function createEchoFilter(config: EchoFilterOptions | true | undefined): SentRefRing | null {
  if (config === undefined) return null
  if (config === true) return new SentRefRing()
  if (typeof config !== 'object' || config === null) {
    throw new ConfigValidationError('echoFilter', 'true | { size?, ttl? }', config)
  }
  return new SentRefRing(config)
}
