/**
 * BotManager — multi-bot orchestrator for `@bot-wa/core`.
 *
 * Keeps a registry of bot instances keyed by id, tracks their running state
 * (a bot is *running* between its `start()` and `stop()`), and offers
 * parallel bulk lifecycle operations that collect failures instead of
 * throwing. Emits lifecycle events (`added`, `removed`, `started`,
 * `stopped`, `error`, …).
 *
 * On top of the registry it optionally offers:
 * - **multi-tenant persistence** (`factory` + `configStore`/`persistence`):
 *   `createBot()` / `updateBot()` / `deleteBot()` keep a serializable
 *   {@link BotConfigRecord} per bot and `restore()` rebuilds them after a restart;
 * - **auto-reconnect supervision** (`autoReconnect`): unexpected disconnects and
 *   failed starts are retried with exponential backoff + jitter;
 * - **dynamic JSON flows** per bot (`addFlow`/`putFlow`/`removeFlow`).
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
import { capability, requireCapability } from './capabilities.js'
import { ManagerError } from './errors.js'
import { compileFlowDocument, FlowDocumentError, validateFlowDocument, type FlowDocument } from './flows/compile.js'
import { BotObserver, type BotConnectionInfo, type BotMetrics } from './observer.js'
import {
  assertSafeId,
  FileBotConfigStore,
  type BotConfigRecord,
  type BotConfigStore,
  type BotDesiredRunState,
  type BotFactory,
  type BotProviderConfig,
} from './persistence.js'
import {
  ReconnectSupervisor,
  resolveAutoReconnect,
  type AutoReconnectOptions,
  type ReconnectedInfo,
  type ReconnectFailedInfo,
  type ReconnectingInfo,
} from './reconnect.js'

/**
 * Minimal lifecycle contract a managed bot must satisfy. A core `Bot`
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
  /** Owning tenant (used by the REST API to scope tokens). */
  tenantId?: string
  /** Human-readable name. */
  name?: string
}

/** A registry entry (internal shape surfaced via {@link BotManager.entries}). */
export interface BotEntry {
  readonly id: string
  readonly bot: ManageableBot
  /** Unix epoch millis when the bot was added. */
  readonly createdAt: number
  readonly meta?: Record<string, unknown>
  readonly tenantId?: string
  readonly name?: string
}

/** Public status snapshot returned by {@link BotManager.list} / {@link BotManager.status}. */
export interface BotStatus {
  id: string
  running: boolean
  meta?: Record<string, unknown>
  tenantId?: string
  name?: string
}

/** Payload of the manager's `error` event. */
export interface ManagerErrorInfo {
  id: string
  error: unknown
}

/** Per-bot outcome of {@link BotManager.startAll} / {@link BotManager.stopAll}. */
export type StartStopOutcome = 'ok' | Error

/** Payload of the manager's `connection` event. */
export interface ManagerConnectionEvent extends BotConnectionInfo { id: string }

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
  /** A bot was restarted (manually or by the supervisor). Payload: its id. */
  restarted: [id: string]
  /** A lifecycle operation failed. Payload: `{ id, error }`. */
  error: [info: ManagerErrorInfo]
  /** A bot's connection state changed (bots that emit `connection`). */
  connection: [info: ManagerConnectionEvent]
  /** The supervisor scheduled a restart attempt. */
  reconnecting: [info: ReconnectingInfo]
  /** A supervised bot is healthy again after one or more attempts. */
  reconnected: [info: ReconnectedInfo]
  /** The supervisor gave up (retry budget exhausted). */
  reconnectFailed: [info: ReconnectFailedInfo]
}

/** Options for the {@link BotManager} constructor. */
export interface BotManagerOptions {
  /** Inject a custom pino logger. Defaults to a silent `bot-wa-manager` logger. */
  logger?: Logger
  /** Builds bots from persisted configs. Required by `createBot()`/`updateBot()`/`restore()`. */
  factory?: BotFactory
  /** Where bot configs are persisted. Defaults to in-memory only (nothing persisted). */
  configStore?: BotConfigStore
  /** Shorthand for `configStore: new FileBotConfigStore({ dir })`. */
  persistence?: { dir: string }
  /** Restart bots whose connection drops or whose start fails. `true` = defaults. */
  autoReconnect?: AutoReconnectOptions | boolean
  /** Tenant of bots created without `tenantId`. Default `'default'`. */
  defaultTenantId?: string
}

/** Input of {@link BotManager.createBot}. */
export interface CreateBotInput {
  /** Bot id (`[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`); generated when omitted. */
  id?: string
  tenantId?: string
  name?: string
  provider?: BotProviderConfig
  /** JSON flow documents (validated; see `compileFlowDocument`). */
  flows?: unknown[]
  meta?: Record<string, unknown>
  /** Start it right away and on every `restore()`. Default `true`. */
  autoStart?: boolean
}

/** Patch of {@link BotManager.updateBot}. `provider`/`flows` changes rebuild the bot. */
export interface UpdateBotInput {
  name?: string
  provider?: BotProviderConfig
  flows?: unknown[]
  meta?: Record<string, unknown>
  desiredState?: BotDesiredRunState
}

/** Per-bot outcome of {@link BotManager.restore}. */
export type RestoreOutcome = 'started' | 'stopped' | Error

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
  /** Ids the operator wants up (start() called, stop() not): the supervisor keeps them alive. */
  private readonly wanted = new Set<string>()
  /** Ids being stopped on purpose (their `closed` event must not trigger a reconnect). */
  private readonly stopping = new Set<string>()
  private readonly lifecycleOperations = new Map<string, Promise<void>>()
  /** Per-bot queue that serializes every read-modify-write of a bot's config. */
  private readonly configOperations = new Map<string, Promise<unknown>>()
  /** Ids claimed by an in-flight createBot()/restore() (not yet registered). */
  private readonly reserved = new Set<string>()
  /** Ids whose last start() rejected: the instance may hold half-open resources. */
  private readonly failedStarts = new Set<string>()
  private readonly observers = new Map<string, BotObserver>()
  private readonly configs = new Map<string, BotConfigRecord>()
  private readonly lifecycleErrors = new Map<string, number>()
  private readonly supervisor: ReconnectSupervisor
  private readonly factory?: BotFactory
  private readonly configStore?: BotConfigStore
  private readonly defaultTenantId: string
  private counter = 0
  readonly logger: Logger

  constructor(opts: BotManagerOptions = {}) {
    super()
    this.logger =
      opts.logger ??
      pino({ name: 'bot-wa-manager', level: process.env.BOTWA_MANAGER_LOG_LEVEL ?? 'silent' })
    this.factory = opts.factory
    this.configStore = opts.configStore ?? (opts.persistence ? new FileBotConfigStore({
      dir: opts.persistence.dir,
      onCorrupt: (file, err) => this.logger.warn({ file, err }, 'skipping unreadable bot config'),
    }) : undefined)
    this.defaultTenantId = opts.defaultTenantId ?? 'default'
    assertSafeId(this.defaultTenantId, 'defaultTenantId')
    this.supervisor = new ReconnectSupervisor(resolveAutoReconnect(opts.autoReconnect), {
      restart: (id) => this.restart(id, { recreate: this.canRecreate(id), supervised: true }),
      shouldRun: (id) => this.registry.has(id) && this.wanted.has(id) && !this.stopping.has(id),
      isReady: (id) => this.observers.get(id)?.connection.state === 'ready',
      observable: (id) => this.observers.get(id)?.observable === true,
      onReconnecting: (info) => { this.logger.warn(info, 'bot reconnect scheduled'); this.emit('reconnecting', info) },
      onReconnected: (info) => { this.logger.info(info, 'bot reconnected'); this.emit('reconnected', info) },
      onFailed: (info) => { this.logger.error({ id: info.id, attempts: info.attempts, err: info.error }, 'bot reconnect gave up'); this.emit('reconnectFailed', info) },
      onError: (id, error) => this.emitError(id, error),
    })
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
    if (this.registry.has(id) || this.reserved.has(id)) throw new Error(`Bot id "${id}" is already registered`)
    const entry: BotEntry = {
      id, bot, createdAt: Date.now(), meta: opts.meta,
      ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    }
    this.registry.set(id, entry)
    this.observe(id, bot)
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
   * Returns `false` when the id is unknown. A persisted config is kept (see {@link deleteBot}).
   */
  async remove(id: string): Promise<boolean> {
    return this.serializeConfig(id, () => this.removeUnlocked(id))
  }

  /**
   * Remove under the config lock. The stop and the unregistration run as ONE lifecycle
   * operation, so it waits for an in-flight start/restart and nothing queued after it
   * can start the bot again.
   */
  private async removeUnlocked(id: string): Promise<boolean> {
    if (!this.registry.has(id)) return false
    this.wanted.delete(id)
    this.supervisor.cancel(id)
    let removed = false
    await this.serializeLifecycle(id, async () => {
      const entry = this.registry.get(id)
      if (!entry) return
      try {
        await this.stopBody(id)
      } catch (error) {
        // stopBody() already emitted 'error'; removal goes on.
        this.logger.warn({ id, err: error }, 'stop failed during remove')
      }
      if (this.failedStarts.has(id)) await this.retire(id, entry.bot)
      this.runningIds.delete(id)
      this.failedStarts.delete(id)
      this.registry.delete(id)
      this.observers.get(id)?.detach()
      this.observers.delete(id)
      this.configs.delete(id)
      this.lifecycleErrors.delete(id)
      removed = true
    })
    if (!removed) return false
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
    const status: BotStatus = { id: entry.id, running: this.runningIds.has(id), meta: entry.meta }
    if (entry.tenantId !== undefined) status.tenantId = entry.tenantId
    if (entry.name !== undefined) status.name = entry.name
    return status
  }

  /** Whether the bot is currently running (between `start()` and `stop()`). */
  isRunning(id: string): boolean {
    return this.runningIds.has(id)
  }

  /** Number of registered bots. */
  get size(): number {
    return this.registry.size
  }

  /** Connection snapshot (state, reason, QR/pairing payload while authenticating). */
  connection(id: string): BotConnectionInfo | undefined {
    const observer = this.observers.get(id)
    return observer ? { ...observer.connection } : undefined
  }

  /** Counters of one bot (`undefined` when unknown). */
  metrics(id: string): BotMetrics | undefined {
    const entry = this.registry.get(id)
    const observer = this.observers.get(id)
    if (!entry || !observer) return undefined
    const metrics: BotMetrics = {
      id,
      running: this.runningIds.has(id),
      connection: observer.connection.state,
      ...(observer.startedAt !== undefined ? { startedAt: observer.startedAt } : {}),
      uptimeMs: observer.uptimeMs(),
      messagesIn: observer.messagesIn,
      errors: this.lifecycleErrors.get(id) ?? 0,
      starts: observer.starts,
      restarts: observer.restarts,
      reconnectAttempts: this.supervisor.attempts(id),
    }
    const conversations = capability(entry.bot, 'listConversations')
    if (conversations) metrics.activeConversations = conversations().length
    const flows = capability(entry.bot, 'listFlows')
    if (flows) metrics.flows = flows().length
    return metrics
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start one bot. No-op when already running. Throws for unknown ids and
   * re-throws start failures (after emitting `error`).
   */
  async start(id: string): Promise<void> {
    if (this.registry.has(id)) {
      this.wanted.add(id)
      this.supervisor.cancel(id)
    }
    await this.serializeLifecycle(id, () => this.startBody(id))
    await this.persistDesired(id, 'running')
  }

  /**
   * Stop one bot. No-op when not running. Throws for unknown ids and
   * re-throws stop failures (after emitting `error`); on failure the bot
   * is considered still running.
   */
  async stop(id: string): Promise<void> {
    this.wanted.delete(id)
    this.supervisor.cancel(id)
    await this.serializeLifecycle(id, () => this.stopBody(id))
    await this.persistDesired(id, 'stopped')
  }

  /**
   * Stop (when running) and start a bot again. With `recreate: true` a config-backed bot is
   * rebuilt from its {@link BotConfigRecord} through the factory (fresh provider instance).
   */
  async restart(id: string, opts: { recreate?: boolean; supervised?: boolean } = {}): Promise<void> {
    if (!this.registry.has(id)) throw new Error(`Bot "${id}" is not registered`)
    if (!opts.supervised) {
      this.wanted.add(id)
      this.supervisor.cancel(id)
    }
    await this.serializeLifecycle(id, async () => {
      await this.stopBody(id)
      if (opts.recreate) await this.rebuild(id)
      else if (this.failedStarts.has(id)) await this.retire(id, this.registry.get(id)!.bot)
      const observer = this.observers.get(id)
      if (observer) observer.restarts++
      await this.startBody(id)
    })
    this.emit('restarted', id)
    if (!opts.supervised) await this.persistDesired(id, 'running')
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

  /**
   * Graceful shutdown: cancel every pending reconnect and stop all bots WITHOUT
   * changing their persisted desired state (so `restore()` brings them back).
   */
  async shutdown(): Promise<Record<string, StartStopOutcome>> {
    this.supervisor.cancelAll()
    const results: Record<string, StartStopOutcome> = {}
    await Promise.all([...this.registry.keys()].map(async (id) => {
      this.wanted.delete(id)
      try {
        await this.serializeLifecycle(id, () => this.stopBody(id))
        results[id] = 'ok'
      } catch (error) {
        results[id] = toError(error)
      }
    }))
    return results
  }

  // ── Persistence / multi-tenant (feature #26) ───────────────────────────

  /** The persisted config of a bot created through {@link createBot}/{@link restore}. */
  getConfig(id: string): BotConfigRecord | undefined {
    const record = this.configs.get(id)
    return record ? structuredClone(record) : undefined
  }

  /** Configs of every config-backed bot, optionally for one tenant. */
  listConfigs(tenantId?: string): BotConfigRecord[] {
    return [...this.configs.values()].filter((r) => tenantId === undefined || r.tenantId === tenantId).map((r) => structuredClone(r))
  }

  /**
   * Build a bot from a serializable config through the `factory`, register it, persist the
   * config and (unless `autoStart: false`) start it. A failed start is reported through
   * `error` (and retried by the supervisor when `autoReconnect` is on); it does not reject.
   */
  async createBot(input: CreateBotInput): Promise<BotStatus> {
    const factory = this.requireFactory()
    const id = input.id ?? this.nextId()
    assertSafeId(id, 'bot id')
    const tenantId = input.tenantId ?? this.defaultTenantId
    assertSafeId(tenantId, 'tenantId')
    const flows = checkFlows(input.flows)
    const conflict = () => new ManagerError(`Bot id "${id}" already exists`, 'CONFLICT')
    // Claim the id synchronously, before the first await: a concurrent createBot()/add()
    // for the same id must fail instead of overwriting this one's config.
    if (this.registry.has(id) || this.configs.has(id) || this.reserved.has(id)) throw conflict()
    this.reserved.add(id)
    const now = Date.now()
    let bot: ManageableBot | undefined
    let record: BotConfigRecord
    try {
      record = {
        id, tenantId, desiredState: input.autoStart === false ? 'stopped' : 'running', version: 1, createdAt: now, updatedAt: now,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.provider !== undefined ? { provider: checkProvider(input.provider) } : {}),
        ...(flows.length ? { flows } : {}),
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
      }
      if (await this.configStore?.get(id)) throw conflict()
      bot = await this.materialize(factory, record)
      await this.configStore?.put(record)
    } catch (error) {
      if (bot) await this.retire(id, bot)
      throw error
    } finally {
      this.reserved.delete(id)
    }
    this.configs.set(id, record)
    this.add(bot, { id, tenantId, meta: record.meta, ...(record.name !== undefined ? { name: record.name } : {}) })
    if (record.desiredState === 'running') await this.startSupervised(id)
    return this.status(id)!
  }

  /**
   * Patch a config-backed bot. `provider`/`flows` changes rebuild the bot through the factory
   * (stopping and restarting it when it was running); `desiredState` starts/stops it.
   * Pass `expectedVersion` for optimistic concurrency (`CONFLICT` on mismatch).
   */
  async updateBot(id: string, patch: UpdateBotInput, opts: { expectedVersion?: number } = {}): Promise<BotConfigRecord> {
    const next = await this.serializeConfig(id, async () => {
      const current = this.configs.get(id)
      if (!current) throw new ManagerError(`Bot "${id}" has no managed config`, this.registry.has(id) ? 'NOT_CONFIGURED' : 'NOT_FOUND')
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
        throw new ManagerError(`Bot "${id}" is at version ${current.version}`, 'CONFLICT')
      }
      const flows = patch.flows !== undefined ? checkFlows(patch.flows) : undefined
      const next: BotConfigRecord = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.provider !== undefined ? { provider: checkProvider(patch.provider) } : {}),
        ...(flows !== undefined ? { flows } : {}),
        ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
        ...(patch.desiredState !== undefined ? { desiredState: checkDesired(patch.desiredState) } : {}),
        version: current.version + 1,
        updatedAt: Date.now(),
      }
      if (flows !== undefined && flows.length === 0) delete next.flows
      if (patch.provider !== undefined || flows !== undefined) {
        const fresh = await this.materialize(this.requireFactory(), next)
        try {
          await this.serializeLifecycle(id, async () => {
            if (!this.registry.has(id)) throw new ManagerError(`Bot "${id}" is not registered`, 'NOT_FOUND')
            await this.stopBody(id)
            this.swapBot(id, fresh, next)
          })
        } catch (error) {
          await this.retire(id, fresh)
          throw error
        }
      } else {
        this.replaceEntry(id, this.registry.get(id)!.bot, next)
      }
      await this.configStore?.put(next)
      this.configs.set(id, next)
      return next
    })
    if (next.desiredState === 'running' && !this.runningIds.has(id)) await this.startSupervised(id)
    else if (next.desiredState === 'stopped' && this.runningIds.has(id)) await this.stop(id)
    return structuredClone(this.configs.get(id) ?? next)
  }

  /** Stop, unregister and forget a bot, including its persisted config. */
  async deleteBot(id: string): Promise<boolean> {
    return this.serializeConfig(id, async () => {
      const removed = await this.removeUnlocked(id)
      const deleted = (await this.configStore?.delete(id)) ?? false
      return removed || deleted
    })
  }

  /**
   * Rebuild every persisted bot (call once at boot). Bots already registered are skipped;
   * those whose desired state is `running` are started (failures are reported, retried by
   * the supervisor when enabled, and returned as `Error`s — this never rejects for one bot).
   */
  async restore(): Promise<Record<string, RestoreOutcome>> {
    if (!this.configStore) throw new ManagerError('restore() needs a configStore or persistence option', 'NOT_CONFIGURED')
    const factory = this.requireFactory()
    const results: Record<string, RestoreOutcome> = {}
    const records = await this.configStore.list()
    await Promise.all(records.map(async (record) => {
      if (this.registry.has(record.id) || this.reserved.has(record.id) || this.configs.has(record.id)) return
      this.reserved.add(record.id)
      try {
        const bot = await this.materialize(factory, record)
        this.reserved.delete(record.id)
        this.configs.set(record.id, record)
        this.add(bot, { id: record.id, tenantId: record.tenantId, meta: record.meta, ...(record.name !== undefined ? { name: record.name } : {}) })
      } catch (error) {
        this.reserved.delete(record.id)
        this.emitError(record.id, error)
        results[record.id] = toError(error)
        return
      }
      if (record.desiredState !== 'running') { results[record.id] = 'stopped'; return }
      const error = await this.startSupervised(record.id)
      results[record.id] = error ?? 'started'
    }))
    return results
  }

  // ── Dynamic JSON flows (feature #24) ───────────────────────────────────

  /** JSON flow documents attached to a config-backed bot (empty for plain bots). */
  listFlowDocuments(botId: string): FlowDocument[] {
    this.requireEntry(botId)
    return structuredClone(this.configs.get(botId)?.flows ?? [])
  }

  /** Register a new JSON flow on a live bot (and persist it for config-backed bots). Returns its id. */
  async addFlow(botId: string, document: unknown): Promise<string> {
    return this.serializeConfig(botId, () => this.addFlowUnlocked(botId, document))
  }

  private async addFlowUnlocked(botId: string, document: unknown): Promise<string> {
    const entry = this.requireEntry(botId)
    const compiled = compileFlowDocument(document, { resolveSubflow: (id) => this.storedFlowDocument(botId, id) })
    if (requireCapability(entry.bot, 'hasFlow')(compiled.id)) {
      throw new ManagerError(`Flow "${compiled.id}" already exists on bot "${botId}"`, 'CONFLICT')
    }
    requireCapability(entry.bot, 'registerFlow')(compiled)
    await this.saveFlows(botId, (flows) => [...flows, structuredClone(document) as FlowDocument])
    return compiled.id
  }

  /** Create or hot-swap the JSON flow `flowId` (the document's `id` must match). */
  async putFlow(botId: string, flowId: string, document: unknown): Promise<{ created: boolean }> {
    return this.serializeConfig(botId, () => this.putFlowUnlocked(botId, flowId, document))
  }

  private async putFlowUnlocked(botId: string, flowId: string, document: unknown): Promise<{ created: boolean }> {
    const entry = this.requireEntry(botId)
    const compiled = compileFlowDocument(document, { resolveSubflow: (id) => this.storedFlowDocument(botId, id) })
    if (compiled.id !== flowId) throw new ManagerError(`Flow document id "${compiled.id}" does not match "${flowId}"`, 'INVALID')
    const created = !requireCapability(entry.bot, 'hasFlow')(flowId)
    requireCapability(entry.bot, 'replaceFlow')(flowId, compiled)
    const doc = structuredClone(document) as FlowDocument
    await this.saveFlows(botId, (flows) => {
      const i = flows.findIndex((f) => f.id === flowId)
      if (i === -1) return [...flows, doc]
      const copy = [...flows]
      copy[i] = doc
      return copy
    })
    return { created }
  }

  /** A stored flow document of `botId`, for resolving `subflow` steps. */
  private storedFlowDocument(botId: string, flowId: string): FlowDocument | undefined {
    const flows = (this.configs.get(botId)?.flows ?? []) as Array<{ id?: string }>
    return flows.find((flow) => flow.id === flowId) as FlowDocument | undefined
  }

  /** Unregister flow `flowId` from a live bot (and its persisted config). */
  async removeFlow(botId: string, flowId: string): Promise<boolean> {
    return this.serializeConfig(botId, () => this.removeFlowUnlocked(botId, flowId))
  }

  private async removeFlowUnlocked(botId: string, flowId: string): Promise<boolean> {
    const entry = this.requireEntry(botId)
    const removed = requireCapability(entry.bot, 'unregisterFlow')(flowId)
    let persisted = false
    await this.saveFlows(botId, (flows) => {
      const kept = flows.filter((f) => f.id !== flowId)
      persisted = kept.length !== flows.length
      return kept
    })
    return removed || persisted
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
    } while (this.registry.has(id) || this.configs.has(id) || this.reserved.has(id))
    return id
  }

  private async startBody(id: string): Promise<void> {
    const entry = this.registry.get(id)
    if (!entry) throw new Error(`Bot "${id}" is not registered`)
    if (this.runningIds.has(id)) return
    try {
      await entry.bot.start()
    } catch (error) {
      this.failedStarts.add(id)
      this.emitError(id, error)
      throw error
    }
    this.failedStarts.delete(id)
    if (this.registry.get(id)?.bot !== entry.bot) {
      // Removed or swapped while starting (both normally run under the lifecycle queue).
      // Never leave an unmanaged instance running.
      await this.retire(id, entry.bot)
      throw new ManagerError(`Bot "${id}" was removed while starting`, 'NOT_FOUND')
    }
    this.runningIds.add(id)
    this.observers.get(id)?.started()
    this.logger.debug({ id }, 'bot started')
    this.emit('started', id)
  }

  private async stopBody(id: string): Promise<void> {
    const entry = this.registry.get(id)
    if (!entry) throw new Error(`Bot "${id}" is not registered`)
    if (!this.runningIds.has(id)) return
    this.stopping.add(id)
    try {
      await entry.bot.stop()
    } catch (error) {
      this.emitError(id, error)
      throw error
    } finally {
      this.stopping.delete(id)
    }
    this.runningIds.delete(id)
    this.observers.get(id)?.stopped()
    this.logger.debug({ id }, 'bot stopped')
    this.emit('stopped', id)
  }

  /** Start under supervision: a failure is handed to the supervisor instead of rejecting. */
  private async startSupervised(id: string): Promise<Error | undefined> {
    try {
      await this.start(id)
      return undefined
    } catch (error) {
      this.supervisor.onStartFailed(id, error)
      return toError(error)
    }
  }

  private observe(id: string, bot: ManageableBot): void {
    const previous = this.observers.get(id)
    previous?.detach()
    const observer = new BotObserver(bot, {
      onConnection: ({ state, reason }) => {
        if (this.observers.get(id) !== observer) return
        this.emit('connection', { id, ...observer.connection })
        if (state === 'ready') this.supervisor.onReady(id)
        else if (state === 'closed' && this.runningIds.has(id) && !this.stopping.has(id)) this.supervisor.onClosed(id, reason)
      },
    })
    if (previous) {
      observer.starts = previous.starts
      observer.restarts = previous.restarts
      observer.messagesIn = previous.messagesIn
    }
    this.observers.set(id, observer)
  }

  private replaceEntry(id: string, bot: ManageableBot, record: BotConfigRecord): void {
    const old = this.registry.get(id)!
    this.registry.set(id, {
      id, bot, createdAt: old.createdAt, meta: record.meta, tenantId: record.tenantId,
      ...(record.name !== undefined ? { name: record.name } : {}),
    })
    if (old.bot !== bot) this.observe(id, bot)
  }

  /**
   * Rebuild a stopped bot from its current config (runs inside the lifecycle queue).
   * If the config changed while the factory ran (a flow added, say), build again from
   * the newer record so the live bot never lags behind what was persisted.
   */
  private async rebuild(id: string): Promise<void> {
    if (!this.factory) return
    for (let attempt = 0; attempt < 5; attempt++) {
      const record = this.configs.get(id)
      if (!record || !this.registry.has(id)) return
      const bot = await this.materialize(this.factory, record)
      if (this.configs.get(id) === record && this.registry.has(id)) {
        this.swapBot(id, bot, record)
        return
      }
      await this.retire(id, bot)
    }
    throw new ManagerError(`Bot "${id}" config kept changing during rebuild`, 'CONFLICT')
  }

  /**
   * Install `bot` in place of the current (stopped) instance. An old instance whose
   * start() failed is stopped too: it may hold half-open sockets, timers or webhooks.
   */
  private swapBot(id: string, bot: ManageableBot, record: BotConfigRecord): void {
    const old = this.registry.get(id)!.bot
    const failed = this.failedStarts.has(id)
    this.failedStarts.delete(id)
    this.replaceEntry(id, bot, record)
    if (failed && old !== bot) void this.retire(id, old)
  }

  /** Best-effort stop of an instance the manager is dropping. Never throws. */
  private async retire(id: string, bot: ManageableBot): Promise<void> {
    try {
      await bot.stop()
    } catch (error) {
      this.logger.warn({ id, err: error }, 'stopping a discarded bot instance failed')
    }
  }

  private canRecreate(id: string): boolean { return this.factory !== undefined && this.configs.has(id) }

  private async materialize(factory: BotFactory, record: BotConfigRecord): Promise<ManageableBot> {
    const bot = await factory(Object.freeze(structuredClone(record)))
    if (!bot || typeof bot.start !== 'function' || typeof bot.stop !== 'function') {
      throw new ManagerError('factory must return an object with start() and stop()', 'INVALID')
    }
    if (record.flows?.length) {
      const replace = requireCapability(bot, 'replaceFlow')
      for (const doc of record.flows) replace(doc.id, compileFlowDocument(doc))
    }
    return bot
  }

  private async persistDesired(id: string, desiredState: BotDesiredRunState): Promise<void> {
    if (!this.configs.has(id)) return
    await this.serializeConfig(id, async () => {
      const record = this.configs.get(id)
      if (!record || record.desiredState === desiredState) return
      const next = { ...record, desiredState, version: record.version + 1, updatedAt: Date.now() }
      await this.configStore?.put(next)
      this.configs.set(id, next)
    })
  }

  private async saveFlows(botId: string, update: (flows: FlowDocument[]) => FlowDocument[]): Promise<void> {
    const record = this.configs.get(botId)
    if (!record) return
    const flows = update(record.flows ?? [])
    const next: BotConfigRecord = { ...record, flows, version: record.version + 1, updatedAt: Date.now() }
    if (!flows.length) delete next.flows
    await this.configStore?.put(next)
    this.configs.set(botId, next)
  }

  private requireEntry(id: string): BotEntry {
    const entry = this.registry.get(id)
    if (!entry) throw new ManagerError(`Bot "${id}" is not registered`, 'NOT_FOUND')
    return entry
  }

  private requireFactory(): BotFactory {
    if (!this.factory) throw new ManagerError('this operation needs a BotManager({ factory })', 'NOT_CONFIGURED')
    return this.factory
  }

  /** Run `operation` after every earlier config operation of `id` (a per-bot mutex). */
  private serializeConfig<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.configOperations.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.configOperations.set(id, next)
    void next.finally(() => {
      if (this.configOperations.get(id) === next) this.configOperations.delete(id)
    }).catch(() => {})
    return next
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
    this.lifecycleErrors.set(id, (this.lifecycleErrors.get(id) ?? 0) + 1)
    this.logger.warn({ id, err: error }, 'bot lifecycle error')
    this.emit('error', { id, error })
  }
}

function checkFlows(flows: unknown[] | undefined): FlowDocument[] {
  if (flows === undefined) return []
  if (!Array.isArray(flows)) throw new ManagerError('flows must be an array of flow documents', 'INVALID')
  const ids = new Set<string>()
  flows.forEach((doc, i) => {
    const issues = validateFlowDocument(doc)
    if (issues.length) throw new ManagerError(`flows[${i}] is invalid`, 'INVALID', new FlowDocumentError(issues).issues)
    const id = (doc as FlowDocument).id
    if (ids.has(id)) throw new ManagerError(`duplicate flow id "${id}"`, 'INVALID')
    ids.add(id)
  })
  return structuredClone(flows) as FlowDocument[]
}

function checkProvider(provider: BotProviderConfig): BotProviderConfig {
  if (typeof provider !== 'object' || provider === null || typeof provider.type !== 'string' || !provider.type) {
    throw new ManagerError('provider must be { type: string, options?: object }', 'INVALID')
  }
  if (provider.options !== undefined && (typeof provider.options !== 'object' || provider.options === null || Array.isArray(provider.options))) {
    throw new ManagerError('provider.options must be an object', 'INVALID')
  }
  return structuredClone(provider)
}

function checkDesired(value: unknown): BotDesiredRunState {
  if (value !== 'running' && value !== 'stopped') throw new ManagerError('desiredState must be "running" or "stopped"', 'INVALID')
  return value
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
