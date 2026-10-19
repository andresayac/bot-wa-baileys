import { ProviderError } from '../core/provider.js'

/**
 * A journal completion (`ack`, `fail`, `markSent`, …) presented a fencing token that is
 * not the record's current claim: the lease expired and someone else re-claimed the
 * record, or it already left the leased state. The stale holder must drop its result.
 */
export class StaleLeaseError extends Error {
  constructor(
    /** Inbox record id or outbox key. */
    readonly id: string,
    /** The token that was presented. */
    readonly fencingToken: number,
    /** The record's current token (`-1` when the record does not exist). */
    readonly currentToken: number,
    /** The record's current state (`'missing'` when it does not exist). */
    readonly state: string,
  ) {
    super(`Stale lease for ${id}: token ${fencingToken} (current ${currentToken}, state ${state})`)
    this.name = 'StaleLeaseError'
  }
}

/**
 * A durable send could not go out within `durability.outbox.inlineMaxMs`. It is NOT lost:
 * the outbox keeps it and the background sweeper keeps retrying it (see `key`). Callers
 * that must know the final outcome enqueue with `bot.enqueue()` and watch
 * `bot.durability.outbox.get(key)` / the `'durability:dead'` event instead.
 */
export class SendDeferredError extends ProviderError {
  constructor(
    /** The outbox key of the deferred send. */
    readonly key: string,
    /** The error of the last attempt. */
    readonly lastError?: unknown,
  ) {
    super(`Send ${key} deferred to the background outbox sweeper`)
    this.name = 'SendDeferredError'
  }
}
