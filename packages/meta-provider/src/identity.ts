/**
 * identity — WhatsApp usernames / business-scoped user IDs (BSUID) for the
 * Cloud API transport.
 *
 * Since April 2026 every Cloud API webhook carries a BSUID
 * (`messages[].from_user_id`, `contacts[].user_id`, `statuses[].recipient_user_id`).
 * When a user enables a WhatsApp username, the phone number (`from` / `wa_id`)
 * is OMITTED unless the business talked to them in the last 30 days or has them
 * in its contact book. So the same human can arrive as "phone + BSUID" on one
 * webhook and "BSUID only" on the next.
 *
 * The core's stability contract requires the same human to keep the same
 * chatId/senderId, so this module resolves every webhook party to ONE canonical
 * id before emission:
 *
 *  1. If this session already emitted an id for any of the party's identifiers
 *     (BSUID, parent BSUID or phone), that id is reused (session pin).
 *  2. Otherwise the phone (wa_id) when present in the webhook,
 *  3. otherwise the phone previously learned for that BSUID (`IdentityMap`),
 *  4. otherwise the BSUID itself.
 *
 * Phone ↔ BSUID pairs are learned from any webhook that carries both and are
 * written to the pluggable {@link IdentityMap}, so a host can persist them and
 * keep phone-based ids across restarts.
 */

/** A value or a promise of it — lets an {@link IdentityMap} be sync or async. */
export type MaybePromise<T> = T | Promise<T>

/**
 * Pluggable store of learned BSUID → phone (wa_id) links.
 *
 * Methods may be synchronous (in-memory, preloaded cache) or return promises
 * (Redis, SQL...). With a synchronous map, events are emitted synchronously from
 * `ingest()`; with an async one they are emitted once the lookup settles, always
 * in webhook order. `set` is called once per pair per session (fire-and-forget:
 * a rejection is logged, never thrown), so implementations should be idempotent.
 */
export interface IdentityMap {
  /** The phone number (wa_id, digits only) learned for this BSUID, if any. */
  get(bsuid: string): MaybePromise<string | undefined>
  /** Remember that `bsuid` belongs to the phone number `phone` (wa_id). */
  set(bsuid: string, phone: string): MaybePromise<void>
}

/** Options for {@link MemoryIdentityMap}. */
export interface MemoryIdentityMapOptions {
  /** Maximum number of BSUID → phone links kept (least recently used evicted). Default 10 000. */
  maxEntries?: number
  /** Links to preload, e.g. read from your database at startup. */
  entries?: Iterable<readonly [bsuid: string, phone: string]>
}

const BSUID_RE = /^[A-Za-z]{2}(?:\.[A-Za-z0-9]{1,128}){1,3}$/

/**
 * Whether `id` looks like a WhatsApp business-scoped user id: an ISO 3166
 * alpha-2 country code, a period and up to 128 alphanumerics
 * (`US.13491208655302741918`), or a parent BSUID (`US.ENT.11815799212886844830`).
 * Phone numbers (digits, optional `+`) never match.
 */
export function isBsuid(id: string): boolean {
  return BSUID_RE.test(id)
}

/** Insertion-ordered Map used as a bounded LRU. */
class LruMap<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly max: number) {}

  get size(): number { return this.map.size }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }
}

/**
 * Default {@link IdentityMap}: a bounded, synchronous, in-memory LRU. Learned
 * links are lost on restart; pass your own `identityMap` to persist them.
 */
export class MemoryIdentityMap implements IdentityMap {
  private readonly lru: LruMap<string, string>

  constructor(options: MemoryIdentityMapOptions = {}) {
    const max = options.maxEntries ?? 10_000
    this.lru = new LruMap(Number.isFinite(max) && max >= 1 ? Math.floor(max) : 10_000)
    for (const [bsuid, phone] of options.entries ?? []) this.lru.set(bsuid, phone)
  }

  /** Number of links currently held. */
  get size(): number { return this.lru.size }

  get(bsuid: string): string | undefined {
    return this.lru.get(bsuid)
  }

  set(bsuid: string, phone: string): void {
    this.lru.set(bsuid, phone)
  }
}

/* ==========================================================================
 * Internal resolver (not part of the public API)
 * ======================================================================== */

/** Minimal logger surface the resolver needs (pino-compatible). */
export interface IdentityLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
  debug(obj: object, msg?: string): void
}

/** The identifiers a webhook carries for one human (all optional). */
export interface Party {
  /** wa_id / `from` / `recipient_id` — omitted for many username users. */
  phone?: string
  /** `from_user_id` / `contacts[].user_id` / `recipient_user_id`. */
  bsuid?: string
  /** `from_parent_user_id` / `contacts[].parent_user_id` / `recipient_parent_user_id`. */
  parentBsuid?: string
  /** `contacts[].profile.username`, when the user enabled one. */
  username?: string
  /** `contacts[].profile.name`. */
  displayName?: string
}

/** A party resolved to its canonical id; `phone` includes a learned phone. */
export interface ResolvedParty extends Party {
  id: string
}

interface Pin {
  /** The id this session emitted for the identifier. */
  id: string
  /** For BSUID pins: the phone this session knows for it (dedupes map writes). */
  phone?: string
}

export function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/**
 * Chain on a MaybePromise without forcing the synchronous path to go async.
 * (Never name a module export `then`: it would make the ESM namespace a thenable.)
 */
export function andThen<T, U>(value: MaybePromise<T>, next: (v: T) => MaybePromise<U>): MaybePromise<U> {
  return isPromiseLike(value) ? value.then(next) : next(value)
}

/** Run `step` over `items` in order; stays synchronous until a step returns a promise. */
export function runInOrder<T>(items: readonly T[], step: (item: T) => MaybePromise<void>, from = 0): MaybePromise<void> {
  for (let i = from; i < items.length; i++) {
    const result = step(items[i])
    if (isPromiseLike(result)) return result.then(() => runInOrder(items, step, i + 1))
  }
}

const B = 'b:'
const P = 'p:'

/** Session pins kept by default (two to three per active user). */
const DEFAULT_MAX_PINS = 50_000

/**
 * Resolves webhook parties to stable canonical ids. One instance per provider
 * (the "session"); pins are in-memory and bounded, learned pairs go to the
 * {@link IdentityMap}.
 */
export class IdentityResolver {
  private readonly pins: LruMap<string, Pin>

  constructor(
    private readonly map: IdentityMap,
    private readonly logger: IdentityLogger,
    maxPins = DEFAULT_MAX_PINS,
  ) {
    this.pins = new LruMap(maxPins)
  }

  /**
   * Record an outbound target so receipts and replies for it resolve to the
   * same chat id the host used, even if Meta later reveals the phone number.
   */
  noteOutbound(chatId: string): void {
    if (!isBsuid(chatId)) return
    if (this.pins.get(B + chatId) === undefined) this.pins.set(B + chatId, { id: chatId })
  }

  /** Resolve a party to its canonical id (undefined when it carries no usable id). */
  resolve(party: Party): MaybePromise<ResolvedParty | undefined> {
    const { phone, bsuid, parentBsuid } = party
    const pinned =
      (bsuid !== undefined ? this.pins.get(B + bsuid) : undefined) ??
      (parentBsuid !== undefined ? this.pins.get(B + parentBsuid) : undefined) ??
      (phone !== undefined ? this.pins.get(P + phone) : undefined)
    if (pinned) {
      const known = bsuid !== undefined ? this.pins.get(B + bsuid)?.phone : undefined
      return this.commit(party, pinned.id, phone ?? known)
    }
    if (phone !== undefined) return this.commit(party, phone, phone)

    const key = bsuid ?? parentBsuid
    if (key === undefined) return undefined
    let stored: MaybePromise<string | undefined>
    try {
      stored = this.map.get(key)
    } catch (err) {
      return this.lookupFailed(party, key, err)
    }
    const onStored = (value: string | undefined): ResolvedParty => {
      const learned = asPhone(value)
      return this.commit(party, learned ?? key, learned)
    }
    return isPromiseLike(stored)
      ? stored.then(onStored, (err: unknown) => this.lookupFailed(party, key, err))
      : onStored(stored)
  }

  /** Learn a phone ↔ BSUID pair seen outside a resolvable event (e.g. a lone contact). */
  learn(party: Party): void {
    const { phone, bsuid } = party
    if (phone === undefined || bsuid === undefined) return
    const pin = this.pins.get(B + bsuid)
    if (pin?.phone === phone) return
    if (pin) pin.phone = phone
    this.persist(bsuid, phone)
  }

  /**
   * Identity change (new BSUID / new phone number): the `next` identifiers join
   * the session id of `previous`, so an in-flight conversation is not split.
   */
  alias(previous: Party, next: Party): MaybePromise<void> {
    return andThen(this.resolve(previous), (resolved) => {
      if (!resolved) return
      if (next.bsuid !== undefined) this.pins.set(B + next.bsuid, { id: resolved.id, phone: next.phone })
      if (next.parentBsuid !== undefined) this.pins.set(B + next.parentBsuid, { id: resolved.id })
      if (next.phone !== undefined) this.pins.set(P + next.phone, { id: resolved.id })
      if (next.bsuid !== undefined && next.phone !== undefined) this.persist(next.bsuid, next.phone)
    })
  }

  private commit(party: Party, id: string, phone: string | undefined): ResolvedParty {
    const { bsuid, parentBsuid } = party
    if (bsuid !== undefined) {
      const previous = this.pins.get(B + bsuid)
      // Persist only pairs seen in THIS webhook that the session hasn't written yet.
      if (party.phone !== undefined && previous?.phone !== party.phone) this.persist(bsuid, party.phone)
      this.pins.set(B + bsuid, { id, phone: phone ?? previous?.phone })
    }
    if (parentBsuid !== undefined) this.pins.set(B + parentBsuid, { id })
    if (party.phone !== undefined) this.pins.set(P + party.phone, { id })
    return { ...party, id, ...(phone !== undefined ? { phone } : {}) }
  }

  private lookupFailed(party: Party, key: string, err: unknown): ResolvedParty {
    this.logger.error({ err }, 'Cloud API identity map lookup failed; falling back to the BSUID')
    return this.commit(party, key, undefined)
  }

  private persist(bsuid: string, phone: string): void {
    const onError = (err: unknown): void => {
      this.logger.error({ err }, 'Cloud API identity map write failed')
    }
    try {
      const result = this.map.set(bsuid, phone)
      if (isPromiseLike(result)) result.then(undefined, onError)
    } catch (err) {
      onError(err)
    }
  }
}

/** A usable phone (wa_id) value: a non-empty token that is not a BSUID. */
export function asPhone(value: unknown): string | undefined {
  const id = asToken(value)
  return id !== undefined && !isBsuid(id) ? id : undefined
}

/** A usable BSUID / parent BSUID value. */
export function asBsuid(value: unknown): string | undefined {
  const id = asToken(value)
  return id !== undefined && isBsuid(id) ? id : undefined
}

/** A non-empty string id without whitespace (anything else is malformed). */
function asToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > 256 || /\s/.test(value)) return undefined
  return value
}
