/**
 * BotManager — multi-bot orchestrator for `@bot-wa/core`.
 *
 * Keeps a registry of bot instances keyed by id, tracks their running state
 * (a bot is *running* between its `start()` and `stop()`), and offers
 * parallel bulk lifecycle operations that collect failures instead of
 * throwing. Emits lifecycle events (`added`, `removed`, `started`,
 * `stopped`, `error`).
 *
 * Any object with `start()` / `stop()` is manageable — a real
 * {@link import('@bot-wa/core').Bot | Bot} from `@bot-wa/core` or a test stub.
 *
 * @example
 * ```ts
 * import { Bot } from '@bot-wa/core'
 * import { BotManager } from '@bot-wa/manager'
 *
 * const manager = new BotManager()
 * manager.on('error', ({ id, error }) => console.error(id, error))
 * const id = manager.add(botA, { meta: { tenant: 'acme' } })
 * await manager.startAll() // { [id]: 'ok' | Error }
 * ```
 */

import { EventEmitter } from 'node:events'
import pino, { type Logger } from 'pino'
import type { Bot } from '@bot-wa/core'

/**
 * Minimal lifecycle contract a managed bot must satisfy. A core {@link Bot}
 * satisfies it structurally; so does any `{ start, stop }` test fake.
 */
export interface ManageableBot {
  start(): Promise<void> | void
  stop(opts?: { drain?: boolean; timeout?: number }): Promise<void> | void
}

/** Options for {@link BotManager.add}. */
export interface AddBotOptions {
  /** Registry id. Auto-generated as `bot-N` when omitted. */
  id?: string
  /** Free-form metadata echoed back by {@link BotManager.list} / {@link BotManager.status}. */
  meta?: Record<string, unknown>
}

/** A registry entry (internal shape surfaced via {@link BotManager.entries}). */
export interface BotEntry {
  readonly id: string
  readonly bot: ManageableBot
  /** Unix epoch millis when the bot was added. */
  readonly createdAt: number
  readonly meta?: Record<string, unknown>
}

/** Public status snapshot returned by {@link BotManager.list} / {@link BotManager.status}. */
export interface BotStatus {
  id: string
  running: boolean
  meta?: Record<string, unknown>
}

/** Payload of the manager's `error` event. */
export interface ManagerErrorInfo {
  id: string
  error: unknown
}

/** Per-bot outcome of {@link BotManager.startAll} / {@link BotManager.stopAll}. */
export type StartStopOutcome = 'ok' | Error

/** Typed event map of {@link BotManager}. */
export interface ManagerEventMap {
  /** A bot was registered. Payload: its id. */
  added: [id: string]
  /** A bot was unregistered. Payload: its id. */
  removed: [id: string]
  /** A bot finished `start()`. Payload: its id. */
  started: [id: string]
  /** A bot finished `stop()`. Payload: its id. */
  stopped: [id: string]
  /** A lifecycle operation failed. Payload: `{ id, error }`. */
  error: [info: ManagerErrorInfo]
}

/** Options for the {@link BotManager} constructor. */
export interface BotManagerOptions {
  /** Inject a custom pino logger. Defaults to a silent `bot-wa-manager` logger. */
  logger?: Logger
}

type ManagerListener<K extends keyof ManagerEventMap> = (...args: ManagerEventMap[K]) => void

/**
 * Registry + lifecycle controller for many bots.
 *
 * Running state is tracked pragmatically: ids live in an internal `Set`
 * between a successful `start(id)` and `stop(id)`.
 */
export class BotManager extends EventEmitter {
  private readonly registry = new Map<string, BotEntry>()
  private readonly runningIds = new Set<string>()
  private readonly lifecycleOperations = new Map<string, Promise<void>>()
  private counter = 0
  readonly logger: Logger

  constructor(opts: BotManagerOptions = {}) {
    super()
    this.logger =
      opts.logger ??
      pino({ name: 'bot-wa-manager', level: process.env.BOTWA_MANAGER_LOG_LEVEL ?? 'silent' })
    // Safety net: an unhandled 'error' event on an EventEmitter throws and
    // crashes the process. Lifecycle failures are also re-thrown / collected
    // in results maps, so this no-op default keeps the manager crash-safe
    // when no listener is attached.
    this.on('error', () => {})
  }

  // ── Registry ────────────────────────────────────────────────────────────

  /**
   * Register a bot. Returns its id (`opts.id`, or an auto-generated
   * `bot-N` that never collides with existing ids). Throws on duplicate id.
   */
  add(bot: ManageableBot, opts: AddBotOptions = {}): string {
    const id = opts.id ?? this.nextId()
    if (this.registry.has(id)) throw new Error(`Bot id "${id}" is already registered`)
    const entry: BotEntry = { id, bot, createdAt: Date.now(), meta: opts.meta }
    this.registry.set(id, entry)
    this.logger.debug({ id }, 'bot added')
    this.emit('added', id)
    return id
  }

  /** The bot registered under `id`, or `undefined`. */
  get(id: string): ManageableBot | undefined {
    return this.registry.get(id)?.bot
  }

  /** Whether `id` is registered. */
  has(id: string): boolean {
    return this.registry.has(id)
  }

  /**
   * Unregister `id`, stopping it first if it is running (a failed stop is
   * reported via the `error` event but does not block removal).
   * Returns `false` when the id is unknown.
   */
  async remove(id: string): Promise<boolean> {
    const entry = this.registry.get(id)
    if (!entry) return false
    if (this.runningIds.has(id)) {
      try {
        await this.stop(id)
      } catch (error) {
        // stop() already emitted 'error'; make sure state is consistent.
        this.runningIds.delete(id)
        this.logger.warn({ id, err: error }, 'stop failed during remove')
      }
    }
    this.registry.delete(id)
    this.logger.debug({ id }, 'bot removed')
    this.emit('removed', id)
    return true
  }

  /** Status snapshot of every registered bot. */
  list(): BotStatus[] {
    return [...this.registry.keys()].map((id) => this.status(id)!)
  }

  /** Raw registry entries (includes the bot instances and `createdAt`). */
  entries(): BotEntry[] {
    return [...this.registry.values()]
  }

  /** Status snapshot of one bot, or `undefined` when unknown. */
  status(id: string): BotStatus | undefined {
    const entry = this.registry.get(id)
    if (!entry) return undefined
    return { id: entry.id, running: this.runningIds.has(id), meta: entry.meta }
  }

  /** Whether the bot is currently running (between `start()` and `stop()`). */
  isRunning(id: string): boolean {
    return this.runningIds.has(id)
  }

  /** Number of registered bots. */
  get size(): number {
    return this.registry.size
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start one bot. No-op when already running. Throws for unknown ids and
   * re-throws start failures (after emitting `error`).
   */
  async start(id: string): Promise<void> {
    return this.serializeLifecycle(id, async () => {
    const entry = this.registry.get(id)
    if (!entry) throw new Error(`Bot "${id}" is not registered`)
    if (this.runningIds.has(id)) return
    try {
      await entry.bot.start()
    } catch (error) {
      this.emitError(id, error)
      throw error
    }
    this.runningIds.add(id)
    this.logger.debug({ id }, 'bot started')
    this.emit('started', id)
    })
  }

  /**
   * Stop one bot. No-op when not running. Throws for unknown ids and
   * re-throws stop failures (after emitting `error`); on failure the bot
   * is considered still running.
   */
  async stop(id: string): Promise<void> {
    return this.serializeLifecycle(id, async () => {
    const entry = this.registry.get(id)
    if (!entry) throw new Error(`Bot "${id}" is not registered`)
    if (!this.runningIds.has(id)) return
    try {
      await entry.bot.stop()
    } catch (error) {
      this.emitError(id, error)
      throw error
    }
    this.runningIds.delete(id)
    this.logger.debug({ id }, 'bot stopped')
    this.emit('stopped', id)
    })
  }

  /**
   * Start every registered bot in parallel. Never throws: failures are
   * collected in the results map as `{ [id]: 'ok' | Error }`.
   */
  async startAll(): Promise<Record<string, StartStopOutcome>> {
    const ids = [...this.registry.keys()]
    const results: Record<string, StartStopOutcome> = {}
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.start(id)
          results[id] = 'ok'
        } catch (error) {
          results[id] = toError(error)
        }
      }),
    )
    return results
  }

  /**
   * Stop every registered bot in parallel. Never throws: failures are
   * collected in the results map as `{ [id]: 'ok' | Error }`.
   */
  async stopAll(): Promise<Record<string, StartStopOutcome>> {
    const ids = [...this.registry.keys()]
    const results: Record<string, StartStopOutcome> = {}
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.stop(id)
          results[id] = 'ok'
        } catch (error) {
          results[id] = toError(error)
        }
      }),
    )
    return results
  }

  // ── Typed event API ─────────────────────────────────────────────────────

  override on<K extends keyof ManagerEventMap>(event: K, listener: ManagerListener<K>): this
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  override once<K extends keyof ManagerEventMap>(event: K, listener: ManagerListener<K>): this
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void)
  }

  override off<K extends keyof ManagerEventMap>(event: K, listener: ManagerListener<K>): this
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void)
  }

  override emit<K extends keyof ManagerEventMap>(event: K, ...args: ManagerEventMap[K]): boolean
  override emit(event: string | symbol, ...args: unknown[]): boolean
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private nextId(): string {
    let id: string
    do {
      id = `bot-${++this.counter}`
    } while (this.registry.has(id))
    return id
  }

  private serializeLifecycle(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.lifecycleOperations.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.lifecycleOperations.set(id, next)
    void next.finally(() => {
      if (this.lifecycleOperations.get(id) === next) this.lifecycleOperations.delete(id)
    }).catch(() => {})
    return next
  }

  private emitError(id: string, error: unknown): void {
    this.logger.warn({ id, err: error }, 'bot lifecycle error')
    this.emit('error', { id, error })
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
