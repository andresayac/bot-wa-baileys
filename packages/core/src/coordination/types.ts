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
 * reference implementation) here, `RedisCoordinator` in `@botmesh/redis-store`.
 */
import type { CheckpointTrace } from '../telemetry/w3c.js'

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
  /**
   * What happens to a chat's live conversation when another replica takes the chat (the
   * replica holding it crashed, was stopped for a deploy, or lost its turn). Default
   * `{ flows: 'drop', fallback: 'drop' }`: only `.persistent()` flows continue there.
   */
  handover?: ConversationHandoverConfig
}

/** `coordination.handover`: conversation hand-over between replicas. */
export interface ConversationHandoverConfig {
  /**
   * DSL flows WITHOUT `.persistent()`: `'forward'` keeps a TTL-bound ("ephemeral")
   * checkpoint of them, one write per step, so the replica that takes the chat — or this
   * one after a rolling restart within the TTL — continues the flow. Needs plain-JSON
   * `c.state`; a flow whose state is not plain JSON is handled by {@link fallback}.
   * `'drop'` (default): they live in memory only.
   */
  flows?: 'forward' | 'drop'
  /**
   * Conversations that cannot be forwarded (async `bot.conversation` functions, flows not
   * forwarded, a forwarded flow whose definition changed on the new replica):
   * - `'notify'`: the replica that takes the chat tells the user the conversation was
   *   interrupted (it consumes the waking message);
   * - `'restart'`: it re-enters the conversation by name, from the beginning, with its
   *   initial state (side effects before its first wait run again); falls back to `'notify'`
   *   when the name is not registered there;
   * - `'drop'` (default): today's behaviour — the waking message routes normally;
   * - a function: a custom migration; resolve `true` when it consumed the waking message.
   *
   * Costs two store writes per such conversation (a stub when it first waits, its clear at the end).
   */
  fallback?: 'notify' | 'restart' | 'drop' | HandoverFallback
  /** `'notify'` text. Default: the localized built-in `CORE_MESSAGES.conversationInterrupted`. */
  notifyMessage?: string
  /**
   * How long an ephemeral checkpoint stays resumable after its last write (stubs: twice
   * that), as a duration (`'10m'`) or ms. Default: `conversation.timeout`, else `'5m'`. While
   * the conversation waits, never shorter than that wait's explicit timeout (`ask({ timeout })`,
   * `flow().timeout()`); refreshed at every wait.
   */
  ttl?: string | number
  /**
   * Durability off: the largest encoded answer (bytes) embedded in a checkpoint so a step cut
   * short mid-way can be continued with it (with durability the journal holds it instead).
   * Default `16_384`; `0` never embeds one.
   */
  maxAnswerBytes?: number
}

/**
 * A custom {@link ConversationHandoverConfig.fallback}: `ctx` is the waking message's context
 * (a `MessageContext` in a Bot). Resolve `true` when it consumed the message.
 */
export type HandoverFallback = (info: InterruptedConversation, ctx: HandoverContext) => boolean | Promise<boolean>

/** The minimal context a {@link HandoverFallback} receives (in a Bot it is the full `MessageContext`). */
export interface HandoverContext {
  from: string
  sender: string
  body: string
  type: string
  isGroup: boolean
  reply(text: string): Promise<unknown>
}

/** A conversation the replica that took the chat could not continue (see {@link HandoverFallback}). */
export interface InterruptedConversation {
  /** Conversation (or flow) name. */
  name: string
  /** Conversation key (chat id, or `chatId:senderId` per group participant). */
  key: string
  /** `'unforwardable'`: it kept no checkpoint; `'changed'`: a forwarded flow changed on this replica. */
  reason: 'unforwardable' | 'changed'
  /** When it started on the previous replica (epoch ms), when known. */
  startedAt?: number
  /** Its initial `c.state`, when that was plain JSON. */
  startState?: Record<string, unknown>
  /**
   * Tracing (`BotConfig.telemetry`): W3C trace context of its last turn on the previous
   * replica, to link a migrated conversation's spans to it (`'restart'` does it itself).
   */
  trace?: CheckpointTrace
}

/** Payload of the `'coordination:handover'` bot event. */
export interface ConversationHandoverEvent {
  key: string
  name: string
  /**
   * `'resumed'` a forwarded flow continued; `'notified'` / `'restarted'` / `'migrated'` the
   * fallback ran; `'dropped'` nothing was done (the message routed normally); `'expired'`
   * the entry outlived its TTL; `'changed'` a forwarded flow changed and was dropped.
   */
  outcome: 'resumed' | 'notified' | 'restarted' | 'migrated' | 'dropped' | 'expired' | 'changed'
}
