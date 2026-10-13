/**
 * Human handoff — pause the bot in one chat while a human agent takes over.
 *
 * While a chat is handed off the Dispatcher's routing gate is closed for it:
 *  - inbound messages are STILL persisted, `before('message')` / `after('message')`
 *    hooks still run and the `'message'` event still fires (so an integration such
 *    as a Chatwoot relay can forward them to the agent);
 *  - no command, active conversation, dormant checkpoint, matcher or catch-all runs
 *    (and `'command:unknown'` is not emitted), except the escape commands listed in
 *    {@link HandoffConfig.allowCommands} that have a registered handler.
 *
 * Starting a handoff silently cancels every active conversation in that chat (all
 * participants of a group, whatever the `conversationScope`) and drops its dormant
 * checkpoints. `bot.start()` drops them again for every handed-off chat, so a
 * checkpoint persisted before the handoff (handoff made before `start()` or while the
 * bot was stopped, failed clear, crash) never resumes after `bot.resume()`. The state
 * is per chat (`ctx.from` / chatId), so a handoff in a group pauses the bot for every
 * member of that group but not their DMs.
 *
 * Persistence: the state is written to `StoredChat.handoff` (cleared to `null` on
 * resume) and the handed-off chat ids to a small index under the store cursor key
 * {@link HANDOFF_INDEX_KEY}, so `bot.start()` restores them with one read per
 * handed-off chat instead of scanning every chat (stores without cursor support fall
 * back to `listChats()`). It survives restarts with a persistent store. Restore and
 * write failures are reported on the bot's `'error'` event and never fail `start()`;
 * the in-memory state is authoritative for the running process either way.
 * `bot.deleteSubject(userId)` also drops the handoff of the chat `userId`.
 *
 * @example
 * ```ts
 * const bot = new Bot({ provider, handoff: { allowCommands: ['/bot'] } })
 *
 * bot.when('hablar con humano', async (ctx) => {
 *   await ctx.handoff({ reason: 'user request' })   // the bot now ignores this chat
 *   await ctx.reply('Te conecto con un agente…')
 * })
 * bot.command('bot', async (ctx) => { await bot.resume(ctx.from) })   // escape hatch
 *
 * bot.on('handoff', ({ chatId, reason }) => crm.assign(chatId, reason))
 * bot.on('resume', ({ chatId }) => crm.close(chatId))
 * bot.on('message', (ctx) => { if (bot.isHandedOff(ctx.from)) crm.relay(ctx.from, ctx.body) })
 *
 * // The agent answers outside the pipeline:
 * await bot.sendTo(chatId, 'Hola, soy Ana 👋')
 * await bot.resume(chatId)
 * ```
 */

import type { ChatId, StoredChat } from '../core/provider.js'
import { normalizeText } from '../core/matching.js'
import { ConfigValidationError } from '../utils/validateConfig.js'

/** `BotConfig.handoff` — human-handoff behaviour. */
export interface HandoffConfig {
  /**
   * Commands that keep routing while a chat is handed off (e.g. `['/bot']` so the user
   * can call the bot back). Names may include the command prefix or not and are
   * compared like the Dispatcher compares commands (case/diacritic-insensitive). An
   * allowed command only bypasses the gate when a `bot.command()` handler is
   * registered for it — it never falls through to conversations, matchers or the
   * catch-all.
   */
  allowCommands?: string[]
  /**
   * Persist the handoff state in the store (`StoredChat.handoff` + the
   * {@link HANDOFF_INDEX_KEY} index) so it survives a restart. Default `true`. With
   * `false` the state lives in memory only.
   */
  persist?: boolean
}

/** Options for `bot.handoff()` / `ctx.handoff()`. */
export interface HandoffOptions {
  /** Free-form reason, forwarded to the `'handoff'` event and persisted. */
  reason?: string
  /** Host-defined, JSON-serializable metadata (agent id, ticket id, …). Persisted. */
  meta?: Record<string, unknown>
}

/** Options for `bot.resume()`. */
export interface ResumeOptions {
  /** Free-form reason, forwarded to the `'resume'` event (not persisted). */
  reason?: string
}

/** Handoff state as persisted on {@link StoredChat.handoff}. */
export interface StoredHandoff {
  /** Epoch ms when the handoff started. */
  since: number
  reason?: string
  meta?: Record<string, unknown>
}

/** A chat's current handoff state (`bot.getHandoff()` / `bot.listHandoffs()`). */
export interface HandoffState extends StoredHandoff {
  chatId: ChatId
}

/** Payload of the `'handoff'` bot event. */
export type HandoffEvent = HandoffState

/** Payload of the `'resume'` bot event. */
export interface ResumeEvent {
  chatId: ChatId
  /** Epoch ms when the bot resumed. */
  at: number
  /** The reason passed to `bot.resume()`, if any. */
  reason?: string
  /** The handoff that just ended. */
  handoff: HandoffState
}

/**
 * Store cursor key (namespaced per bot by the Bot's store) holding the JSON array of
 * handed-off chat ids that `bot.start()` restores.
 */
export const HANDOFF_INDEX_KEY = 'handoff:index'

/** Validate `BotConfig.handoff`; throws {@link ConfigValidationError}. */
export function validateHandoffConfig(config: unknown): HandoffConfig {
  if (config === undefined || config === null) return {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigValidationError('handoff', 'object', config)
  }
  const { allowCommands, persist } = config as HandoffConfig
  if (allowCommands !== undefined) {
    if (!Array.isArray(allowCommands) || allowCommands.some((c) => typeof c !== 'string' || c.trim() === '')) {
      throw new ConfigValidationError('handoff.allowCommands', 'an array of non-empty strings', allowCommands)
    }
  }
  if (persist !== undefined && typeof persist !== 'boolean') {
    throw new ConfigValidationError('handoff.persist', 'boolean', persist)
  }
  return config as HandoffConfig
}

/** Everything the registry needs from the Bot — injected so this file stays decoupled. */
export interface HandoffDeps {
  store: {
    /**
     * Persist the chat's handoff state on its record. `null` clears it and must not
     * recreate a chat record that does not exist (a deleted subject). The Bot runs it in
     * order with its other writes of the same chat.
     */
    writeHandoff(chatId: ChatId, handoff: StoredHandoff | null): Promise<void>
    getChat(chatId: ChatId): Promise<StoredChat | undefined>
    /** Restore fallback when there is no {@link HandoffDeps.index}. */
    listChats(): Promise<StoredChat[]>
  }
  /**
   * Reads/writes the handed-off chat index ({@link HANDOFF_INDEX_KEY}). Omitted when the
   * store has no cursor support; `load()` then scans `listChats()`.
   */
  index?: { get(): Promise<string | undefined>; set(value: string): Promise<void> }
  config?: HandoffConfig
  commandPrefix?: string
  /** Is a `bot.command()` handler registered under this (normalized) name? */
  hasCommand(name: string): boolean
  /** Silently cancel every conversation (active + dormant) in a chat. */
  abortChat(chatId: ChatId): void
  emit(event: 'handoff', payload: HandoffEvent): void
  emit(event: 'resume', payload: ResumeEvent): void
  /** Route a non-fatal error (store read/write, throwing listener) to the bot's error channel. */
  reportError(error: unknown): void
  logger?: { debug?: (...a: unknown[]) => void }
}

function assertChatId(chatId: unknown, method: string): asserts chatId is ChatId {
  if (typeof chatId !== 'string' || chatId.length === 0) {
    throw new TypeError(`${method}() expects a non-empty chat id string`)
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Build a state without `undefined` keys (stores such as Mongo would persist them as null). */
function makeState(chatId: ChatId, since: number, reason: unknown, meta: unknown): HandoffState {
  const state: HandoffState = { chatId, since }
  if (typeof reason === 'string') state.reason = reason
  if (isRecord(meta)) state.meta = { ...meta }
  return state
}

function clone(state: HandoffState): HandoffState {
  return makeState(state.chatId, state.since, state.reason, state.meta)
}

function toStored(state: HandoffState): StoredHandoff {
  const { chatId: _chatId, ...stored } = clone(state)
  return stored
}

/** Parse the {@link HANDOFF_INDEX_KEY} value; throws on anything but an array of chat ids. */
function parseIndex(raw: string | undefined): ChatId[] {
  if (raw === undefined) return []
  const ids: unknown = JSON.parse(raw)
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error(`corrupt handoff index (${HANDOFF_INDEX_KEY})`)
  }
  return ids as ChatId[]
}

/**
 * Per-chat handoff state + the Dispatcher's routing gate. Internal: the public
 * surface is `bot.handoff()` / `bot.resume()` / `bot.isHandedOff()` /
 * `bot.getHandoff()` / `bot.listHandoffs()` and `ctx.handoff()`.
 */
export class HandoffRegistry {
  private readonly states = new Map<ChatId, HandoffState>()
  private readonly allowed: Set<string>
  private readonly persist: boolean
  private readonly prefix: string
  /** Store writes (chat record + index), one at a time in call order. Never rejects. */
  private writes: Promise<void> = Promise.resolve()
  /** The in-flight `load()` and the chats changed while it runs (their in-memory state wins). */
  private loading?: { done: Promise<void>; touched: Set<ChatId> }

  constructor(private readonly deps: HandoffDeps) {
    const config = validateHandoffConfig(deps.config)
    this.prefix = deps.commandPrefix ?? '/'
    this.persist = config.persist !== false
    this.allowed = new Set((config.allowCommands ?? []).map((entry) => {
      const name = entry.trim()
      return normalizeText(name.startsWith(this.prefix) ? name.slice(this.prefix.length) : name)
    }))
  }

  /** Is `chatId` currently handed off? */
  has(chatId: ChatId): boolean {
    return this.states.has(chatId)
  }

  /** A snapshot of the chat's handoff state, or `undefined`. */
  get(chatId: ChatId): HandoffState | undefined {
    const state = this.states.get(chatId)
    return state ? clone(state) : undefined
  }

  /** Snapshots of every handed-off chat. */
  list(): HandoffState[] {
    return [...this.states.values()].map(clone)
  }

  /**
   * Start a handoff. The state flips synchronously (so routing is gated even if the
   * caller does not await), conversations in the chat are cancelled silently, the
   * `'handoff'` event fires, then the state is persisted. Resolves `true` when the
   * chat was not already handed off, `false` otherwise (no event, state unchanged).
   * Never rejects: store failures go to the error channel.
   */
  handoff(chatId: ChatId, opts: HandoffOptions = {}): Promise<boolean> {
    assertChatId(chatId, 'handoff')
    if (this.states.has(chatId)) return Promise.resolve(false)
    const state = makeState(chatId, Date.now(), opts.reason, opts.meta)
    this.states.set(chatId, state)
    this.loading?.touched.add(chatId)
    try { this.deps.abortChat(chatId) } catch (error) { this.deps.reportError(error) }
    this.safeEmit(() => this.deps.emit('handoff', clone(state)))
    return this.sync(chatId).then(() => true)
  }

  /**
   * End a handoff: routing resumes immediately, the `'resume'` event fires and the
   * persisted state is cleared. Resolves `true` if the chat was handed off. While
   * `load()` is restoring, a chat it has not restored yet is resumed as soon as the
   * restore finishes (unless the chat was handed off, resumed or forgotten in between).
   * Never rejects: store failures go to the error channel.
   */
  resume(chatId: ChatId, opts: ResumeOptions = {}): Promise<boolean> {
    assertChatId(chatId, 'resume')
    const previous = this.states.get(chatId)
    if (!previous) {
      const loading = this.loading
      if (!loading) return Promise.resolve(false)
      return loading.done.then(() => (loading.touched.has(chatId) ? false : this.resume(chatId, opts)))
    }
    this.states.delete(chatId)
    this.loading?.touched.add(chatId)
    const event: ResumeEvent = { chatId, at: Date.now(), handoff: clone(previous) }
    if (typeof opts.reason === 'string') event.reason = opts.reason
    this.safeEmit(() => this.deps.emit('resume', event))
    return this.sync(chatId).then(() => true)
  }

  /**
   * Drop a chat's handoff without events because the chat's data is being erased
   * (`bot.deleteSubject()`): removes it from memory and from the index and never
   * recreates the chat record. Resolves once persisted; never rejects.
   */
  forget(chatId: ChatId): Promise<void> {
    this.states.delete(chatId)
    this.loading?.touched.add(chatId)
    return this.sync(chatId)
  }

  /**
   * The Dispatcher's routing gate: `true` routes normally, `false` skips every
   * routing stage. Evaluated after `before('message')` hooks.
   */
  admits(ctx: { from: ChatId; body?: string }): boolean {
    if (!this.states.has(ctx.from)) return true
    const command = this.escapeCommand(ctx.body)
    if (command !== undefined && this.deps.hasCommand(command)) return true
    this.deps.logger?.debug?.({ chatId: ctx.from }, 'routing skipped: chat handed off')
    return false
  }

  /**
   * Restore persisted handoffs (called by `bot.start()`). In-memory state wins, including
   * a handoff, resume or forget made while the restore runs. Never rejects: a failing
   * restore is reported on the error channel and leaves the in-memory state as it is.
   */
  load(): Promise<void> {
    if (!this.persist) return Promise.resolve()
    if (this.loading) return this.loading.done
    const touched = new Set<ChatId>()
    const done: Promise<void> = this.restore(touched)
      .catch((error: unknown) => { this.deps.reportError(error) })
      .finally(() => { if (this.loading?.done === done) this.loading = undefined })
    this.loading = { done, touched }
    return done
  }

  private async restore(touched: Set<ChatId>): Promise<void> {
    for (const chat of await this.readPersisted()) {
      const stored: unknown = chat.handoff
      if (!isRecord(stored) || typeof stored.since !== 'number') continue
      if (this.states.has(chat.id) || touched.has(chat.id)) continue
      this.states.set(chat.id, makeState(chat.id, stored.since, stored.reason, stored.meta))
    }
  }

  /** The chat records that may carry a handoff: the indexed ones, or every chat without an index. */
  private async readPersisted(): Promise<StoredChat[]> {
    const { index, store } = this.deps
    if (!index) return store.listChats()
    const chats = await Promise.all(parseIndex(await index.get()).map((id) =>
      store.getChat(id).catch((error: unknown) => { this.deps.reportError(error); return undefined })))
    return chats.filter((chat): chat is StoredChat => chat !== undefined)
  }

  /** The normalized command name when `body` is an allowed escape command. */
  private escapeCommand(body: string | undefined): string | undefined {
    if (this.allowed.size === 0 || typeof body !== 'string' || !body.startsWith(this.prefix)) return undefined
    const [raw] = body.slice(this.prefix.length).trim().split(/\s+/)
    const name = normalizeText(raw ?? '')
    return this.allowed.has(name) ? name : undefined
  }

  private safeEmit(emit: () => void): void {
    try { emit() } catch (error) { this.deps.reportError(error) }
  }

  /**
   * Queue a write of the chat's CURRENT state (record + index). It writes the state as it
   * is when the write runs, not when it was queued, so a late write can never undo a later
   * resume/forget or bring back a deleted chat record.
   */
  private sync(chatId: ChatId): Promise<void> {
    if (!this.persist) return Promise.resolve()
    const run = this.writes.then(() => this.flush(chatId))
    this.writes = run
    return run
  }

  private async flush(chatId: ChatId): Promise<void> {
    const state = this.states.get(chatId)
    if (state) {
      await this.attempt(() => this.deps.store.writeHandoff(chatId, toStored(state)))
      await this.attempt(() => this.updateIndex(chatId, true))
    } else {
      await this.attempt(() => this.updateIndex(chatId, false))
      await this.attempt(() => this.deps.store.writeHandoff(chatId, null))
    }
  }

  private async updateIndex(chatId: ChatId, present: boolean): Promise<void> {
    const index = this.deps.index
    if (!index) return
    // A failed read propagates: never overwrite an index that could not be read.
    const raw = await index.get()
    let ids: Set<ChatId>
    try {
      ids = new Set(parseIndex(raw))
      if (ids.has(chatId) === present) return
    } catch (error) {
      // Corrupt index: report it and rebuild it from the in-memory state.
      this.deps.reportError(error)
      ids = new Set(this.states.keys())
    }
    if (present) ids.add(chatId)
    else ids.delete(chatId)
    await index.set(JSON.stringify([...ids]))
  }

  private async attempt(task: () => Promise<void>): Promise<void> {
    try { await task() } catch (error) { this.deps.reportError(error) }
  }
}
