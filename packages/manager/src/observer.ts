/**
 * Per-bot observation: connection / QR state and counters for the metrics
 * endpoint. Attaches to any bot exposing an EventEmitter-like `on`/`off`
 * (a core `Bot` emits `connection` and `message`); bots without
 * events are tracked from lifecycle calls only.
 */

/** Connection snapshot of one managed bot (`GET /v1/bots/{id}/connection`). */
export interface BotConnectionInfo {
  /** Last provider connection state, or `'unknown'` for bots without events. */
  state: 'connecting' | 'authenticating' | 'ready' | 'closed' | 'unknown'
  /** Disconnect reason of the last `closed` update. */
  reason?: string
  /**
   * Current auth artifact while `authenticating` (a QR string or a pairing code), as the
   * provider rendered it. Cleared once the bot is ready or closed. Treat it as a secret.
   */
  authPayload?: string
  /** Epoch ms of the last connection update. */
  updatedAt?: number
}

/** Counters of one managed bot (`GET /v1/bots/{id}/metrics`). */
export interface BotMetrics {
  id: string
  running: boolean
  connection: BotConnectionInfo['state']
  /** Epoch ms of the last successful start (undefined while stopped). */
  startedAt?: number
  /** Milliseconds since `startedAt`. */
  uptimeMs: number
  messagesIn: number
  errors: number
  starts: number
  restarts: number
  reconnectAttempts: number
  activeConversations?: number
  flows?: number
}

interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off?(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

/** @internal */
export interface ObserverHooks {
  onConnection(update: { state: string; reason?: string }): void
}

/** @internal Tracks one bot's connection state and counters. */
export class BotObserver {
  readonly observable: boolean
  connection: BotConnectionInfo = { state: 'unknown' }
  messagesIn = 0
  errors = 0
  starts = 0
  restarts = 0
  startedAt?: number
  private readonly detachers: Array<() => void> = []

  constructor(bot: unknown, hooks: ObserverHooks, private readonly now: () => number = Date.now) {
    const source = asEventSource(bot)
    this.observable = source !== undefined
    if (!source) return
    this.listen(source, 'connection', (update) => {
      if (typeof update !== 'object' || update === null) return
      const u = update as { state?: unknown; reason?: unknown; authPayload?: unknown }
      if (typeof u.state !== 'string') return
      const state = (['connecting', 'authenticating', 'ready', 'closed'] as const).find((s) => s === u.state) ?? 'unknown'
      const authPayload = state === 'authenticating' && typeof u.authPayload === 'string' ? u.authPayload : state === 'authenticating' ? this.connection.authPayload : undefined
      this.connection = {
        state,
        ...(typeof u.reason === 'string' ? { reason: u.reason } : {}),
        ...(authPayload !== undefined ? { authPayload } : {}),
        updatedAt: this.now(),
      }
      hooks.onConnection({ state, reason: typeof u.reason === 'string' ? u.reason : undefined })
    })
    this.listen(source, 'message', () => { this.messagesIn++ })
    // No 'error' listener on purpose: attaching one changes how a core Bot reports its
    // errors (it stops logging them). `errors` counts the manager's lifecycle errors.
  }

  started(): void {
    this.starts++
    this.startedAt = this.now()
  }

  stopped(): void { this.startedAt = undefined }

  uptimeMs(): number { return this.startedAt === undefined ? 0 : Math.max(0, this.now() - this.startedAt) }

  detach(): void { while (this.detachers.length) this.detachers.pop()!() }

  private listen(source: EventSource, event: string, listener: (...args: unknown[]) => void): void {
    source.on(event, listener)
    this.detachers.push(() => {
      if (typeof source.off === 'function') source.off(event, listener)
      else source.removeListener?.(event, listener)
    })
  }
}

function asEventSource(bot: unknown): EventSource | undefined {
  if (typeof bot !== 'object' || bot === null) return undefined
  const candidate = bot as Partial<EventSource>
  return typeof candidate.on === 'function' ? (candidate as EventSource) : undefined
}
