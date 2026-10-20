/**
 * Runtime metrics — in-process counters only the engine knows (conversations,
 * inbound/outbound traffic, gate drops, errors). Read with `bot.metrics()`;
 * export with {@link toPrometheus}. Counters are monotonic since the bot was
 * constructed (or since `bot.resetMetrics()`); nothing is persisted.
 */

import type { ConversationOutcome } from '../conversations/ConversationRuntime.js'

/** Per-outcome conversation counters (also used per flow). */
export interface ConversationCounters {
  started: number
  /** The function / flow returned (or `c.goto()`-ed elsewhere). */
  completed: number
  /** Ended with `c.end()`. */
  ended: number
  /** Stopped by a failed `.guard()` (farewell or `redirect`). */
  guarded: number
  cancelled: number
  timedOut: number
  retriesExceeded: number
  errored: number
  /** Mean duration of the conversations that ended (ms); `0` when none ended yet. */
  avgDurationMs: number
}

/** Snapshot returned by `bot.metrics()`. Plain JSON — safe to serialise. */
export interface BotMetricsSnapshot {
  /** Epoch ms of the last `start()`; `undefined` while the bot is not running. */
  startedAt?: number
  /** Ms since the last `start()`; `0` while the bot is not running. */
  uptimeMs: number
  /** Human uptime, e.g. `'3d 4h'`, `'5m 12s'`. */
  uptime: string
  conversations: ConversationCounters & {
    /** Conversations alive right now (running or waiting for a reply). */
    active: number
  }
  /** Per conversation/flow name. */
  flows: Record<string, ConversationCounters>
  messages: {
    /** Inbound messages/interactions accepted (after dedupe and access lists). */
    in: number
    /** Outbound sends the provider accepted. */
    out: number
    /** Outbound sends the provider rejected. */
    outFailed: number
  }
  dropped: {
    /** Redelivered inbound events dropped by `BotConfig.dedupe`. */
    duplicate: number
    /** Inbound dropped by the blacklist / whitelist. */
    blocked: number
    /** Inbound not routed because the chat is in human handoff. */
    handoff: number
    /** Echoes of the bot's own sends dropped by `BotConfig.echoFilter` (present only with the filter on). */
    echo?: number
  }
  /** `bot.trigger()` calls that started a conversation. */
  triggered: number
  /** Errors reported to the bot `'error'` channel. */
  errors: number
}

interface MutableCounters {
  started: number
  /** The function / flow returned (or `c.goto()`-ed elsewhere). */
  completed: number
  /** Ended with `c.end()`. */
  ended: number
  /** Stopped by a failed `.guard()` (farewell or `redirect`). */
  guarded: number
  cancelled: number
  timedOut: number
  retriesExceeded: number
  errored: number
  /** Every ended conversation, whatever the outcome (for the mean duration). */
  finished: number
  totalDurationMs: number
}

const emptyCounters = (): MutableCounters => ({
  started: 0, completed: 0, ended: 0, guarded: 0, cancelled: 0, timedOut: 0, retriesExceeded: 0, errored: 0, finished: 0, totalDurationMs: 0,
})

const OUTCOME_FIELD: Record<ConversationOutcome, 'completed' | 'ended' | 'guarded' | 'cancelled' | 'timedOut' | 'retriesExceeded' | 'errored'> = {
  completed: 'completed',
  ended: 'ended',
  guarded: 'guarded',
  cancelled: 'cancelled',
  timedOut: 'timedOut',
  retriesExceeded: 'retriesExceeded',
  error: 'errored',
}

/** Mutable counter set behind `bot.metrics()`. Internal to the Bot, exported for custom hosts/tests. */
export class MetricsCollector {
  private total = emptyCounters()
  private perFlow = new Map<string, MutableCounters>()
  private messagesIn = 0
  private messagesOut = 0
  private messagesOutFailed = 0
  private droppedDuplicate = 0
  private droppedBlocked = 0
  private droppedHandoff = 0
  private droppedEcho = 0
  /** `BotConfig.echoFilter` is on: the snapshot carries `dropped.echo` (set by the Bot). */
  trackEchoes = false
  private triggered = 0
  private errors = 0
  private startedAt?: number

  constructor(private now: () => number = Date.now) {}

  markStarted(): void { this.startedAt = this.now() }
  markStopped(): void { this.startedAt = undefined }

  conversationStarted(name: string): void {
    this.total.started++
    this.flow(name).started++
  }

  conversationEnded(name: string, outcome: ConversationOutcome, durationMs: number): void {
    for (const c of [this.total, this.flow(name)]) {
      c[OUTCOME_FIELD[outcome]]++
      c.finished++
      c.totalDurationMs += Math.max(0, durationMs)
    }
  }

  inbound(): void { this.messagesIn++ }
  outbound(ok: boolean): void { if (ok) this.messagesOut++; else this.messagesOutFailed++ }
  duplicateDropped(): void { this.droppedDuplicate++ }
  blockedDropped(): void { this.droppedBlocked++ }
  handoffDropped(): void { this.droppedHandoff++ }
  echoDropped(): void { this.droppedEcho++ }
  triggerStarted(): void { this.triggered++ }
  error(): void { this.errors++ }

  /** Zero every counter (uptime is kept). */
  reset(): void {
    this.total = emptyCounters()
    this.perFlow.clear()
    this.messagesIn = this.messagesOut = this.messagesOutFailed = 0
    this.droppedDuplicate = this.droppedBlocked = this.droppedHandoff = this.droppedEcho = 0
    this.triggered = this.errors = 0
  }

  snapshot(activeConversations: number): BotMetricsSnapshot {
    const uptimeMs = this.startedAt === undefined ? 0 : Math.max(0, this.now() - this.startedAt)
    const flows: Record<string, ConversationCounters> = {}
    for (const [name, c] of [...this.perFlow].sort(([a], [b]) => a.localeCompare(b))) flows[name] = publicCounters(c)
    return {
      startedAt: this.startedAt,
      uptimeMs,
      uptime: formatUptime(uptimeMs),
      conversations: { ...publicCounters(this.total), active: activeConversations },
      flows,
      messages: { in: this.messagesIn, out: this.messagesOut, outFailed: this.messagesOutFailed },
      dropped: {
        duplicate: this.droppedDuplicate, blocked: this.droppedBlocked, handoff: this.droppedHandoff,
        ...(this.trackEchoes || this.droppedEcho > 0 ? { echo: this.droppedEcho } : {}),
      },
      triggered: this.triggered,
      errors: this.errors,
    }
  }

  private flow(name: string): MutableCounters {
    let c = this.perFlow.get(name)
    if (!c) { c = emptyCounters(); this.perFlow.set(name, c) }
    return c
  }
}

function publicCounters(c: MutableCounters): ConversationCounters {
  return {
    started: c.started,
    completed: c.completed,
    ended: c.ended,
    guarded: c.guarded,
    cancelled: c.cancelled,
    timedOut: c.timedOut,
    retriesExceeded: c.retriesExceeded,
    errored: c.errored,
    avgDurationMs: c.finished === 0 ? 0 : Math.round(c.totalDurationMs / c.finished),
  }
}

/** `93_784_000` → `'1d 2h'`; the two most significant units, down to seconds (`'0s'` for < 1 s). */
export function formatUptime(ms: number): string {
  const units: Array<[string, number]> = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]]
  let rest = Math.max(0, Math.floor(ms))
  const parts: string[] = []
  for (const [label, size] of units) {
    const n = Math.floor(rest / size)
    rest -= n * size
    if (n > 0 || parts.length > 0) parts.push(`${n}${label}`)
    if (parts.length === 2) break
  }
  return parts.length ? parts.join(' ') : '0s'
}

/** Payload of the bot `'conversation:started'` event. */
export interface ConversationStartedEvent {
  /** Unique per conversation instance — matches a `'conversation:ended'` to its `'conversation:started'`. */
  id: string
  /** Conversation/flow name. */
  name: string
  chatId: string
  userId: string
  /** Runtime key (`chatId`, or `chatId:userId` per group participant). */
  key: string
}

/** Payload of the bot `'conversation:ended'` event. */
export interface ConversationEndedEvent extends ConversationStartedEvent {
  outcome: ConversationOutcome
  /** Shorthand for `outcome === 'completed'`. */
  completed: boolean
  durationMs: number
  /** Target of the `c.goto()` that ended it, if any (a new `'conversation:started'` follows). */
  goto?: string
}
