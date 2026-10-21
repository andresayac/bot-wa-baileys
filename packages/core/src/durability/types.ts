/**
 * Durable message processing — public contract (opt-in, `BotConfig.durability`).
 *
 * Two journals back it:
 *  - the **inbox** records every admitted inbound message/interaction BEFORE it is
 *    dispatched and acknowledges it only once its effects settled, so a crash
 *    replays it on restart;
 *  - the **outbox** records every send under an idempotency key BEFORE the
 *    provider is called and stores the provider message id once it is sent, so a
 *    replay (or a retry) never sends the same message twice.
 *
 * Both journals use leases with fencing tokens: a claim bumps the record's
 * `fencingToken`, and every completion (`ack`, `fail`, `markSent`, …) must present
 * the token of the claim it completes, otherwise it is rejected with
 * {@link StaleLeaseError}. A token is never reused, not even after an operator replay.
 *
 * Backends implement {@link DurabilityBackend}. Core ships `MemoryDurability`
 * (default; the reference implementation, lost on a crash) and `FileDurability`
 * (single process); `@botmesh/postgres-store` and `@botmesh/redis-store` ship shared
 * backends. Every backend passes the shared conformance suite
 * (`test-utils/durability-conformance.ts`).
 */

import type { MessageRef } from '../core/provider.js'

import type { JsonValue } from '../testing/transcripts/format.js'

/** A JSON-safe value (what the journals persist). Same type as the transcript `JsonValue`. */
export type { JsonValue }

/* ============================================================================
 * Inbox
 * ========================================================================== */

/**
 * Lifecycle of an inbound record:
 * `pending` → (claim) `processing` → `done` (ack) | `failed` (retry later) | `dead` (gave up) |
 * `pending` (release, not charged). An expired `processing` lease is claimable again.
 */
export type InboxState = 'pending' | 'processing' | 'failed' | 'done' | 'dead'

/** One journaled inbound event. */
export interface InboxRecord {
  /** Stable id: a hash of the namespace + the event's idempotency key, or a random id for events without one. */
  id: string
  /** The inbound dedupe key + content fingerprint the id was derived from (diagnostics). */
  idempotencyKey?: string
  /** Ordering partition (namespace + chat): records of one partition are replayed in `receivedAt` order. */
  partitionKey: string
  kind: 'message' | 'interaction'
  /** The serialized inbound event (`raw` is never stored). */
  payload: JsonValue
  state: InboxState
  /** Claims charged so far (a `release` is not charged). */
  attempts: number
  /** Epoch ms when a `pending`/`failed` record becomes due. */
  nextAttemptAt: number
  /** Epoch ms when the current `processing` lease expires. */
  leaseUntil?: number
  /** Lease owner (`DurabilityConfig.instanceId`). */
  owner?: string
  /** Strictly increasing per record; `0` before the first claim. */
  fencingToken: number
  receivedAt: number
  completedAt?: number
  lastError?: string
}

/** Fields the caller provides to {@link InboxJournal.append}. */
export type InboxAppend = Pick<InboxRecord, 'id' | 'partitionKey' | 'kind' | 'payload' | 'receivedAt'> & {
  idempotencyKey?: string
}

/** Lease parameters of a claim. */
export interface LeaseOptions {
  /** Who takes the lease. */
  owner: string
  /** Lease duration in ms. */
  leaseMs: number
  /** Current time (epoch ms). */
  now: number
}

/** Options of {@link InboxJournal.claim} / {@link OutboxJournal.claimDue}. */
export interface ClaimOptions extends LeaseOptions {
  /** Max records to claim. */
  limit: number
  /**
   * Also take records leased by `owner` itself whose lease has not expired yet: a
   * restarted process with a stable `instanceId` reclaims what its previous
   * incarnation left in flight, without waiting for the lease to expire.
   */
  reclaimOwn?: boolean
  /** Only claim records whose partition (inbox) or chat (outbox) passes this filter (multi-replica ownership). */
  partitions?: (key: string) => boolean
}

/** Persistence contract of the inbound journal. */
export interface InboxJournal {
  /**
   * Insert-if-absent by `id`. `'duplicate'` means the id is already known (any state);
   * the existing record is returned unchanged. With `lease`, a new record is created
   * already claimed (`processing`, token 1, 1 attempt), so no other claimer can take it
   * between the append and the claim.
   */
  append(record: InboxAppend, now: number, lease?: LeaseOptions): Promise<{ status: 'appended' | 'duplicate'; record: InboxRecord }>
  /**
   * Lease due records: `pending`/`failed` whose `nextAttemptAt <= now`, plus `processing`
   * records whose lease expired. Oldest `receivedAt` first. Each claimed record comes back
   * `processing` with a fresh `fencingToken` and `attempts + 1`.
   */
  claim(options: ClaimOptions): Promise<InboxRecord[]>
  /** Lease one specific record when it is claimable (as {@link claim}); `null` when it is not. */
  claimOne(id: string, options: LeaseOptions): Promise<InboxRecord | null>
  /** `processing` → `done`. @throws {StaleLeaseError} when `token` is not the current claim. */
  ack(id: string, token: number, now: number): Promise<void>
  /**
   * `processing` → `failed` (due at `retryAt`, default now) or `dead` (`dead: true`).
   * @throws {StaleLeaseError}
   */
  fail(id: string, token: number, error: string, options: { now: number; retryAt?: number; dead?: boolean }): Promise<void>
  /** `processing` → `pending`, due now; the claim's attempt is not charged. @throws {StaleLeaseError} */
  release(id: string, token: number, now: number): Promise<void>
  /** Extend the current lease (heartbeat). @throws {StaleLeaseError} */
  extend(id: string, token: number, leaseUntil: number): Promise<void>
  /** Operator replay: any record → `pending`, due now, attempts reset. No-op for an unknown id. */
  replay(id: string, now: number): Promise<void>
  get(id: string): Promise<InboxRecord | undefined>
  /** Records, optionally by state, oldest `receivedAt` first. */
  list(filter?: { state?: InboxState; limit?: number }): Promise<InboxRecord[]>
  /** Delete `done` records completed before `doneBefore` (and `dead` ones when `includeDead`). Returns the count. */
  purge(options: { doneBefore: number; includeDead?: boolean }): Promise<number>
}

/* ============================================================================
 * Outbox
 * ========================================================================== */

/**
 * Lifecycle of an outbound record:
 * `pending` → (begin/claim) `sending` → `sent` (provider id recorded) | `failed` (retry later) |
 * `dead` (gave up). A `sending` record whose lease expired is AMBIGUOUS — the process died
 * between calling the provider and recording the outcome; it becomes `unknown` (policy
 * `'skip'`) or is sent again (`'resend'`).
 */
export type OutboxState = 'pending' | 'sending' | 'sent' | 'failed' | 'dead' | 'unknown'

/** Error summary stored on a failed outbound record. */
export interface OutboxError {
  name?: string
  code?: string | number
  message?: string
}

/** One journaled outbound send. */
export interface OutboxRecord {
  /** Idempotency key: explicit, derived from the inbound being handled, or random. */
  key: string
  chatId: string
  /** The inbound record (or job) whose handling produced this send. */
  causationId?: string
  op: 'send'
  /** Encoded `OutboundContent` (Buffers base64-encoded). */
  content: JsonValue
  /** Encoded `SendOptions` (without `idempotencyKey`). */
  options?: JsonValue
  state: OutboxState
  /** Provider attempts so far. */
  attempts: number
  nextAttemptAt: number
  leaseUntil?: number
  owner?: string
  fencingToken: number
  /** The provider's message ref, written by the same operation that sets `sent`. */
  result?: { ref: MessageRef }
  /**
   * Hash of the chat + encoded content the record was journaled with (before `before('send')`
   * hooks). A replay whose derived key matches but whose content differs is a new send.
   */
  fingerprint?: string
  createdAt: number
  sentAt?: number
  /** When the record reached a terminal state (`sent`, `dead`, `unknown`). */
  completedAt?: number
  lastError?: OutboxError
}

/** Fields the caller provides to {@link OutboxJournal.put}. */
export type OutboxPut = Pick<OutboxRecord, 'key' | 'chatId' | 'content' | 'createdAt'> & {
  causationId?: string
  options?: JsonValue
  fingerprint?: string
}

/** A record returned by {@link OutboxJournal.claimDue}. */
export interface ClaimedSend {
  record: OutboxRecord
  /** The record was `sending` under an expired lease: the outcome of its last attempt is unknown. */
  ambiguous: boolean
}

/** Persistence contract of the outbound journal. */
export interface OutboxJournal {
  /**
   * Insert-if-absent by `key`; on conflict the existing record is returned unchanged (`'exists'`).
   * With `lease`, a new record is created already begun (`sending`, token 1, 1 attempt).
   */
  put(record: OutboxPut, now: number, lease?: LeaseOptions): Promise<{ status: 'created' | 'exists'; record: OutboxRecord }>
  /**
   * `pending`/`failed` (due or not) → `sending` under a fresh token: the persisted
   * "about to call the provider" marker. `null` when the record is missing or in another state.
   */
  begin(key: string, options: LeaseOptions): Promise<OutboxRecord | null>
  /** `sending` → `sent` with the provider ref. @throws {StaleLeaseError} */
  markSent(key: string, token: number, result: { ref: MessageRef }, now: number): Promise<void>
  /** Extend the lease of a `sending` record (heartbeat while the provider call runs). @throws {StaleLeaseError} */
  extend(key: string, token: number, leaseUntil: number): Promise<void>
  /** `sending` → `failed` (due at `retryAt`) or `dead`. @throws {StaleLeaseError} */
  markFailed(key: string, token: number, error: OutboxError, options: { now: number; retryAt?: number; dead?: boolean }): Promise<void>
  /**
   * Lease due `pending`/`failed` records and `sending` records whose lease expired
   * (returned with `ambiguous: true`), oldest `createdAt` first. Claimed records come back
   * `sending` under a fresh token.
   */
  claimDue(options: ClaimOptions): Promise<ClaimedSend[]>
  /** Settle an ambiguous claim: `'unknown'` (terminal) or `'pending'` (send again). @throws {StaleLeaseError} */
  resolveAmbiguous(key: string, token: number, to: 'unknown' | 'pending', now: number): Promise<void>
  get(key: string): Promise<OutboxRecord | undefined>
  /** Records, optionally by state and chat, oldest `createdAt` first. */
  list(filter?: { state?: OutboxState; chatId?: string; limit?: number }): Promise<OutboxRecord[]>
  /** Operator retry: `failed`/`dead`/`unknown` → `pending`, due now. */
  retry(key: string, now: number): Promise<void>
  /** Operator discard: delete the record (a later send with the same key goes out again). */
  discard(key: string): Promise<void>
  /** Delete terminal records completed before `before`. Returns the count. */
  purge(options: { before: number }): Promise<number>
}

/* ============================================================================
 * Backend + configuration
 * ========================================================================== */

/** A durability backend: the two journals plus optional lifecycle. */
export interface DurabilityBackend {
  readonly inbox: InboxJournal
  readonly outbox: OutboxJournal
  /**
   * `true` when only one process can use the backend at a time (memory, file). A restarted
   * process then knows every lease of its `instanceId` is its own dead incarnation's.
   */
  readonly exclusive?: boolean
  /**
   * A view of the same storage holding only the records of `name`. The bot opens the view
   * of its namespace (tenant, environment, bot, connection), so several bots can share one
   * backend: each claims, replays and deduplicates only its own records, and explicit
   * idempotency keys are per bot. A backend without `scope` must not be shared between bots.
   */
  scope?(name: string): DurabilityBackend
  /** Called by `bot.start()` before anything is replayed. */
  start?(): Promise<void>
  /** Called by `bot.stop()` after the provider stopped. */
  stop?(): Promise<void>
}

/**
 * Retry delay policy: a function of the 1-based attempt that just failed, or the
 * parameters of capped exponential backoff with jitter
 * (`min(capMs, baseMs * 2^(attempt-1))`, then ± `jitter` fraction).
 */
export type RetryBackoff = ((attempt: number) => number) | { baseMs?: number; capMs?: number; jitter?: number }

/** `BotConfig.durability`. Every field is optional; `{}` enables durability with the in-memory backend. */
export interface DurabilityConfig {
  /** The backend. Default: a new `MemoryDurability` (survives nothing but redeliveries within the process). */
  journal?: DurabilityBackend
  /**
   * Lease owner of this process. Keep it STABLE across restarts of the same deployment
   * (a restarted process then reclaims its own in-flight records at once, without waiting
   * for their leases to expire) and UNIQUE per concurrently running replica (two live
   * processes with one id would take each other's leases).
   *
   * Default: `<hostname>/<botId>/<connectionId>` on a single-process backend (memory, file);
   * on a shared backend (Postgres, Redis) that id plus a per-boot suffix, so two processes
   * on one host never share it — a restart then waits for the old leases to expire.
   */
  instanceId?: string
  /**
   * `false` (default): when the journal cannot record an inbound event, the event is NOT
   * dispatched (fail-closed) — an `'error'` is emitted and the dedupe key is released so
   * a transport redelivery is processed. `true`: dispatch it without the journal.
   */
  failOpen?: boolean
  inbox?: {
    /** Processing lease (heartbeat-extended while the event is running). Default `60_000` ms. */
    leaseMs?: number | string
    /** Attempts before an event whose processing keeps failing is dead-lettered. Default `5`. */
    maxAttempts?: number
    /** Backoff between failed attempts. Default `{ baseMs: 1000, capMs: 60000, jitter: 0.2 }`. */
    backoff?: RetryBackoff
    /**
     * Journal a serializable reference to each message's media (`IProvider.serializeMediaRef`)
     * so a replayed message (crash recovery, background retry) can still download it
     * (`IProvider.rehydrateMediaRef`). Only applies to providers with those hooks. The
     * reference grants access to the media, like the message body stored next to it.
     * `false`: journal media tokens as they are, as before (a replayed message may then be
     * unable to download its media). Default `true`.
     */
    mediaRefs?: boolean
  }
  outbox?: {
    /** Retries after the first attempt before a send is dead-lettered. Default `5`. */
    retries?: number
    /** Backoff between attempts (a `RateLimitedError` waits at least its `retryAfterMs`). Default as `inbox.backoff`. */
    backoff?: RetryBackoff
    /**
     * How long a `ctx.reply` / `bot.send` keeps retrying inline before it rejects with
     * `SendDeferredError` and leaves the send to the background sweeper. Default `'15s'`.
     */
    inlineMaxMs?: number | string
    /**
     * A send whose outcome is unknown after a crash (the provider was called, the result
     * was never recorded): `'skip'` (default) marks it `unknown` — possible loss, never a
     * duplicate; `'resend'` sends it again — never a loss, possible duplicate.
     */
    onAmbiguous?: 'skip' | 'resend'
    /** Encoded payloads above this size bypass the outbox (sent directly, with a warning). Default 1 MiB. */
    maxPayloadBytes?: number
    /** Lease of a send in flight (heartbeat-extended while the provider call runs). Default `60_000` ms. */
    leaseMs?: number | string
    /**
     * A replayed handler whose n-th send differs from the one recorded under the same derived
     * key (`<inboundId>:<n>`) took another path (e.g. a non-persistent flow lost on a crash):
     * `'send'` (default) sends the new content under a new key — never a lost reply;
     * `'skip'` answers it with the recorded ref, as if it were the same send. Explicit
     * `idempotencyKey`s are never compared: the caller names the send.
     */
    onDiverged?: 'send' | 'skip'
  }
  /** Background sweeper period (retries, expired leases). Default `1000` ms. */
  pollMs?: number | string
  /**
   * Keep `done`/`sent` records this long before the sweeper purges them. It bounds how long
   * a late transport redelivery is still recognised as a duplicate. Default `'7d'`; `0` disables purging.
   */
  retention?: number | string
}
