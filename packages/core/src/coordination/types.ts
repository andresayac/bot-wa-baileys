/**
 * Multi-replica coordination contract (opt-in, `BotConfig.coordination`).
 *
 * A {@link Coordinator} lets several processes ("replicas") run the same bot against
 * one shared backend without stepping on each other:
 *
 * - **Chat turns.** Every inbound message reserves a {@link Ticket} in its conversation
 *   key's cross-replica FIFO at ingress, then waits for its {@link ChatTurn}. Only one
 *   replica holds a key's turn at a time, and turns are granted in ticket order, so a
 *   chat is processed strictly in order and never concurrently, whichever replica
 *   received each message.
 * - **Leadership.** A named, renewed lease ({@link Leadership}) for singletons: the
 *   provider session of a transport that allows one connection only (Baileys), or a
 *   singleton job.
 *
 * Keys are opaque strings (the conversation runtime's `keyFor`): the coordinator never
 * parses them. Backends live outside the core: {@link MemoryCoordinator} (one process,
 * reference implementation) here, `RedisCoordinator` in `@bot-wa/redis-store`.
 */

/** Strictly increasing number per key (a ticket's sequence, a leadership term). Usable as a fencing token. */
export type Fence = number

/** Why a turn or a leadership ended without its holder releasing it. */
export type LeaseLossReason = 'expired' | 'superseded' | 'coordinator-down' | 'stopped'

/** A lease as reported by {@link CoordinatorEvents}. */
export interface LeaseInfo {
  key: string
  holder: string
  fence: Fence
}

/**
 * Thrown when work runs under a turn or leadership that is no longer held: the lease
 * expired (pause, partition), another replica superseded it, the coordinator became
 * unreachable, or it was stopped. Sends from a chat whose turn was lost reject with it
 * instead of reaching the transport out of order.
 */
export class LeaseLostError extends Error {
  constructor(
    readonly key: string,
    readonly fence: Fence,
    readonly reason: LeaseLossReason,
  ) {
    super(`Lease lost on "${key}" (fence ${fence}): ${reason}`)
    this.name = 'LeaseLostError'
  }
}

/**
 * The coordinator could not grant a turn: the backend is unreachable, or the turn did
 * not come within `coordination.turnWaitMs`. The message is dropped unprocessed (its
 * dedupe key is released, so a transport redelivery is processed) and this error is
 * reported through the bot's `'error'` event.
 */
export class CoordinationUnavailableError extends Error {
  constructor(
    readonly key: string,
    readonly reason: 'timeout' | 'unavailable',
    options?: { cause?: unknown },
  ) {
    super(`Coordination unavailable for "${key}": ${reason}`, options)
    this.name = 'CoordinationUnavailableError'
  }
}

/** A reserved place in one key's cross-replica FIFO (see {@link Coordinator.reserve}). */
export interface Ticket {
  readonly key: string
  /** Position in the key's FIFO; becomes the turn's {@link ChatTurn.fence}. */
  readonly seq: number
  /** Give the place up without running (idempotent). Later tickets are not blocked by it. */
  cancel(): Promise<void>
}

/** A granted per-key turn. The holder may run the key's work until {@link release} or until {@link signal} aborts. */
export interface ChatTurn {
  readonly key: string
  readonly fence: Fence
  /**
   * Replica that held the previous turn of this key, `null` when unknown (first turn,
   * or the key's history expired). When it is not this replica, any in-memory state
   * this replica kept for the key (a waiting conversation) may be stale.
   */
  readonly previousHolder: string | null
  /** Aborts (with a {@link LeaseLostError} reason) when the turn is lost before release. */
  readonly signal: AbortSignal
  /** Throws {@link LeaseLostError} when the turn was lost (cheap local check). */
  assertHeld(): void
  /** Hand the key to the next ticket (idempotent). */
  release(): Promise<void>
}

/** A renewed lease on a named singleton (see {@link Coordinator.lead}). */
export interface Leadership {
  readonly name: string
  /** Term number: strictly increasing every time the leadership changes hands. */
  readonly fence: Fence
  /** Aborts once the leadership is lost (expired, coordinator unreachable, stopped). */
  readonly signal: AbortSignal
  /** Step down (idempotent). */
  release(): Promise<void>
}

/** Events a {@link Coordinator} reports. */
export interface CoordinatorEvents {
  'lease-lost': LeaseInfo & { reason: LeaseLossReason }
  leader: { name: string; fence: Fence }
  follower: { name: string }
}

/** Options of {@link Coordinator.acquireTurn}. */
export interface AcquireTurnOptions {
  /** Give up (reject with an `AbortError`-like reason) when aborted. */
  signal?: AbortSignal
  /** Give up after this long, rejecting with {@link CoordinationUnavailableError} (`'timeout'`). Omitted: wait forever. */
  maxWaitMs?: number
}

/**
 * Cross-replica coordination backend. One instance per replica (per `Bot`); the bot
 * calls {@link start} when it starts and {@link stop} when it stops.
 */
export interface Coordinator {
  /** This replica's id; unique among the replicas sharing the backend. */
  readonly replicaId: string
  /** Begin heartbeating/renewing (idempotent). */
  start(): Promise<void>
  /** Release every turn and leadership this replica holds and stop renewing (idempotent). */
  stop(): Promise<void>
  /** Reserve a place in `key`'s cross-replica FIFO. The bot calls it in ingress order. */
  reserve(key: string): Promise<Ticket>
  /**
   * Wait until it is `ticket`'s turn (tickets of replicas that died are skipped), then
   * hold the key. Rejects with {@link LeaseLostError} (`'superseded'`) when the ticket was
   * skipped because this replica was presumed dead, and with
   * {@link CoordinationUnavailableError} on timeout or backend failure.
   */
  acquireTurn(ticket: Ticket, opts?: AcquireTurnOptions): Promise<ChatTurn>
  /** Campaign for `name` until elected (or `opts.signal` aborts, rejecting). */
  lead(name: string, opts?: { signal?: AbortSignal }): Promise<Leadership>
  /** One election attempt: the leadership, or `null` when another replica leads. */
  tryLead(name: string): Promise<Leadership | null>
  /** Subscribe to coordinator events; returns an unsubscribe. */
  on<E extends keyof CoordinatorEvents>(event: E, listener: (payload: CoordinatorEvents[E]) => void): () => void
}

/**
 * `BotConfig.coordination`: run this bot as one of N replicas. Omit it for a single
 * process (the default; nothing below runs).
 */
export interface CoordinationConfig {
  /** The backend shared by the replicas (`RedisCoordinator`, or `MemoryCoordinator` for one process). */
  coordinator: Coordinator
  /**
   * Longest a message waits for its chat's turn: a duration (`'2m'`) or ms. When it
   * runs out the message is dropped and reported as a {@link CoordinationUnavailableError}
   * (`'timeout'`). Default `'2m'`.
   */
  turnWaitMs?: string | number
  /**
   * Longest the chat's turn stays held after the handler returned, waiting for a
   * conversation step it fed (an answered `c.ask`, a `c.goto()` target) to reach its next
   * wait or end, so no other replica processes the chat meanwhile. A step still running
   * then (a slow `.do()`, a long `c.sleep` or delay) is stopped, keeping its checkpoint,
   * before the turn is released: a persistent flow re-runs that step on the chat's next
   * message. Set it above your longest step. Default `'1m'`.
   */
  settleMs?: string | number
  /**
   * With `providerSession: 'leader'`: how long the leader's transport may stay
   * `'closed'` (logged out, session taken over, reconnect given up) before the replica
   * steps down so a standby connects instead. Default `'1m'`.
   */
  providerDownMs?: string | number
  /**
   * Who connects the transport:
   * - `'leader'` — only the replica holding the `provider:<id>` leadership starts the
   *   provider; the others stand by and take over when it is lost;
   * - `'shared'` — every replica starts it (webhook transports, each replica receives
   *   part of the traffic);
   * - `'auto'` (default) — `'leader'` when `provider.capabilities.exclusiveSession`,
   *   else `'shared'`.
   */
  providerSession?: 'leader' | 'shared' | 'auto'
}
