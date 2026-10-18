/**
 * Auto-reconnect supervision (feature #27): exponential (or linear) backoff with
 * jitter, a retry budget and a grace period that lets the provider heal itself
 * first (Baileys reconnects transient drops on its own).
 */

/** `autoReconnect` options of the `BotManager`. */
export interface AutoReconnectOptions {
  /** Default `true` when the object is given. */
  enabled?: boolean
  /** Restart attempts before giving up (`'reconnectFailed'`). Default `5`; `Infinity` = never give up. */
  maxRetries?: number
  /** First backoff delay in ms. Default `1000`. */
  initialDelay?: number
  /** Ceiling of every delay in ms. Default `30000`. */
  maxDelay?: number
  /** Growth of the delay per attempt. Default `'exponential'`. */
  backoff?: 'exponential' | 'linear'
  /** Multiplier of the exponential backoff. Default `2`. */
  factor?: number
  /** Random reduction applied to each delay, `0`–`1` (`0.2` → delay in [80%, 100%]). Default `0.2`. */
  jitter?: number
  /**
   * After a `connection: closed` event, wait at least this long (ms) for the provider's own
   * reconnect before the manager restarts the bot. Default `10000`.
   */
  graceMs?: number
  /** Random source in [0, 1) (tests). Default `Math.random`. */
  random?: () => number
}

/** Fully resolved {@link AutoReconnectOptions}. */
export type ResolvedAutoReconnect = Required<Omit<AutoReconnectOptions, 'enabled'>> & { enabled: boolean }

/** Normalize `autoReconnect` (`true` = defaults, `false`/`undefined` = disabled). */
export function resolveAutoReconnect(input: AutoReconnectOptions | boolean | undefined): ResolvedAutoReconnect {
  const o = typeof input === 'object' && input !== null ? input : {}
  const enabled = input === true || (typeof input === 'object' && input !== null && input.enabled !== false)
  const resolved: ResolvedAutoReconnect = {
    enabled,
    maxRetries: o.maxRetries ?? 5,
    initialDelay: o.initialDelay ?? 1000,
    maxDelay: o.maxDelay ?? 30_000,
    backoff: o.backoff ?? 'exponential',
    factor: o.factor ?? 2,
    jitter: o.jitter ?? 0.2,
    graceMs: o.graceMs ?? 10_000,
    random: o.random ?? Math.random,
  }
  if (!(resolved.maxRetries >= 0)) throw new RangeError('autoReconnect.maxRetries must be >= 0')
  if (!(resolved.initialDelay >= 0) || !(resolved.maxDelay >= resolved.initialDelay)) throw new RangeError('autoReconnect delays must satisfy 0 <= initialDelay <= maxDelay')
  if (!(resolved.jitter >= 0 && resolved.jitter <= 1)) throw new RangeError('autoReconnect.jitter must be within [0, 1]')
  if (!(resolved.factor >= 1)) throw new RangeError('autoReconnect.factor must be >= 1')
  if (!(resolved.graceMs >= 0)) throw new RangeError('autoReconnect.graceMs must be >= 0')
  return resolved
}

/**
 * Delay before restart attempt number `attempt` (0-based): `initialDelay * factor^attempt`
 * (or `initialDelay * (attempt + 1)` for linear), capped at `maxDelay`, then reduced by up
 * to `jitter` (so concurrent bots do not reconnect in lockstep). Never exceeds `maxDelay`.
 */
export function computeBackoff(attempt: number, opts: Pick<ResolvedAutoReconnect, 'initialDelay' | 'maxDelay' | 'backoff' | 'factor' | 'jitter' | 'random'>): number {
  const n = Math.max(0, Math.floor(attempt))
  const raw = opts.backoff === 'linear' ? opts.initialDelay * (n + 1) : opts.initialDelay * Math.pow(opts.factor, n)
  const capped = Math.min(opts.maxDelay, Number.isFinite(raw) ? raw : opts.maxDelay)
  const r = Math.min(Math.max(opts.random(), 0), 1)
  return Math.max(0, Math.round(capped * (1 - opts.jitter * r)))
}

/** Payload of the manager's `reconnecting` event. */
export interface ReconnectingInfo {
  id: string
  /** 1-based attempt number about to run. */
  attempt: number
  delayMs: number
  /** Why: the provider's disconnect reason, or `'startFailed'`. */
  reason: string
}

/** Payload of the manager's `reconnected` event. */
export interface ReconnectedInfo { id: string; attempts: number }

/** Payload of the manager's `reconnectFailed` event (the retry budget is exhausted). */
export interface ReconnectFailedInfo { id: string; attempts: number; error?: unknown }

/** @internal Collaborators of {@link ReconnectSupervisor}. */
export interface SupervisorDeps {
  restart(id: string): Promise<void>
  /** Whether the bot is expected to be up (registered, desired running, not being stopped on purpose). */
  shouldRun(id: string): boolean
  /** Whether the bot currently reports a ready connection. */
  isReady(id: string): boolean
  /** Whether the bot reports connection events at all (otherwise a successful start counts as healthy). */
  observable(id: string): boolean
  onReconnecting(info: ReconnectingInfo): void
  onReconnected(info: ReconnectedInfo): void
  onFailed(info: ReconnectFailedInfo): void
  onError(id: string, error: unknown): void
}

interface SupervisedState {
  attempts: number
  timer?: ReturnType<typeof setTimeout>
  restarting?: boolean
  gaveUp?: boolean
}

/** @internal Per-bot restart scheduler used by the `BotManager`. */
export class ReconnectSupervisor {
  private readonly states = new Map<string, SupervisedState>()

  constructor(private readonly opts: ResolvedAutoReconnect, private readonly deps: SupervisorDeps) {}

  get enabled(): boolean { return this.opts.enabled }

  /** Attempts made so far for `id` since its last healthy state. */
  attempts(id: string): number { return this.states.get(id)?.attempts ?? 0 }

  /** Whether a restart is scheduled or running for `id`. */
  pending(id: string): boolean {
    const s = this.states.get(id)
    return Boolean(s?.timer || s?.restarting)
  }

  /** The bot's connection closed unexpectedly. `sessionTakenOver` is never retried. */
  onClosed(id: string, reason: string | undefined): void {
    if (!this.opts.enabled || reason === 'sessionTakenOver') return
    if (!this.deps.shouldRun(id)) return
    const s = this.state(id)
    if (s.timer || s.restarting || s.gaveUp) return
    const delay = Math.max(s.attempts === 0 ? this.opts.graceMs : 0, computeBackoff(s.attempts, this.opts))
    this.schedule(id, s, delay, reason ?? 'unknown')
  }

  /** A start (initial, restore or a restart attempt) failed. */
  onStartFailed(id: string, error: unknown): void {
    if (!this.opts.enabled || !this.deps.shouldRun(id)) return
    const s = this.state(id)
    if (s.timer || s.restarting) return
    if (s.attempts >= this.opts.maxRetries) return this.giveUp(id, s, error)
    this.schedule(id, s, computeBackoff(s.attempts, this.opts), 'startFailed')
  }

  /** The bot reported `ready`: reset its budget. */
  onReady(id: string): void {
    const s = this.states.get(id)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    const attempts = s.attempts
    this.states.delete(id)
    if (attempts > 0) this.deps.onReconnected({ id, attempts })
  }

  /** Stop supervising `id` (manual stop, removal). */
  cancel(id: string): void {
    const s = this.states.get(id)
    if (s?.timer) clearTimeout(s.timer)
    this.states.delete(id)
  }

  cancelAll(): void { for (const id of [...this.states.keys()]) this.cancel(id) }

  private state(id: string): SupervisedState {
    let s = this.states.get(id)
    if (!s) this.states.set(id, (s = { attempts: 0 }))
    return s
  }

  private schedule(id: string, s: SupervisedState, delayMs: number, reason: string): void {
    if (s.attempts >= this.opts.maxRetries) return this.giveUp(id, s)
    this.deps.onReconnecting({ id, attempt: s.attempts + 1, delayMs, reason })
    s.timer = setTimeout(() => {
      s.timer = undefined
      void this.attempt(id, s)
    }, delayMs)
    s.timer.unref?.()
  }

  private async attempt(id: string, s: SupervisedState): Promise<void> {
    if (this.states.get(id) !== s) return
    if (!this.deps.shouldRun(id) || this.deps.isReady(id)) { this.onReady(id); return }
    s.attempts++
    s.restarting = true
    try {
      await this.deps.restart(id)
      s.restarting = false
      if (this.states.get(id) !== s) return
      if (!this.deps.observable(id) || this.deps.isReady(id)) this.onReady(id)
    } catch (error) {
      s.restarting = false
      if (this.states.get(id) !== s) return
      this.deps.onError(id, error)
      if (s.attempts >= this.opts.maxRetries) return this.giveUp(id, s, error)
      this.schedule(id, s, computeBackoff(s.attempts, this.opts), 'startFailed')
    }
  }

  private giveUp(id: string, s: SupervisedState, error?: unknown): void {
    if (s.gaveUp) return
    s.gaveUp = true
    if (s.timer) clearTimeout(s.timer)
    s.timer = undefined
    this.deps.onFailed({ id, attempts: s.attempts, error })
  }
}
