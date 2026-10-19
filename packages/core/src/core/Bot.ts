/**
 * Bot — public entry point of `@bot-wa/core`.
 *
 * A transport-agnostic bot engine: declarative API (`when`, `flow`, `conversation`,
 * `plug`), hooks (`before`/`after`/`onError`), dependency injection (`provide`) and a
 * scheduler (`schedule`/`every`/`delay`). You inject a transport {@link IProvider}
 * (e.g. `BaileysProvider` from `@bot-wa/baileys`); the Bot drives it through the
 * normalized {@link InboundEvent} / {@link OutboundContent} contract.
 *
 * @example
 * ```ts
 * import { Bot, flow } from '@bot-wa/core'
 * import { BaileysProvider } from '@bot-wa/baileys'
 *
 * const bot = new Bot({ provider: new BaileysProvider({ session: 'demo' }) })
 * bot.on('ready', () => bot.logger.info('connected'))
 * bot.when('hola', async (ctx) => await ctx.reply('¡Hola! 👋'))
 * await bot.start()
 * ```
 */

import { EventEmitter } from 'events'
import pino, { type Logger } from 'pino'

import type {
  BotConfig,
  ChatId,
  UserId,
  ConnectionState,
  ConnectionUpdate,
  DefaultTools,
  HookEvent,
  HookHandler,
  HookPhase,
  IProvider,
  InboundEvent,
  InboundInteraction,
  InboundMessage,
  InboundReaction,
  PollVote,
  GroupEvent,
  PresenceEvent,
  CallEvent,
  DeliveryStatus,
  MessageContext,
  MessageRef,
  MessageType,
  OutboundContent,
  Plugin,
  PluginContext,
  ScheduledTask,
  DurableTaskHandler,
  DurableTaskOptions,
  SendOptions,
  SendResult,
  SentMessage,
  StoredMessage,
  StoredChat,
  StoredContact,
  Trigger,
} from './types.js'

import { HookSystem } from '../hooks/HookSystem.js'
import { MemoryStore } from '../store/MemoryStore.js'
import { NamespacedStore, type StoreNamespace } from '../store/NamespacedStore.js'
import type { IStore } from '../store/IStore.js'
import { Dispatcher, type DispatchContext } from './Dispatcher.js'
import { buildMessageContext } from './context.js'
import { ExternalSendClock, createPacer, isEditableSend, messagingSupport, normalizeTypingConfig, type Pacer, type ReplyOptions } from './messaging.js'
import type { BuildContextDeps } from './provider.js'
import { createInboundDeduper, type InboundDeduper } from './dedupe.js'
import { ConversationRuntime, type CheckpointStore, type ConversationFn } from '../conversations/ConversationRuntime.js'
import type { ConversationSnapshot } from '../conversations/ConversationRuntime.js'
import { createControls, type ConversationControls } from '../conversations/controls.js'
import type { ConversationHandler } from '../conversations/handler.js'
import { ChatIdleWatchers, type IdleHandler } from './idle.js'
import { FlowBuilder, isCompiledFlow, type CompiledFlow } from '../flows/FlowBuilder.js'
import { Scheduler } from '../scheduler/Scheduler.js'
import { createBotScheduler } from '../scheduler/botScheduler.js'
import { parseTimerDuration, randomId } from '../utils/timers.js'
import { validateConfig } from '../utils/validateConfig.js'
import { FlowRouteLog, isDurableStore, type FlowInventory } from '../flows/inventory.js'
import { describeFlows, type DescribeOptions, type FlowGraph } from '../flows/describe.js'
import { lintFlows, type LintDiagnostic, type LintOptions } from '../flows/lint.js'
import { AccessList, Whitelist, checkAccess, type AccessListSnapshot, type AccessListsSnapshot, type WhitelistSnapshot } from '../gates/accessList.js'
import { KeyedQueue } from '../utils/keyedQueue.js'
import { definedFields } from '../utils/definedFields.js'
import { HANDOFF_INDEX_KEY, HandoffRegistry, type HandoffEvent, type HandoffOptions, type HandoffState, type ResumeEvent, type ResumeOptions, type StoredHandoff } from '../gates/handoff.js'
import { WelcomeTracker } from './welcome.js'
import { DynamicFlowRegistry, type FlowTriggerOptions, type FlowTriggerTarget, type RegisteredFlowInfo } from './flowRegistry.js'
import { callToInbound, RecentIds } from './calls.js'
import { UserDataService } from '../user/UserDataService.js'
import type { UserData } from '../user/types.js'
import type { DraftOptions } from './provider.js'
import { MetricsCollector, type BotMetricsSnapshot, type ConversationEndedEvent, type ConversationStartedEvent } from '../ops/metrics.js'
import { runBroadcast, type BroadcastOptions, type BroadcastResult } from '../ops/broadcast.js'
import { deleteSubjectData, exportSubjectData, type SubjectDataDeps, type SubjectDataExport, type SubjectDeletionResult } from './subjectData.js'
import { MessageLog, receiveTimestamp, toStoredError } from './ledger.js'
import { assertTriggerArgs, triggerInbound, type TriggerOptions, type TriggerResult } from '../ops/trigger.js'
import { I18n } from '../i18n/I18n.js'
import type { I18nConfig, LocaleMessages, TranslateParams } from '../i18n/types.js'

/** A user message handler — receives the full inbound {@link MessageContext}. */
export type MessageHandler = (ctx: MessageContext) => unknown | Promise<unknown>
/** A slash-command handler — receives the context plus the parsed argument list. */
export type CommandHandler = (ctx: MessageContext, args: string[]) => unknown | Promise<unknown>

/** Tiny helper to keep a list of unsubscribers. */
class DisposableList {
  private list: Array<() => void> = []
  add(fn: () => void) { this.list.push(fn) }
  disposeAll() { while (this.list.length) this.list.pop()!() }
}

export interface BotEvents {
  /** Emitted once the provider's connection state reaches `'ready'`. */
  ready: void
  /** Emitted with the provider's auth artifact (QR string / pairing code / OAuth URL). */
  qr: string
  /** Emitted on every provider connection-state transition. */
  connection: ConnectionUpdate
  /** Emitted after every dispatched inbound message finishes its pipeline. */
  message: MessageContext
  /** Emitted for any internal/handler error. */
  error: { error: unknown; ctx?: MessageContext }
  /** Emitted once `start()` finishes. */
  started: void
  /** Emitted once `stop()` finishes. */
  stopped: void
  /** Emitted by the Dispatcher for an unrecognized `/xyz` command. */
  'command:unknown': { ctx: MessageContext; command: string }
  /** Forwarded provider event: someone reacted to a message. */
  reaction: InboundReaction
  /** Forwarded provider event: a poll's aggregated votes changed. */
  poll: PollVote
  /** Forwarded provider event: a call notification. */
  call: CallEvent
  /** Forwarded provider event: group participants changed. */
  group: GroupEvent
  /** Forwarded provider event: a contact's presence changed. */
  presence: PresenceEvent
  /** Forwarded provider event: outbound delivery/read receipt. */
  status: DeliveryStatus
  /** A chat was handed off to a human (`bot.handoff()` / `ctx.handoff()`). */
  handoff: HandoffEvent
  /** A handed-off chat was given back to the bot (`bot.resume()`). */
  resume: ResumeEvent
  /** A conversation/flow was entered (trigger match, `bot.trigger()`, dormant resume, `c.goto()`). */
  'conversation:started': ConversationStartedEvent
  /** A conversation/flow ended — completed, cancelled, timed out, out of retries or errored. */
  'conversation:ended': ConversationEndedEvent
}

export type BotEventArgs<K extends keyof BotEvents> = BotEvents[K] extends void ? [] : [BotEvents[K]]

/** Options of {@link Bot.stop}. */
export interface StopOptions {
  /** Wait for in-flight sends to complete before stopping (default `false`). */
  drain?: boolean
  /** Max time to wait for the drain before forcing the stop: a duration (`'5s'`) or ms. Default `10000`. */
  timeout?: string | number
}

/**
 * Identifies one conversation: the chat, the participant and whether it is a group
 * (group conversations are per participant by default). Every inbound
 * {@link MessageContext} satisfies it, so `ctx` can be passed as-is.
 */
export interface ConversationTarget {
  from: ChatId
  sender: UserId
  isGroup: boolean
}

export type { SubjectDataExport, SubjectDeletionResult } from './subjectData.js'

export class Bot extends EventEmitter {
  readonly logger: Logger

  private config: BotConfig
  private hooks: HookSystem
  private store: IStore
  private provider: IProvider
  private namespace: StoreNamespace
  /** `ctx.user` profiles — one service so writes of a user serialise across chats. */
  private users: UserDataService
  private runtime: ConversationRuntime
  private dispatcher: Dispatcher
  /** Inbound idempotency guard (`BotConfig.dedupe`); `null` when disabled. */
  private inboundDedupe: InboundDeduper | null
  private scheduler = new Scheduler()
  /** Per-chat inactivity watchers ({@link onIdle}); backed by the scheduler. */
  private idle = new ChatIdleWatchers({
    events: this,
    delay: (ms, fn) => this.scheduler.delay(ms, fn),
    isActive: () => this.acceptingInbound,
    isSuspended: (chatId) => this.isChatHandedOff(chatId),
    onError: (error, ctx) => this.emitError({ error, ctx }),
  })
  private tools: Record<string, unknown> = {}
  private disposables = new DisposableList()
  private isStarted = false
  private acceptingInbound = false
  private lifecycleQueue: Promise<void> = Promise.resolve()
  private connState: ConnectionState = 'closed'
  /** In-flight outbound sends — tracked so `stop({ drain: true })` can wait for them. */
  private inflightSends = new Set<Promise<unknown>>()
  /** Trigger routes, kept for `describe()` / `lint()` introspection. */
  private flowRoutes = new FlowRouteLog()
  /** Store-backed first-contact state for the `WELCOME` trigger. */
  private welcome: WelcomeTracker
  /** Call ids already handed to `CALL` triggers (fire once per call). */
  private seenCalls = new RecentIds()
  /** Provider events still being handled (stored, dispatched) — see {@link isBusy}. */
  private inflightEvents = new Set<Promise<void>>()

  /** Resolves when the bot reaches the `'ready'` connection state. */
  readonly ready: Promise<void>

  /**
   * Senders/chats whose inbound messages are dropped before anything else (not
   * persisted, no hooks, no routing, no `'message'` event). Ids are matched exactly
   * against `ctx.sender` and `ctx.from`. See {@link AccessList}.
   */
  readonly blacklist = new AccessList('blacklist')
  /**
   * When enabled, only senders/chats on this list are processed (the blacklist
   * still wins). Disabled by default. See {@link Whitelist}.
   */
  readonly whitelist = new Whitelist()
  private handoffs: HandoffRegistry
  /** Serializes this bot's chat upserts per chat (see {@link persistChat}). */
  private chatWrites = new KeyedQueue()
  /** The outbound message log: ledger rows, edits and delivery receipts (see ledger.ts). */
  private messageLog: MessageLog
  /** Sends outside a chat's own `ctx` replies — they invalidate `ctx.edit(content)` targets. */
  private externalSends = new ExternalSendClock()
  /** Delay + typing-indicator pacing for ctx text replies (`BotConfig.typing`). */
  private pacer: Pacer
  /**
   * Paced replies may still go out once their wait ends. Opened by `start()`, closed by
   * `stop()` after the optional drain — a reply waiting on its typing indicator past that
   * point is dropped instead of hitting a stopped provider.
   */
  private pacedSendsOpen = false
  /**
   * Aborted by `stop()` when {@link pacedSendsOpen} closes (after the optional drain): wakes
   * paced replies still waiting and cancels running `ctx.stream()`s, so no timer outlives stop.
   */
  private sendsAbort = new AbortController()
  /** Runtime counters behind {@link metrics}. */
  private counters = new MetricsCollector()
  /** Aborted by {@link stop}: cancels running broadcasts so nothing is sent through a stopped provider. */
  private lifecycleAbort = new AbortController()
  /** Locale registry behind `bot.locale()` / `ctx.t()` (see i18n/I18n.ts). */
  private i18n: I18n
  /** `ctx.lang` as `prepare` resolved it, to tell whether a hook overrode it. */
  private preparedLang = new WeakMap<object, string>()
  /** Runtime flow CRUD (`registerFlow`/`unregisterFlow`/`replaceFlow`/`triggerFlow`). */
  private flowRegistry: DynamicFlowRegistry
  /** Names of the plugins currently plugged (with a count), for `PluginSpec.requires`. */
  private readonly pluggedNames = new Map<string, number>()

  constructor(config: BotConfig) {
    super()
    validateConfig(config)
    if (!config.provider) {
      throw new Error(
        'Bot requires a transport provider. Construct one and pass it: ' +
          "new Bot({ provider: new BaileysProvider({ session: 'demo' }) }). " +
          'See @bot-wa/baileys for the WhatsApp transport.',
      )
    }
    this.config = { commandPrefix: '/', ...config }
    this.provider = config.provider
    this.inboundDedupe = createInboundDeduper(config.dedupe)

    this.logger = config.logger as Logger ?? pino({
      // 'warn' by default so plugin/handler failures logged at warn stay visible.
      level: config.debug ? 'debug' : 'warn',
    })

    this.hooks = new HookSystem(this.logger.child({ module: 'hooks' }))
    this.pacer = createPacer({
      provider: this.provider,
      typing: normalizeTypingConfig(config.typing),
      logger: this.logger,
      signal: () => this.sendsAbort.signal,
    })

    // Store — injected instance, or the built-in MemoryStore. Every key is
    // namespaced so sharing one backend across bots cannot collide.
    const baseStore =
      (typeof this.config.store === 'object' && this.config.store !== null
        ? (this.config.store as IStore)
        : null) ??
      new MemoryStore({
        file: (this.config.storeConfig as { file?: string } | undefined)?.file,
        maxMessagesPerChat: (this.config.storeConfig as { maxMessagesPerChat?: number } | undefined)?.maxMessagesPerChat,
        autoSaveInterval: (this.config.storeConfig as { autoSaveInterval?: number } | undefined)?.autoSaveInterval,
        logger: this.logger.child({ module: 'store' }),
      })
    this.namespace = {
      tenantId: this.config.tenantId ?? 'local',
      environmentId: this.config.environmentId ?? 'default',
      botId: this.config.botId ?? this.config.session ?? this.provider.id,
      providerId: this.provider.id,
      connectionId: this.config.connectionId ?? this.config.session ?? 'default',
    }
    if (baseStore instanceof NamespacedStore) {
      this.store = baseStore
      this.namespace = baseStore.namespace
    } else {
      this.store = new NamespacedStore(baseStore, this.namespace)
    }
    // Durable scheduler tasks (opt-in): only replaced when `BotConfig.scheduler` is set.
    if (config.scheduler) this.scheduler = createBotScheduler(config.scheduler, this.namespace)
    this.messageLog = new MessageLog({
      store: this.store,
      namespace: this.namespace,
      selfId: () => this.provider.selfId ?? undefined,
      persistChat: (chat) => this.persistChat(chat),
      reportError: (error) => this.emitError({ error }),
    })
    this.users = new UserDataService(this.store, { logger: this.logger.child({ module: 'user-data' }) })
    this.i18n = new I18n({ logger: this.logger.child({ module: 'i18n' }) })
    if (this.config.i18n !== undefined) this.i18n.configure(this.config.i18n)

    const conv = this.config.conversation ?? {}
    this.runtime = new ConversationRuntime({
      controlsFactory: createControls,
      defaultTimeoutMs: conv.timeout !== undefined ? parseTimerDuration(conv.timeout, 'conversation.timeout') : undefined,
      timeoutMessage: conv.timeoutMessage,
      retriesMessage: conv.retriesMessage,
      errorMessage: conv.errorMessage,
      cancelledMessage: conv.cancelledMessage,
      scope: this.config.conversationScope === 'chat' ? 'chat' : 'participant',
      logger: this.logger.child({ module: 'conversations' }),
      onError: (error, ctx) => this.emitError({ error, ctx: ctx as unknown as MessageContext }),
      onConversationStart: ({ id, name, key, ctx }) => {
        this.counters.conversationStarted(name)
        this.emitSafely('conversation:started', { id, name, key, chatId: ctx.from, userId: ctx.sender })
      },
      onConversationEnd: ({ id, name, key, ctx, outcome, durationMs, goto }) => {
        this.counters.conversationEnded(name, outcome, durationMs)
        const event: ConversationEndedEvent = {
          id, name, key, chatId: ctx.from, userId: ctx.sender, outcome, completed: outcome === 'completed', durationMs,
        }
        if (goto !== undefined) event.goto = goto
        this.emitSafely('conversation:ended', event)
      },
    })
    if (typeof (this.store as Partial<CheckpointStore>).setCheckpoint === 'function') {
      this.runtime.attachStore(this.store as CheckpointStore)
    }

    this.flowRegistry = new DynamicFlowRegistry({
      runtime: this.runtime,
      enterMatcher: (trigger, target) => this.registerEnterMatcher(trigger, target),
    })

    this.welcome = new WelcomeTracker({ store: this.store, onError: (error) => this.emitError({ error }) })

    this.dispatcher = new Dispatcher({
      hooks: this.hooks,
      runtime: this.runtime,
      commandPrefix: this.config.commandPrefix,
      firstContact: (ctx) => this.welcome.isFirstContact(ctx),
      // A message queued before stop() is dropped when its turn comes after it.
      isOpen: () => this.acceptingInbound,
      logger: this.logger.child({ module: 'dispatcher' }),
      emit: (event, payload) => {
        if (event === 'error') {
          this.emitError(payload as { error: unknown; ctx?: MessageContext })
          return this.listenerCount('error') > 0
        }
        return this.emit(event, payload)
      },
      gate: (ctx) => {
        const admitted = this.handoffs.admits(ctx)
        if (!admitted) this.counters.handoffDropped()
        return admitted
      },
      prepare: async (ctx) => {
        if (!this.i18n.enabled) return
        const mctx = this.asMessage(ctx)
        await this.resolveLang(mctx)
        this.preparedLang.set(mctx, mctx.lang)
      },
      // A before('message') hook rewrote ctx.body (e.g. a voice transcript): let a
      // body-based detector see the final text. Skipped when the language came from a
      // signal the body cannot change (stored preference, provider) or when a hook
      // already set ctx.lang itself.
      reprepare: async (ctx) => {
        if (!this.i18n.enabled || !this.i18n.hasDetector) return
        const mctx = this.asMessage(ctx)
        if (mctx.langSource !== 'detector' && mctx.langSource !== 'default') return
        if (this.preparedLang.get(mctx) !== mctx.lang) return
        await this.resolveLang(mctx)
      },
    })

    // The handoff index lives under a store cursor key; a backend without cursor support
    // makes the registry fall back to scanning listChats() on start.
    const backing = baseStore instanceof NamespacedStore ? baseStore.innerStore : baseStore
    const hasCursors = typeof backing.getCursor === 'function' && typeof backing.setCursor === 'function'
    this.handoffs = new HandoffRegistry({
      store: {
        writeHandoff: (chatId, handoff) => this.writeHandoff(chatId, handoff),
        getChat: (chatId) => this.store.getChat(chatId),
        listChats: () => this.store.listChats(),
      },
      index: hasCursors
        ? {
            get: async () => this.store.getCursor?.(HANDOFF_INDEX_KEY),
            set: async (value) => { await this.store.setCursor?.(HANDOFF_INDEX_KEY, value) },
          }
        : undefined,
      config: this.config.handoff,
      commandPrefix: this.config.commandPrefix,
      hasCommand: (name) => this.dispatcher.hasCommand(name),
      abortChat: (chatId) => { this.runtime.abortChat(chatId) },
      emit: (event: 'handoff' | 'resume', payload: HandoffEvent | ResumeEvent) => { this.emit(event, payload) },
      reportError: (error) => this.emitError({ error }),
      logger: this.logger.child({ module: 'handoff' }),
    })

    this.ready = new Promise<void>((resolve) => {
      const off = this.provider.onEvent((e) => {
        if (e.kind === 'connection' && e.update.state === 'ready') { off(); resolve() }
      })
    })

    this.wireEvents()
  }

  /* =========================================================================
   * TYPED EVENTEMITTER OVERRIDES
   * ====================================================================== */

  override on<K extends keyof BotEvents>(event: K, listener: (...args: BotEventArgs<K>) => void): this
  override on(event: string, listener: (...args: any[]) => void): this
  override on(event: string, listener: (...args: any[]) => void): this { return super.on(event, listener) }

  override once<K extends keyof BotEvents>(event: K, listener: (...args: BotEventArgs<K>) => void): this
  override once(event: string, listener: (...args: any[]) => void): this
  override once(event: string, listener: (...args: any[]) => void): this { return super.once(event, listener) }

  override off<K extends keyof BotEvents>(event: K, listener: (...args: BotEventArgs<K>) => void): this
  override off(event: string, listener: (...args: any[]) => void): this
  override off(event: string, listener: (...args: any[]) => void): this { return super.off(event, listener) }

  override emit<K extends keyof BotEvents>(event: K, ...args: BotEventArgs<K>): boolean
  override emit(event: string, ...args: any[]): boolean
  override emit(event: string, ...args: any[]): boolean { return super.emit(event, ...args) }

  /* =========================================================================
   * LIFECYCLE
   * ====================================================================== */

  start(): Promise<void> {
    return this.enqueueLifecycle(() => this.startOnce())
  }

  private async startOnce(): Promise<void> {
    if (this.isStarted) return
    let storeAttempted = false
    let providerAttempted = false
    try {
      storeAttempted = true
      await this.store.start()
      this.runtime.open()
      await this.runtime.loadDormant()
      await this.handoffs.load()   // never rejects: restore failures go to 'error'
      // A handed-off chat must not resume a checkpoint loadDormant() just brought back:
      // the handoff may predate start() (or have happened while stopped), or its clear
      // failed / never ran before a crash.
      for (const { chatId } of this.handoffs.list()) this.runtime.abortChat(chatId)
      providerAttempted = true
      await this.provider.start()
      const restoring = this.scheduler.start(this.logger.child({ module: 'scheduler' }))
      if (restoring) await restoring   // only with durable tasks: restores their schedules
      if (this.lifecycleAbort.signal.aborted) this.lifecycleAbort = new AbortController()
      if (this.sendsAbort.signal.aborted) this.sendsAbort = new AbortController()
      this.isStarted = true
      this.acceptingInbound = true
      this.pacedSendsOpen = true
      this.counters.markStarted()
      this.emit('started')
    } catch (error) {
      this.acceptingInbound = false
      this.scheduler.stop()
      if (providerAttempted) {
        try { await this.provider.stop() }
        catch (rollbackError) { this.logger.error({ err: rollbackError }, 'provider start rollback failed') }
      }
      if (storeAttempted) {
        try { await this.store.stop() }
        catch (rollbackError) { this.logger.error({ err: rollbackError }, 'store start rollback failed') }
      }
      this.connState = 'closed'
      throw error
    }
  }

  /**
   * Stop the bot. By default aborts conversations and tears down immediately.
   * @param opts.drain - Wait for in-flight sends to complete before stopping (default false).
   * @param opts.timeout - Max time to wait for drain before forcing stop: a duration
   *   (`'5s'`, same grammar as every other duration option) or ms (default 10000).
   */
  stop(opts?: StopOptions): Promise<void> {
    return this.enqueueLifecycle(() => this.stopOnce(opts))
  }

  private async stopOnce(opts?: StopOptions): Promise<void> {
    // Validate before tearing anything down, so a bad duration leaves the bot running.
    const drainTimeout = parseTimerDuration(opts?.timeout ?? 10_000, 'stop() timeout')
    if (!this.isStarted) return
    this.acceptingInbound = false
    // Running broadcasts start no new send from here on; their in-flight sends are
    // in `inflightSends`, so `drain` still waits for them.
    this.lifecycleAbort.abort()
    const releasing = this.scheduler.stop()
    if (releasing) await releasing   // only with a scheduler lease: released before the store closes
    if (opts?.drain && this.inflightSends.size > 0) {
      const timeout = drainTimeout
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled([...this.inflightSends]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, timeout) }),
        ])
      } finally {
        // Drained before the deadline: the deadline timer must not keep the process alive.
        if (timer) clearTimeout(timer)
      }
    }
    this.pacedSendsOpen = false
    this.sendsAbort.abort()
    // Abort every conversation (checkpoints kept) and refuse new ones until start().
    this.runtime.close()
    let stopError: unknown
    try { await this.provider.stop() }
    catch (error) { stopError = error }
    try { await this.store.stop() }
    catch (error) { stopError ??= error }
    this.isStarted = false
    this.connState = 'closed'
    this.counters.markStopped()
    this.emit('stopped')
    if (stopError) throw stopError
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycleQueue.then(operation, operation)
    this.lifecycleQueue = next.catch(() => undefined)
    return next
  }

  /**
   * Send normalized content to any chat (a plain string is sent as text, like
   * {@link broadcast} and {@link sendTo}). Runs the `before('send')`/`after('send')` hook
   * pipeline; a `before('send')` hook may mutate `payload.content` or `abort()` to skip.
   */
  async send(chatId: ChatId, content: string | OutboundContent, options?: SendOptions): Promise<SentMessage> {
    const normalized: OutboundContent = typeof content === 'string' ? { kind: 'text', text: content } : content
    const r = await this.dispatchSend(chatId, normalized, options)
    return { ref: r.ref, id: r.ref.id, chatId: r.ref.chatId, raw: r.raw, skipped: r.skipped }
  }

  /**
   * Central outbound path: `before('send')` (mutable/abortable) → provider.send → `after('send')`.
   * Both {@link send} and every `ctx.reply`/`ctx.photo`/… reply helper route through here
   * (`ctx.edit` uses the twin {@link dispatchEdit}). Any send that is not a `ctx` reply to its
   * own chat (`bot.send`, `sendTo` from a human agent, campaigns) ticks {@link externalSends},
   * so an implicit `ctx.edit(content)` never edits a reply that was followed by it.
   */
  private async dispatchSend(chatId: ChatId, content: OutboundContent, options?: SendOptions, origin: 'ctx' | 'api' = 'api', stream?: 'message'): Promise<SendResult> {
    const payload: { chatId: ChatId; content: OutboundContent; options?: SendOptions; stream?: 'message' } = { chatId, content, options }
    if (stream) payload.stream = stream
    const proceed = await this.hooks.runBefore('send', payload as typeof payload & { abort(): void })
    if (!proceed) {
      return { ref: { id: 'skipped', chatId: payload.chatId }, skipped: true }
    }
    const localRef = { id: randomId('out'), chatId: payload.chatId }
    const op = this.provider.send(payload.chatId, payload.content, payload.options)
    this.inflightSends.add(op)
    try {
      let res: SendResult
      try { res = await op } catch (error) { this.counters.outbound(false); throw error }
      this.counters.outbound(true)
      if (isEditableSend(payload.content)) {
        if (origin !== 'ctx') this.externalSends.mark(payload.chatId)
      }
      await this.hooks.runAfter('send', payload)
      await this.messageLog.outbound({
        ref: res.ref,
        chatId: payload.chatId,
        content: payload.content,
        options: payload.options,
        status: 'sent',
        raw: this.config.persistRaw ? res.raw : undefined,
      })
      return res
    } catch (error) {
      await this.messageLog.outbound({
        ref: localRef,
        chatId: payload.chatId,
        content: payload.content,
        options: payload.options,
        status: 'failed',
        error: toStoredError(error),
      })
      throw error
    } finally {
      this.inflightSends.delete(op)
    }
  }

  /**
   * Edit path behind `ctx.edit`: the same `before('send')` → provider → `after('send')`
   * pipeline as {@link dispatchSend}, with the payload carrying `edit: ref` so hooks can
   * tell edits apart. A hook may rewrite `payload.content` or `abort()` (→ `skipped`).
   * The ledger entry of `ref` is updated in place with the edited content.
   */
  private async dispatchEdit(ref: MessageRef, content: OutboundContent): Promise<SendResult> {
    const payload: { chatId: ChatId; content: OutboundContent; options?: SendOptions; edit: MessageRef } = {
      chatId: ref.chatId, content, options: undefined, edit: ref,
    }
    const proceed = await this.hooks.runBefore('send', payload as typeof payload & { abort(): void })
    if (!proceed) return { ref, skipped: true }
    const op = this.provider.editMessage!(ref, payload.content)
    this.inflightSends.add(op)
    try {
      const res = await op
      await this.hooks.runAfter('send', payload)
      await this.messageLog.edit(ref, payload.content, this.config.persistRaw ? res.raw : undefined)
      return res
    } finally {
      this.inflightSends.delete(op)
    }
  }

  /** Send plain text to a chat. Same as `send(chatId, text)`. */
  async sendText(chatId: ChatId, text: string): Promise<SentMessage> {
    return this.send(chatId, { kind: 'text', text })
  }

  /**
   * Send `content` (a string is sent as text) to many chats: in batches of `batchSize`
   * (default 10) with `concurrency` parallel sends (default 1), pausing `delayBetween`
   * between batches. A `RateLimitedError` pauses the whole broadcast for its
   * `retryAfterMs` and retries that chat (up to `maxRetries`, default 3); other errors
   * are recorded and the broadcast goes on. Abort `signal` to stop early — never-attempted
   * chats come back in `pending`. `bot.stop()` cancels it the same way (with `drain`,
   * stop waits for its in-flight sends), and a broadcast started on a bot that is not
   * started (never started, or stopped) sends nothing. Duplicate ids are sent once. Each send takes the normal
   * outbound path (send hooks, ledger, the provider's rate limiter) but not the
   * dispatcher's per-chat queues, so inbound handling is never blocked; still, launch it
   * with `void` (not `await`) from inside a handler so that chat's queue is not held.
   *
   * @example
   * ```ts
   * const ac = new AbortController()
   * const res = await bot.broadcast(chatIds, '🎉 Nueva promo!', {
   *   batchSize: 10, delayBetween: '2s', signal: ac.signal,
   *   onProgress: (done, total) => bot.logger.info(`${done}/${total}`),
   *   onFail: (chatId, error) => bot.logger.warn({ chatId, err: error }, 'broadcast failed'),
   * })
   * // → { total: 500, sent: 480, failed: 20, skipped: 0, errors: [{ chatId, error }], messages, cancelled: false, pending: [] }
   * ```
   */
  broadcast(chatIds: readonly ChatId[], content: string | OutboundContent, opts?: BroadcastOptions): Promise<BroadcastResult> {
    const outbound: OutboundContent = typeof content === 'string' ? { kind: 'text', text: content } : content
    // Not started yet (or stopped): nothing may go out through a provider that is not running.
    const stopSignal = this.isStarted ? this.lifecycleAbort.signal : AbortSignal.abort()
    const signal = opts?.signal ? AbortSignal.any([opts.signal, stopSignal]) : stopSignal
    return runBroadcast(
      { send: (chatId, c, o) => this.send(chatId, c, o), reportError: (error) => this.emitError({ error }) },
      chatIds,
      outbound,
      { ...opts, signal },
    )
  }

  /**
   * Start a registered flow/conversation for a subject without waiting for them to
   * write — reminders from `bot.schedule()`, webhooks, admin panels. `data` seeds
   * `c.state`. The start goes through the same gates as a message (blacklist /
   * whitelist, human handoff) and the chat's FIFO queue; by default a subject that
   * already has a live or dormant conversation is left alone (`ifActive: 'replace'`
   * cancels it). Resolves once the conversation is entered — not when it ends
   * (listen to `'conversation:ended'` for that). Rejects when `name` is not registered.
   * Safe to `await` from a handler or command of the same chat: the trigger then runs
   * inline in that message's queue slot instead of queuing behind it (which would
   * deadlock the chat). Awaiting a trigger for a DIFFERENT chat whose handlers in turn
   * await a trigger back into this one can still deadlock — launch those with `void`.
   * Before-message hooks, matchers and the `'message'` event do not run, and nothing
   * is persisted for the synthetic inbound (`ctx.raw` is `{ synthetic: 'trigger', name }`).
   *
   * @example
   * ```ts
   * bot.schedule('0 9 * * *', async () => {
   *   for (const cita of await db.citasDeHoy()) {
   *     await bot.trigger('recordatorio', { chatId: cita.chatId, data: { hora: cita.hora } })
   *   }
   * })
   * ```
   */
  async trigger(name: string, opts: TriggerOptions): Promise<TriggerResult> {
    assertTriggerArgs(name, opts)
    if (!this.runtime.has(name)) throw new Error(`Conversation "${name}" is not registered`)
    const inbound = triggerInbound(name, opts)
    const base = { name, chatId: inbound.chatId, userId: inbound.senderId }
    if (!this.acceptingInbound) return { ...base, started: false, reason: 'stopped' }
    if (checkAccess(this.blacklist, this.whitelist, inbound) !== 'allowed') {
      this.counters.blockedDropped()
      return { ...base, started: false, reason: 'blocked' }
    }
    const ctx = this.contextFor(inbound)
    return this.dispatcher.runExclusive(ctx, async (): Promise<TriggerResult> => {
      if (!this.acceptingInbound) return { ...base, started: false, reason: 'stopped' }
      if (!this.handoffs.admits(ctx)) {
        this.counters.handoffDropped()
        return { ...base, started: false, reason: 'handoff' }
      }
      // Same language resolution as an inbound message (Dispatcher `prepare`), in the chat's slot.
      if (this.i18n.enabled) await this.resolveLang(ctx)
      const key = this.runtime.keyFor(ctx)
      if (this.runtime.hasActive(key) || this.runtime.hasDormant(key)) {
        if (opts.ifActive !== 'replace') return { ...base, started: false, reason: 'busy' }
        this.runtime.discardDormant(key)
      }
      // Fire-and-forget: enter() resolves when the conversation ENDS.
      void this.runtime.enter(name, ctx, { state: opts.data })
        .catch((error) => this.emitError({ error, ctx: ctx as unknown as MessageContext }))
      this.counters.triggerStarted()
      return { ...base, started: true }
    })
  }

  /** Resolve `ctx.lang` / `ctx.langSource` (i18n must be enabled). Never rejects. */
  private async resolveLang(ctx: MessageContext): Promise<void> {
    const { lang, source } = await this.i18n.resolveDetailed(ctx)
    ctx.lang = lang
    ctx.langSource = source
  }

  /**
   * Snapshot of the runtime counters: conversations (started/completed/cancelled/
   * timedOut/retriesExceeded/errored, active, mean duration) overall and per flow,
   * messages in/out, inbound drops (duplicate/blocked/handoff), triggers, errors and
   * uptime. In-process only. Render it for Prometheus with `toPrometheus()`.
   */
  metrics(): BotMetricsSnapshot {
    return this.counters.snapshot(this.runtime.activeCount())
  }

  /** Zero every {@link metrics} counter (uptime is kept). */
  resetMetrics(): void { this.counters.reset() }

  /* =========================================================================
   * HUMAN HANDOFF + ACCESS LISTS  (see gates/handoff.ts, gates/accessList.ts)
   * ====================================================================== */

  /**
   * Hand `chatId` over to a human agent. Until {@link resume}, the Dispatcher skips
   * every routing stage for that chat (commands, conversations, dormant resume,
   * matchers, catch-all) except `BotConfig.handoff.allowCommands`; inbound messages
   * are still persisted, hooks still run and the `'message'` event still fires.
   * Active conversations in the chat are cancelled silently and its dormant
   * checkpoints dropped. Emits `'handoff'` and persists the state on
   * `StoredChat.handoff` (survives restarts with a persistent store).
   *
   * The state flips synchronously, so not awaiting is safe. Resolves `true` if the
   * chat was not already handed off; never rejects for store failures (they go to
   * the `'error'` event). Throws `TypeError` synchronously on an empty chat id.
   */
  handoff(chatId: ChatId, opts?: HandoffOptions): Promise<boolean> {
    return this.handoffs.handoff(chatId, opts)
  }

  /**
   * Give a handed-off chat back to the bot: routing resumes immediately, `'resume'`
   * fires and the persisted state is cleared. Resolves `true` if the chat was handed off.
   */
  resume(chatId: ChatId, opts?: ResumeOptions): Promise<boolean> {
    return this.handoffs.resume(chatId, opts)
  }

  /** Is `chatId` currently handed off to a human? */
  isHandedOff(chatId: ChatId): boolean {
    return this.handoffs.has(chatId)
  }

  /** Snapshot of the chat's handoff state (`since`, `reason`, `meta`), or `undefined`. */
  getHandoff(chatId: ChatId): HandoffState | undefined {
    return this.handoffs.get(chatId)
  }

  /** Snapshots of every chat currently handed off. */
  listHandoffs(): HandoffState[] {
    return this.handoffs.list()
  }

  /**
   * Send to a chat from outside the inbound pipeline — typically a human agent's
   * message during a handoff. Same path as {@link send} (`before`/`after('send')`
   * hooks, outbound ledger); it is the same call as {@link send}, named for handoff
   * code. Works whether or not the chat is handed off and never resumes the bot by itself.
   */
  sendTo(chatId: ChatId, content: string | OutboundContent, options?: SendOptions): Promise<SentMessage> {
    return this.send(chatId, content, options)
  }

  /** JSON-serializable snapshot of {@link blacklist} + {@link whitelist} for host persistence. */
  exportAccessLists(): AccessListsSnapshot {
    return { blacklist: this.blacklist.export(), whitelist: this.whitelist.export() }
  }

  /** Restore {@link exportAccessLists} output. Lists missing from `snapshot` are left untouched. */
  loadAccessLists(snapshot: {
    blacklist?: AccessListSnapshot | readonly string[]
    whitelist?: Partial<WhitelistSnapshot> | readonly string[]
  }): this {
    if (snapshot.blacklist) this.blacklist.load(snapshot.blacklist)
    if (snapshot.whitelist) this.whitelist.load(snapshot.whitelist)
    return this
  }

  /* =========================================================================
   * DECLARATIVE API
   * ====================================================================== */

  /**
   * Route messages matching `trigger` (text, `RegExp`, function, type trigger such as
   * `IMAGE`, `WELCOME`, or an array) to a handler or a flow. Returns an unsubscriber.
   */
  when(trigger: Trigger, handler: MessageHandler | FlowBuilder | CompiledFlow): () => void {
    if (handler instanceof FlowBuilder) {
      const compiled = handler.compile()
      this.runtime.registerCompiled(compiled)
      return this.registerEnterMatcher(trigger, compiled.id)
    }
    if (isCompiledFlow(handler)) {
      this.runtime.registerCompiled(handler)
      return this.registerEnterMatcher(trigger, handler.id)
    }
    const fn = handler
    const unmatch = this.dispatcher.matcher(trigger, (ctx) => fn(this.asMessage(ctx)))
    const unroute = this.flowRoutes.add(trigger)
    const unsub = () => { unmatch(); unroute() }
    this.disposables.add(unsub)
    return unsub
  }

  /**
   * Register an async conversation, entered when `opts.trigger` (default: `name`) matches.
   * `ctx` is the full {@link MessageContext} of the triggering message (`ctx.tools`, media
   * helpers, `react`…); `c` offers `ask`/`waitText`/`waitMedia`/`choose`, `retry()`,
   * `idle()`/`idleClear()`, `end(farewell?)` and `goto(name)`.
   *
   * @example
   * ```ts
   * bot.conversation('ahorcado', async (c, ctx) => {
   *   c.idle('2m', () => c.end('⏰ Te desconecté por inactividad'))
   *   let letra = await c.ask('Escribe una letra')
   *   while (letra.length !== 1) letra = await c.retry('❌ Solo una letra')
   *   await ctx.react('✅')
   * })
   * ```
   */
  conversation(name: string, fn: ConversationHandler, opts?: { trigger?: Trigger }): () => void {
    this.runtime.register(name, fn as ConversationFn)
    return this.registerEnterMatcher(opts?.trigger ?? name, name)
  }

  /**
   * Enter a conversation programmatically for the chat (or group participant) of `ctx` —
   * either a registered one by name or an inline {@link ConversationHandler}.
   *
   * Fire-and-forget by design: it returns immediately, so a handler can start a
   * conversation and return, releasing the chat's FIFO queue for the user's next
   * message (which the conversation then receives). Any conversation already active
   * on that key is replaced. Failures (e.g. an unknown name) are reported through
   * the `'error'` event, never as an unhandled rejection.
   *
   * The returned promise settles (it never rejects) once the conversation has ended
   * and released its key. Never `await` it inside a handler: that blocks the chat's
   * queue, so the user's answer could never reach the conversation.
   *
   * @example
   * ```ts
   * bot.when('pedido', async (ctx) => {
   *   bot.enterConversation(async (c) => {
   *     const ok = await c.ask('¿Confirmas? (sí/no)')
   *     await c.say(ok === 'sí' ? 'Hecho' : 'Cancelado')
   *   }, ctx)
   * })
   * ```
   */
  enterConversation(target: string | ConversationHandler, ctx: MessageContext): Promise<void> {
    const fn = typeof target === 'string' ? target : (target as ConversationFn)
    return this.runtime.enter(fn, ctx as unknown as Parameters<ConversationRuntime['enter']>[1])
      .catch((error) => this.emitError({ error, ctx }))
  }

  /**
   * Register flows and/or plugins (an array is accepted). Chainable; to remove one later
   * use the unsubscriber of {@link plug} or {@link unregisterFlow}.
   */
  use(item: FlowBuilder | CompiledFlow | Plugin | Array<FlowBuilder | CompiledFlow | Plugin>): this {
    const items = Array.isArray(item) ? item : [item]
    for (const i of items) {
      if (i instanceof FlowBuilder) {
        const compiled = i.compile()
        this.runtime.registerCompiled(compiled)
        this.registerEnterMatcher(compiled.trigger, compiled.id)
      } else if (isCompiledFlow(i)) {
        this.runtime.registerCompiled(i)
        this.registerEnterMatcher(i.trigger, i.id)
      } else if (isPluginSpec(i)) {
        this.plug(i)
      } else {
        throw new Error('use() expects a FlowBuilder, CompiledFlow or Plugin')
      }
    }
    return this
  }

  /** Same as `use(flow)`, typed for a single flow. */
  useFlow(flow: FlowBuilder | CompiledFlow): this { return this.use(flow) }

  /** Register a `/name` command (wins over an active conversation). Returns an unsubscriber. */
  command(name: string, handler: CommandHandler): () => void {
    const unsub = this.dispatcher.command(name, (ctx, args) => handler(this.asMessage(ctx), args))
    this.disposables.add(unsub)
    return unsub
  }

  /**
   * Catch-all handler: receives the messages no command, conversation or matcher took.
   * Not to be confused with `bot.on('message', …)`, the event that observes every
   * inbound message. Returns an unsubscriber.
   */
  onMessage(handler: MessageHandler): () => void {
    const unsub = this.dispatcher.catchAll((ctx) => handler(this.asMessage(ctx)))
    this.disposables.add(unsub)
    return unsub
  }

  /**
   * Handle every message of one {@link MessageType}. `onImage`, `onAudio`, … are
   * shorthands for it. Returns an unsubscriber.
   */
  onType(type: MessageType, handler: MessageHandler): () => void {
    const unsub = this.dispatcher.onType(type, (ctx) => handler(this.asMessage(ctx)))
    this.disposables.add(unsub)
    return unsub
  }
  onImage(handler: MessageHandler) { return this.onType('image', handler) }
  onAudio(handler: MessageHandler) { return this.onType('audio', handler) }
  onVideo(handler: MessageHandler) { return this.onType('video', handler) }
  onDocument(handler: MessageHandler) { return this.onType('document', handler) }
  onSticker(handler: MessageHandler) { return this.onType('sticker', handler) }
  onLocation(handler: MessageHandler) { return this.onType('location', handler) }
  onContact(handler: MessageHandler) { return this.onType('contact', handler) }
  onPoll(handler: MessageHandler) { return this.onType('poll', handler) }

  /* =========================================================================
   * DYNAMIC FLOW REGISTRY (manager)
   * ====================================================================== */

  /**
   * Register a flow at runtime (same as `use(flow)`, but refuses a duplicate id).
   * Returns the flow id. See {@link replaceFlow} to hot-swap an existing one.
   *
   * @example
   * ```ts
   * bot.registerFlow(flow('encuesta').ask('¿Tu nombre?', 'name').say((_ctx, c) => `Gracias ${c.state.name}`))
   * ```
   */
  registerFlow(flow: FlowBuilder | CompiledFlow): string { return this.flowRegistry.register(flow) }

  /**
   * Remove a flow or conversation by id: its triggers stop matching. Conversations already
   * running finish on the version they entered with. Returns `false` when unknown.
   */
  unregisterFlow(id: string): boolean { return this.flowRegistry.unregister(id) }

  /**
   * Hot-swap the flow registered under `id` (registers it when absent). The new flow keeps
   * `id` whatever its own id is; its trigger replaces the old one. Running conversations
   * keep the old version; persisted checkpoints resume on the new steps (by step index).
   */
  replaceFlow(id: string, flow: FlowBuilder | CompiledFlow): void { this.flowRegistry.replace(id, flow) }

  /** Whether a flow or conversation is registered under `id`. */
  hasFlow(id: string): boolean { return this.flowRegistry.has(id) }

  /** Every live flow (`kind: 'flow'`) and async conversation (`kind: 'conversation'`). */
  listFlows(): RegisteredFlowInfo[] { return this.flowRegistry.list() }

  /**
   * Start flow `id` proactively in a chat, without an inbound message (the user's replies
   * then flow into it as usual). A thin wrapper over {@link trigger} with
   * `ifActive: 'replace'` — same access-list and handoff gates, per-chat FIFO slot,
   * language resolution, messaging seams and metrics — so it replaces a conversation
   * already running (or dormant) on the same key. Resolves `false` when the flow is
   * unknown, the subject is refused by the access lists (blacklist / whitelist) or the
   * chat is handed off; rejects when the bot is not started.
   */
  async triggerFlow(id: string, target: FlowTriggerTarget, opts: FlowTriggerOptions = {}): Promise<boolean> {
    if (!this.acceptingInbound) throw new Error('triggerFlow() needs a started bot')
    if (!this.runtime.has(id)) return false
    const result = await this.trigger(id, {
      chatId: target.chatId,
      ...(target.userId !== undefined ? { userId: target.userId } : {}),
      isGroup: target.isGroup === true,
      ...(opts.state ? { data: opts.state } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ifActive: 'replace',
    })
    if (result.reason === 'stopped') throw new Error('triggerFlow() needs a started bot')
    return result.started
  }

  /** Snapshots of every live conversation (`key`, `state`, `waiting`, `queued`). */
  listConversations(): ConversationSnapshot[] { return this.flowRegistry.conversations() }

  /**
   * Cancel the live conversation of `target` (a {@link ConversationTarget}, e.g. a `ctx`,
   * or a raw runtime key from {@link listConversations}). Returns `false` when none is live.
   */
  abortConversation(target: string | ConversationTarget): boolean {
    if (typeof target !== 'string') return this.runtime.abort(this.runtime.keyFor(target))
    return this.runtime.abort(target)
  }

  /**
   * Re-arm the `WELCOME` trigger so the subject's next message is treated as a
   * first contact again (persisted in the store, so it survives restarts).
   *
   * - `resetWelcome(dmChatId)` — the user of that DM.
   * - `resetWelcome(groupId, userId)` — one participant of a group.
   * - `resetWelcome(groupId)` — every participant of that group.
   *
   * Called from a handler of the same chat it is ordered with that chat's
   * messages (the dispatcher's FIFO); called from elsewhere it races like any
   * last-writer-wins store write. Rejects if the store write fails (the
   * in-process state is re-armed regardless). `slashCommandsPlugin` calls it on `/reset`.
   *
   * @example
   * ```ts
   * bot.command('bienvenida', async (ctx) => {
   *   await bot.resetWelcome(ctx.from, ctx.isGroup ? ctx.sender : undefined)
   *   await ctx.reply('Listo: tu próximo mensaje recibirá la bienvenida otra vez.')
   * })
   * ```
   */
  resetWelcome(chatId: ChatId, userId?: UserId): Promise<void> {
    return this.welcome.reset(chatId, userId)
  }

  /**
   * Read-only snapshot of the live conversation for a chat (and participant, in
   * groups): captured `c.state`, whether it waits for a reply. `undefined` when
   * none is active. Diagnostics only — e.g. `bot-wa dev`'s `:state` command.
   */
  inspectConversation(target: ConversationTarget): ConversationSnapshot | undefined {
    return this.runtime.inspect(this.runtime.keyFor(target))
  }

  /**
   * True while the bot is still reacting to what it received: a provider event
   * is being stored or dispatched to its handlers (e.g. one awaiting an AI
   * call), or a conversation is running a step instead of waiting for the
   * user's reply. Work a handler starts without awaiting it is not tracked.
   * Diagnostics only — `bot-wa dev` uses it to wait for slow replies when its
   * input is piped.
   */
  isBusy(): boolean {
    return this.inflightEvents.size > 0 || this.runtime.hasRunning()
  }

  /* =========================================================================
   * HOOKS
   * ====================================================================== */

  /** Register a `before` hook (higher `priority` runs first). Chainable. */
  before(event: HookEvent, handler: HookHandler, priority = 0): this {
    this.disposables.add(this.hooks.register(event, 'before', handler, priority))
    return this
  }
  /** Register an `after` hook (higher `priority` runs first). Chainable. */
  after(event: HookEvent, handler: HookHandler, priority = 0): this {
    this.disposables.add(this.hooks.register(event, 'after', handler, priority))
    return this
  }
  /** Register an `error`-phase hook. `priority` orders it like {@link before}/{@link after} (default 0). */
  onError(event: HookEvent, handler: HookHandler, priority = 0): this {
    this.disposables.add(this.hooks.register(event, 'error', handler, priority))
    return this
  }
  /** Register a hook for any phase: the generic form of {@link before}/{@link after}/{@link onError}. */
  hook(event: HookEvent, phase: HookPhase, handler: HookHandler, priority = 0): this {
    this.disposables.add(this.hooks.register(event, phase, handler, priority))
    return this
  }

  /* =========================================================================
   * PLUGINS
   * ====================================================================== */

  /**
   * Install a plugin (optionally with `config`). Unlike {@link use}, returns an
   * unsubscriber (not the bot: do not chain) that first calls the plugin's `uninstall()`
   * and then removes, newest first, what it registered through `ctx.bot`: commands,
   * matchers, conversations/flow triggers, hooks, nested plugins, runtime flows and
   * `onDispose` callbacks. Calling it again is a no-op. It does NOT undo event listeners
   * (`on`/`once`), `provide()`d tools, `locale()` messages, `schedule`/`every`/`delay`
   * jobs, `onIdle` handlers or a flow `replaceFlow()` overwrote: undo those in
   * `ctx.onDispose()`.
   *
   * `install()` should be synchronous. If it throws, whatever it registered so far is
   * rolled back and the error is rethrown; if it returns a promise that rejects, the
   * rejection goes to the `'error'` event instead of crashing the process.
   *
   * `spec.requires` lists plugin names that must already be plugged (a nested plugin may
   * require its parent); a missing one throws before `install()` runs. Flows registered
   * through `ctx.bot.registerFlow()` (or created by `ctx.bot.replaceFlow()`) are
   * unregistered on unplug.
   *
   * @throws {Error} when a plugin named in `spec.requires` is not plugged.
   */
  plug(plugin: Plugin, config?: Record<string, unknown>): () => void {
    const spec = typeof plugin === 'function' ? plugin(config) : plugin
    if (!spec || typeof spec !== 'object' || typeof spec.install !== 'function') {
      throw new TypeError(
        'plug() expects a plugin object { name, version, install(ctx) } or a factory returning one, ' +
          `got ${spec === null ? 'null' : typeof spec}`,
      )
    }
    const missing = (Array.isArray(spec.requires) ? spec.requires : [])
      .filter((name) => !this.pluggedNames.has(name))
    if (missing.length > 0) {
      throw new Error(
        `Plugin "${spec.name}" requires plugin(s) ${missing.map((n) => `"${n}"`).join(', ')}, which ` +
          `${missing.length === 1 ? 'is' : 'are'} not plugged. Plug ${missing.length === 1 ? 'it' : 'them'} ` +
          `before "${spec.name}" (PluginSpec.requires).`,
      )
    }
    const disposables: Array<() => void> = []
    const track = <A extends unknown[]>(fn: (...a: A) => () => void) =>
      (...a: A): (() => void) => {
        const un = fn(...a)
        disposables.push(un)
        return un
      }

    const scopedBot = Object.create(this) as Bot
    scopedBot.on = this.on.bind(this) as Bot['on']
    scopedBot.off = this.off.bind(this) as Bot['off']
    scopedBot.once = this.once.bind(this) as Bot['once']
    scopedBot.emit = this.emit.bind(this) as Bot['emit']
    scopedBot.addListener = this.addListener.bind(this) as Bot['addListener']
    scopedBot.removeListener = this.removeListener.bind(this) as Bot['removeListener']
    scopedBot.prependListener = this.prependListener.bind(this) as Bot['prependListener']
    scopedBot.prependOnceListener = this.prependOnceListener.bind(this) as Bot['prependOnceListener']
    scopedBot.command = track(this.command.bind(this))
    scopedBot.when = track(this.when.bind(this))
    scopedBot.onMessage = track(this.onMessage.bind(this))
    scopedBot.onType = track(this.onType.bind(this))
    // `conversation()`, `use(flow)` and `when(trigger, flow)` all route through this one
    // (called on scopedBot), so their trigger routes are disposed with the plugin too.
    scopedBot.registerEnterMatcher = track(this.registerEnterMatcher.bind(this))
    // `use(plugin)` calls `this.plug()`: a nested plugin is unplugged with its parent.
    scopedBot.plug = track(this.plug.bind(this))
    const hook = (event: HookEvent, phase: HookPhase, handler: HookHandler, priority = 0): Bot => {
      disposables.push(this.hooks.register(event, phase, handler, priority))
      return scopedBot
    }
    scopedBot.before = ((event: HookEvent, handler: HookHandler, priority = 0) => hook(event, 'before', handler, priority)) as Bot['before']
    scopedBot.after = ((event: HookEvent, handler: HookHandler, priority = 0) => hook(event, 'after', handler, priority)) as Bot['after']
    scopedBot.onError = ((event: HookEvent, handler: HookHandler, priority = 0) => hook(event, 'error', handler, priority)) as Bot['onError']
    scopedBot.hook = hook as Bot['hook']
    // Flows registered at runtime through ctx.bot are unregistered with the plugin. Tracked by
    // id; an id the plugin unregisters itself is forgotten, so a later bot flow under the same
    // id survives the unplug. replaceFlow() is tracked only when it CREATES the flow.
    const pluginFlows = new Set<string>()
    scopedBot.registerFlow = (f) => {
      const id = this.registerFlow(f)
      pluginFlows.add(id)
      return id
    }
    scopedBot.replaceFlow = (id, f) => {
      const created = !this.hasFlow(id)
      this.replaceFlow(id, f)
      if (created) pluginFlows.add(id)
    }
    scopedBot.unregisterFlow = (id) => {
      pluginFlows.delete(id)
      return this.unregisterFlow(id)
    }
    disposables.push(() => {
      for (const id of pluginFlows) this.unregisterFlow(id)
      pluginFlows.clear()
    })

    const ctx: PluginContext = {
      bot: scopedBot,
      logger: this.logger.child({ plugin: spec.name }),
      tools: this.tools,
      config: config ?? {},
      onDispose: (fn: () => void) => disposables.push(fn),
    }
    const reportAsync = (result: unknown) => {
      if (isThenable(result)) result.then(undefined, (error: unknown) => this.emitError({ error }))
    }
    const disposeRegistrations = () => {
      while (disposables.length) {
        try { disposables.pop()!() } catch (error) { this.emitError({ error }) }
      }
    }

    // Counted before install() so a nested plugin may require its parent.
    this.pluggedNames.set(spec.name, (this.pluggedNames.get(spec.name) ?? 0) + 1)
    const unregisterName = () => {
      const left = (this.pluggedNames.get(spec.name) ?? 1) - 1
      if (left > 0) this.pluggedNames.set(spec.name, left)
      else this.pluggedNames.delete(spec.name)
    }
    try {
      reportAsync(spec.install(ctx, config))
    } catch (error) {
      disposeRegistrations()
      unregisterName()
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      unregisterName()
      if (spec.uninstall) {
        try { reportAsync(spec.uninstall(ctx)) } catch (error) { this.emitError({ error }) }
      }
      disposeRegistrations()
    }
  }

  /* =========================================================================
   * I18N  (see i18n/I18n.ts)
   * ====================================================================== */

  /**
   * Register (deep-merge) the messages of locale `code`, or — with an options
   * object — configure i18n (`defaultLocale`, `detect`, `providerLanguage`,
   * `userKey`, `locales`). Either form turns on per-message language resolution:
   * `ctx.user` preference → provider-reported language → `detect` → default,
   * limited to the `locales` allow-list when one is set.
   * Keys nest (`ctx.t('menu.title')`), `{param}` placeholders are interpolated
   * and `{ one, other, zero? }` leaves pick a plural form from `params.count`.
   * The built-in core messages live under `core.*` (`es` and `en` ship) and
   * can be overridden here. Throws `TypeError` on an invalid code or message tree.
   *
   * @example
   * ```ts
   * bot.locale('es', { greeting: '¡Hola, {name}!', cart: { one: '{count} producto', other: '{count} productos' } })
   * bot.locale('en', { greeting: 'Hello, {name}!', cart: { one: '{count} item', other: '{count} items' } })
   * bot.locale({ defaultLocale: 'es' })
   * bot.when('hola', (ctx) => ctx.reply(ctx.t('greeting', { name: ctx.pushName ?? '' })))
   * bot.command('lang', async (ctx, [code]) => {
   *   if (!code || !bot.locales().includes(code.toLowerCase())) return ctx.reply(bot.locales().join(', '))
   *   await ctx.setLang(code)
   * })
   * ```
   */
  locale(code: string, messages: LocaleMessages): this
  locale(options: I18nConfig): this
  locale(codeOrOptions: string | I18nConfig, messages?: LocaleMessages): this {
    if (typeof codeOrOptions === 'string') this.i18n.add(codeOrOptions, messages as LocaleMessages)
    else this.i18n.configure(codeOrOptions)
    return this
  }

  /**
   * Translate outside a handler (scheduled jobs, broadcasts): `lang` defaults to the
   * default locale. Pair it with {@link langOf} to use a user's stored preference.
   */
  t(key: string, params?: TranslateParams, lang?: string): string {
    return this.i18n.translate(lang ?? this.i18n.defaultLocale, key, params)
  }

  /**
   * The stored language preference of `userId` (`ctx.setLang`) when a registered locale
   * serves it, else the default locale — the same language `ctx.lang` would resolve from
   * the stored value (always the default while i18n is off). A store read failure
   * resolves the default (logged at debug level).
   */
  async langOf(userId: UserId): Promise<string> {
    return this.i18n.languageOf(this.users.for(userId))
  }

  /** Registered locale codes, built-in `es`/`en` included. */
  locales(): string[] { return this.i18n.locales() }

  /* =========================================================================
   * DEPENDENCY INJECTION
   * ====================================================================== */

  provide<T extends string>(name: T, value: unknown): this {
    this.tools[name] = value
    return this
  }

  get injectTools(): DefaultTools & Record<string, unknown> {
    return this.tools as DefaultTools & Record<string, unknown>
  }

  /* =========================================================================
   * SCHEDULER
   * ====================================================================== */

  /** Run `fn` on a cron expression (e.g. `'0 9 * * *'`). */
  schedule(cron: string, fn: () => void | Promise<void>): ScheduledTask
  /**
   * Durable cron task: its schedule is stored under `opts.id` (see `BotConfig.scheduler`),
   * survives restarts with the `opts.missed` policy, and each occurrence runs on one replica.
   */
  schedule(cron: string, opts: DurableTaskOptions, fn: DurableTaskHandler): ScheduledTask
  schedule(cron: string, a: (() => void | Promise<void>) | DurableTaskOptions, b?: DurableTaskHandler): ScheduledTask {
    return typeof a === 'function' ? this.scheduler.cron(cron, a) : this.scheduler.cron(cron, a, b as DurableTaskHandler)
  }
  /** Run `fn` every `interval` (a duration such as `'10m'`, or ms). */
  every(interval: string | number, fn: () => void | Promise<void>): ScheduledTask
  /** Durable interval task (see the durable {@link schedule} overload); slots do not drift. */
  every(interval: string | number, opts: DurableTaskOptions, fn: DurableTaskHandler): ScheduledTask
  every(interval: string | number, a: (() => void | Promise<void>) | DurableTaskOptions, b?: DurableTaskHandler): ScheduledTask {
    return typeof a === 'function' ? this.scheduler.every(interval, a) : this.scheduler.every(interval, a, b as DurableTaskHandler)
  }
  /** Run `fn` once after `duration` (a duration such as `'30s'`, or ms). */
  delay(duration: string | number, fn: () => void | Promise<void>): ScheduledTask
  /**
   * Durable one-shot task: its run time is fixed when `opts.id` is first stored, so a
   * restart does not push it back, provided the code registers the id again at boot (only
   * the schedule is stored, not the handler). See the durable {@link schedule} overload.
   */
  delay(duration: string | number, opts: DurableTaskOptions, fn: DurableTaskHandler): ScheduledTask
  delay(duration: string | number, a: (() => void | Promise<void>) | DurableTaskOptions, b?: DurableTaskHandler): ScheduledTask {
    return typeof a === 'function' ? this.scheduler.delay(duration, a) : this.scheduler.delay(duration, a, b as DurableTaskHandler)
  }
  /**
   * Delete the stored schedule of a durable task `id` (the bot's store namespace is
   * applied, as on registration): an orphan logged at start (stored, no longer registered
   * in code), a one-shot tombstone, or a registered task, which is cancelled as well.
   */
  forgetTask(id: string): Promise<void> { return this.scheduler.forget(id) }

  /* =========================================================================
   * IDLE (per-chat inactivity)
   * ====================================================================== */

  /**
   * Run `handler` once when a chat stays quiet for `duration` (`'10m'`, `'1h'`, `'1d'`, ms…) after
   * its last processed inbound message. Every new inbound message from that chat reschedules it,
   * and re-arms it after it fired. `ctx` is that last message's context, so
   * `ctx.reply('¿Sigues ahí?')` answers in the right chat. Handler errors go to the bot
   * `'error'` event. Pending timers are cancelled by {@link clearIdle}, by the returned
   * unsubscribe and by `stop()`. The handler never runs for a chat in human handoff: a
   * `'handoff'` event carrying `{ chatId }` cancels that chat's timers, and its messages do not
   * re-arm them until a `'resume'` event for that chat (the bot's own `isHandedOff()` state is
   * honoured too, when present). `duration` must be positive and at most 2^31 − 1 ms (about
   * 24.8 days, the longest a Node timer can wait); otherwise it throws `RangeError`.
   *
   * @example
   * ```ts
   * bot.onIdle('10m', async (ctx, { idleMs }) => {
   *   await ctx.reply(`¿Sigues ahí? (${idleMs / 60_000} min sin respuesta)`)
   * })
   * ```
   */
  onIdle(duration: string | number, handler: IdleHandler): () => void {
    return this.idle.add(duration, handler)
  }

  /**
   * Cancel pending {@link onIdle} timers for `chatId` (every chat when omitted) — e.g. when a
   * human agent takes the chat over. They re-arm on that chat's next processed inbound message.
   */
  clearIdle(chatId?: ChatId): void {
    this.idle.clear(chatId)
  }

  /* =========================================================================
   * HELPERS
   * ====================================================================== */

  getStore(): IStore { return this.store }
  getProvider(): IProvider { return this.provider }
  getConnectionState(): ConnectionState { return this.connState }
  getNamespace(): Readonly<StoreNamespace> { return this.namespace }
  getSessionName() { return this.config.session ?? 'default' }

  /**
   * Persistent profile of any subject — the same data a handler sees as
   * `ctx.user` when that subject writes (scheduled jobs, webhooks, admin code).
   * Requires a store implementing the user-data contract (every built-in one).
   *
   * @example
   * ```ts
   * await bot.user('5491122334455').ns('billing').set('plan', 'pro')
   * ```
   */
  user(userId: UserId): UserData { return this.users.for(userId) }

  /**
   * Physically remove expired `ctx.user` entries store-wide and resolve with
   * how many were removed (`0` with native-TTL stores such as Redis). Writes
   * already trigger this at most once a minute; schedule it for idle bots:
   * `bot.every('1h', () => bot.purgeExpiredUserData())`.
   */
  purgeExpiredUserData(): Promise<number> { return this.users.purgeExpired() }

  /** Export normalized data associated with one subject in this bot namespace. */
  exportSubject(userId: UserId): Promise<SubjectDataExport> {
    return exportSubjectData(this.subjectDeps(), userId)
  }

  /**
   * Delete normalized subject data in this bot namespace, including the handoff of chat
   * `userId` and the subject's live or dormant conversations.
   */
  deleteSubject(userId: UserId): Promise<SubjectDeletionResult> {
    return deleteSubjectData(this.subjectDeps(), userId)
  }

  private subjectDeps(): SubjectDataDeps {
    return {
      store: this.store,
      namespace: this.namespace,
      runtime: this.runtime,
      handoffs: this.handoffs,
      chatWrites: this.chatWrites,
      i18n: this.i18n,
      welcome: this.welcome,
      users: this.users,
    }
  }

  /* =========================================================================
   * INTROSPECTION (describe / lint)
   * ====================================================================== */

  /**
   * Read-only snapshot of the registered flows, conversations and trigger routes,
   * plus the bits of config the linter needs. Input of `describeFlows()`/`lintFlows()`.
   */
  flowInventory(): FlowInventory {
    const timeout = this.config.conversation?.timeout
    return {
      registrations: this.runtime.listRegistrations(),
      routes: this.flowRoutes.list(),
      defaultTimeoutMs: timeout !== undefined ? parseTimerDuration(timeout, 'conversation.timeout') : undefined,
      durableStore: isDurableStore(this.store),
    }
  }

  /**
   * Describe every registered flow/conversation as a Mermaid flowchart (default)
   * or, with `{ format: 'json' }`, as a JSON graph. See {@link describeFlows}.
   *
   * @example
   * ```ts
   * writeFileSync('flows.mmd', bot.describe())        // open in mermaid.live or any Mermaid viewer
   * const graph = bot.describe({ format: 'json' })    // { version, flows, groups, nodes, edges }
   * ```
   */
  describe(options: DescribeOptions & { format: 'json' }): FlowGraph
  describe(options?: DescribeOptions & { format?: 'mermaid' }): string
  describe(options?: DescribeOptions): string | FlowGraph
  describe(options?: DescribeOptions): string | FlowGraph { return describeFlows(this, options) }

  /**
   * Statically lint the registered flows: unreachable steps/flows, missing goto
   * targets, empty/duplicate triggers, risky timeouts, ambiguous menus, … See {@link lintFlows}.
   *
   * @example
   * ```ts
   * for (const d of bot.lint({ minSeverity: 'warning' })) bot.logger.warn(d, d.message)
   * ```
   */
  lint(options?: LintOptions): LintDiagnostic[] { return lintFlows(this, options) }

  /* =========================================================================
   * INTERNAL WIRING
   * ====================================================================== */

  private asMessage(ctx: DispatchContext): MessageContext { return ctx as unknown as MessageContext }

  /**
   * The bot's own handoff state for {@link onIdle}: `isHandedOff(chatId)` when this bot has
   * human-handoff support (it is authoritative — it also knows handoffs restored from the store
   * at `start()`, which emit no `'handoff'` event); `false` otherwise. Looked up dynamically so
   * the idle watchers follow whichever handoff implementation (or subclass override) is present.
   */
  private isChatHandedOff(chatId: ChatId): boolean {
    const isHandedOff = (this as unknown as { isHandedOff?: (chatId: ChatId) => unknown }).isHandedOff
    return typeof isHandedOff === 'function' && isHandedOff.call(this, chatId) === true
  }

  /**
   * Upsert a chat record, one write at a time per chat. Stores merge with a non-atomic
   * read-modify-write, so overlapping upserts (inbound, outbound ledger, handoff) could
   * otherwise drop a field such as `handoff`. Undefined fields are omitted: stores read an
   * explicit `undefined` as "unset", which would wipe e.g. a stored name.
   */
  private persistChat(chat: StoredChat): Promise<void> {
    const record = definedFields(chat)
    return this.chatWrites.run(chat.id, () => this.store.upsertChat(record))
  }

  /** Upsert a contact record, omitting undefined fields (same reason as {@link persistChat}). */
  private persistContact(contact: StoredContact): Promise<void> {
    return this.store.upsertContact(definedFields(contact))
  }

  /**
   * Write a chat's handoff state in order with its other upserts. Clearing it (`null`)
   * skips a chat that has no record, so a resume never recreates a deleted chat.
   */
  private writeHandoff(chatId: ChatId, handoff: StoredHandoff | null): Promise<void> {
    return this.chatWrites.run(chatId, async () => {
      if (handoff === null && !(await this.store.getChat(chatId))) return
      await this.store.upsertChat({ id: chatId, handoff })
    })
  }

  private emitError(payload: { error: unknown; ctx?: MessageContext }): void {
    this.counters.error()
    if (this.listenerCount('error') > 0) this.emit('error', payload)
    else this.logger.error({ err: payload.error }, 'unhandled bot error')
  }

  /** Emit an observability event; a throwing listener is reported, never propagated into the runtime. */
  private emitSafely<K extends 'conversation:started' | 'conversation:ended'>(event: K, payload: BotEvents[K]): void {
    try { this.emit(event, ...([payload] as BotEventArgs<K>)) } catch (error) { this.emitError({ error }) }
  }

  private registerEnterMatcher(trigger: Trigger, target: string): () => void {
    // conversationMatcher: a projected event (a call) must never replace a conversation in progress.
    const unmatch = this.dispatcher.conversationMatcher(trigger, (ctx) => {
      void this.runtime.enter(target, ctx).catch((error) => this.emitError({ error, ctx: ctx as unknown as MessageContext }))
    })
    const unroute = this.flowRoutes.add(trigger, target)
    const unsub = this.flowRegistry.track(target, () => { unmatch(); unroute() })
    this.disposables.add(unsub)
    return unsub
  }

  /** Subscribe to the provider's normalized event stream and route each kind. */
  private wireEvents(): void {
    this.disposables.add(this.provider.onEvent((event: InboundEvent) => {
      const task = this.handleProviderEvent(event).catch((error) => this.emitError({ error }))
      this.inflightEvents.add(task)
      void task.finally(() => this.inflightEvents.delete(task))
    }))
  }

  /**
   * Route one provider event. Messages/interactions: access lists → dedupe (runInboundOnce) →
   * persistence → groupMode → Dispatcher; the full order is documented on `Dispatcher.run`.
   */
  private async handleProviderEvent(event: InboundEvent): Promise<void> {
    switch (event.kind) {
      case 'message': {
        if (!this.acceptingInbound || event.message.fromMe) return
        const message = event.message
        if (!this.admitsSender(message)) return
        await this.runInboundOnce(event, () => this.handleInbound(message))
        return
      }
      case 'interaction': {
        if (!this.acceptingInbound) return
        const interaction = event.interaction
        if (!this.admitsSender(interaction)) return
        await this.runInboundOnce(event, () => this.handleInteraction(interaction))
        return
      }
      case 'connection': {
        const u = event.update
        this.connState = u.state
        this.emit('connection', u)
        if (typeof u.authPayload === 'string') this.emit('qr', u.authPayload)
        if (u.state === 'ready') this.emit('ready')
        return
      }
      case 'reaction': await this.dispatchHookEvent('reaction', event.reaction); return
      case 'poll-vote': await this.dispatchHookEvent('poll', event.vote); return
      case 'call': await this.handleCall(event.event); return
      case 'group': await this.dispatchHookEvent('group', event.event); return
      case 'presence': await this.dispatchHookEvent('presence', event.event); return
      case 'status':
        await this.messageLog.receipt(event.status)
        await this.dispatchHookEvent('status', event.status)
        return
    }
  }

  /**
   * Access gate (blacklist/whitelist) for a message or interaction. Runs BEFORE inbound dedupe,
   * so a blocked delivery is never recorded as seen (a redelivery after un-blocking is
   * processed), and before persistence, hooks and routing. Counts and debug-logs the drop.
   */
  private admitsSender(ids: { chatId: ChatId; senderId: UserId }): boolean {
    const access = checkAccess(this.blacklist, this.whitelist, ids)
    if (access === 'allowed') return true
    this.counters.blockedDropped()
    this.logger.debug({ gate: access, chatId: ids.chatId, senderId: ids.senderId }, 'inbound dropped by access list')
    return false
  }

  /**
   * Inbound idempotency gate: a redelivered message/interaction never reaches handlers twice.
   * `handle` resolving `false` (dropped unprocessed because the bot stopped) forgets the key.
   */
  private async runInboundOnce(event: InboundEvent, handle: () => Promise<boolean>): Promise<void> {
    if (!this.inboundDedupe) { await handle(); return }
    await this.inboundDedupe.run(event, handle, () => {
      this.counters.duplicateDropped()
      this.logger.debug({ kind: event.kind }, 'duplicate inbound event dropped')
    })
  }

  /** Persist and dispatch one inbound message; `false` when it was dropped because the bot stopped. */
  private async handleInbound(
    inbound: InboundMessage,
    interaction?: { id: string; data: string; respondBy?: number },
  ): Promise<boolean> {
    // The access lists already admitted this sender (admitsSender, before dedupe).
    this.counters.inbound()
    const timestamp = receiveTimestamp(inbound.timestamp)
    const stored: StoredMessage = {
      ref: inbound.ref,
      chatId: inbound.chatId,
      senderId: inbound.senderId,
      ...this.namespace,
      timestamp,
      type: inbound.type,
      body: inbound.body,
      fromMe: inbound.fromMe,
      direction: 'inbound',
      status: 'received',
      quoted: inbound.quoted?.ref,
      ...(inbound.location ? { location: { ...inbound.location } } : {}),
      raw: this.config.persistRaw ? inbound.raw : undefined,
    }
    await Promise.all([
      this.persistChat({
        id: inbound.chatId,
        ...this.namespace,
        kind: inbound.chat.kind,
        name: inbound.chat.name,
        lastMessageAt: timestamp,
        updatedAt: timestamp,
        raw: this.config.persistRaw ? inbound.chat.platformData : undefined,
      }),
      this.persistContact({
        id: inbound.senderId,
        ...this.namespace,
        name: inbound.senderInfo.displayName,
        username: inbound.senderInfo.username,
        phoneNumber: typeof inbound.senderInfo.platformData?.phoneNumber === 'string'
          ? inbound.senderInfo.platformData.phoneNumber
          : undefined,
        updatedAt: timestamp,
        raw: this.config.persistRaw ? inbound.senderInfo.platformData : undefined,
      }),
      this.store.saveMessage(stored),
    ])
    return this.processMessage(inbound, interaction)
  }

  /** Project an interaction (button/slash/callback) into a message-shaped context. */
  private async handleInteraction(it: InboundInteraction): Promise<boolean> {
    const inbound: InboundMessage = {
      ref: it.ref,
      chat: it.chat,
      senderInfo: it.senderInfo,
      from: it.from,
      sender: it.sender,
      chatId: it.chatId,
      senderId: it.senderId,
      isGroup: it.isGroup,
      isBroadcast: false,
      fromMe: false,
      type: 'buttons',
      body: it.data,
      timestamp: it.timestamp,
      mentions: [],
      raw: it.raw,
    }
    return this.handleInbound(inbound, { id: it.interactionId, data: it.data, respondBy: it.respondBy })
  }

  /**
   * Best-effort typing indicator for `ctx.typing()` / `ctx.recording()` / streams: a
   * failing provider indicator (rejected or thrown) is logged at debug and swallowed,
   * so it never aborts the reply it decorates — same policy as the BotConfig.typing pacer.
   */
  private async indicateTyping(chatId: ChatId, state: 'typing' | 'recording' | 'paused'): Promise<void> {
    try {
      await this.provider.typing?.(chatId, state)
    } catch (error) {
      this.logger.debug({ chatId, state, err: error instanceof Error ? error.message : String(error) }, 'typing indicator failed (ignored)')
    }
  }

  /** `false` only when the message was dropped unprocessed because the bot stopped. */
  private async processMessage(inbound: InboundMessage, interaction?: { id: string; data: string; respondBy?: number }): Promise<boolean> {
    const ctx = this.contextFor(inbound, {
      markRead: async (ref) => { await this.provider.markRead?.([ref]) },
      deleteMessage: async (ref) => { await this.provider.deleteMessage?.(ref) },
      downloadMedia: this.provider.downloadMedia ? (ref) => this.provider.downloadMedia!(ref) : undefined,
      acknowledgeInteraction: this.provider.acknowledgeInteraction
        ? (id, text) => this.provider.acknowledgeInteraction!(id, { text })
        : undefined,
      interaction,
    })

    // Group mode filter.
    if (ctx.isGroup && this.config.groupMode && this.config.groupMode !== 'all') {
      const prefix = this.config.commandPrefix ?? '/'
      if (this.config.groupMode === 'mentions') {
        const self = this.provider.selfId ?? null
        const mentioned = self ? ctx.mentions.includes(self) : ctx.mentions.length > 0
        if (!mentioned) return true
      }
      if (this.config.groupMode === 'commands' && !ctx.body.startsWith(prefix)) return true
    }

    this.logger.debug({ from: ctx.from, type: ctx.type }, 'dispatching message')
    return this.dispatcher.dispatch(ctx as unknown as DispatchContext)
  }

  /**
   * The {@link MessageContext} of an inbound message — real, a projected call or the
   * synthetic one of {@link trigger} — wired to every seam this bot offers (sends through
   * the hook pipeline, typing, handoff, `ctx.user`, i18n, pacing, edits, streaming,
   * native forms). `extra` adds the seams that only make sense for a real inbound message.
   */
  private contextFor(inbound: InboundMessage, extra: Partial<BuildContextDeps> = {}): MessageContext {
    return buildMessageContext({
      inbound,
      tools: this.tools,
      send: (chatId, content, opts) => this.dispatchSend(chatId, content, opts, chatId === inbound.from ? 'ctx' : 'api'),
      canRenderForm: this.provider.canRenderForm ? (d, o) => this.provider.canRenderForm!(d, o) : undefined,
      typing: (chatId, state) => this.indicateTyping(chatId, state),
      handoff: (chatId, opts) => this.handoff(chatId, opts),
      user: this.users.for(inbound.senderId),
      i18n: this.i18n,
      ...this.messagingDeps(),
      ...this.streamDeps(),
      ...extra,
    })
  }

  /** Typing/delay pacing, edit and capability seams shared by every context this bot builds. */
  private messagingDeps(): Pick<BuildContextDeps, 'pace' | 'editMessage' | 'sendClock' | 'supports'> {
    return {
      pace: (chatId, text, opts, send) => this.pacedSend(chatId, text, opts, send),
      editMessage: this.provider.editMessage ? (ref, content) => this.dispatchEdit(ref, content) : undefined,
      sendClock: this.externalSends,
      supports: (feature) => messagingSupport(this.provider, feature),
    }
  }

  /**
   * Run a ctx text reply through the pacer. The wait (delay + typing) is tracked as an
   * in-flight send so `stop({ drain: true })` waits for it; the reply is dropped
   * (`skipped`) if, by the end of the wait, the bot is stopping or the chat was handed
   * off meanwhile (a reply that started in an already handed-off chat still goes out).
   */
  private pacedSend(chatId: ChatId, text: string, opts: ReplyOptions | undefined, send: () => Promise<SentMessage>): Promise<SentMessage> {
    const handedOffAtStart = this.isChatHandedOff(chatId)
    const op = this.pacer.run(chatId, text, opts, send, {
      cancelled: () => !this.pacedSendsOpen || (!handedOffAtStart && this.isChatHandedOff(chatId)),
      skip: () => ({ ref: { id: 'skipped', chatId }, id: 'skipped', chatId, skipped: true }),
    })
    this.inflightSends.add(op)
    const settle = () => { this.inflightSends.delete(op) }
    op.then(settle, settle)
    return op
  }

  /**
   * `ctx.stream()` backing: capabilities + the provider's edit/draft primitives (when present),
   * plus the per-chat text format behind `ctx.textFormat` (`IProvider.textFormatFor`).
   * Live previews run the same `before('send')` hooks as a real send (the payload carries
   * `stream: 'draft' | 'edit'`), so a hook that redacts, translates or aborts a reply also
   * covers the in-place updates. `after('send')` stays reserved for real messages. The
   * stream's new messages take the normal send path with `stream: 'message'`.
   */
  private streamDeps(): Pick<BuildContextDeps, 'capabilities' | 'textFormatFor' | 'streamSend' | 'streamEdit' | 'sendDraft' | 'deleteStreamMessage' | 'stopSignal'> {
    const p = this.provider
    return {
      capabilities: p.capabilities,
      textFormatFor: p.textFormatFor ? (chatId) => p.textFormatFor!(chatId) : undefined,
      streamSend: (chatId, content, o) => this.dispatchSend(chatId, content, o, 'ctx', 'message'),
      streamEdit: p.editMessage ? (ref, content) => this.dispatchStreamEdit(ref, content) : undefined,
      sendDraft: p.sendDraft ? (chatId, draftId, text, opts) => this.dispatchStreamDraft(chatId, draftId, text, opts) : undefined,
      deleteStreamMessage: p.deleteMessage ? (ref) => this.deleteStreamMessage(ref) : undefined,
      stopSignal: () => this.sendsAbort.signal,
    }
  }

  /** A discarded `ctx.stream()` message: gone from the chat and from the message log. */
  private async deleteStreamMessage(ref: MessageRef): Promise<void> {
    await this.provider.deleteMessage!(ref)
    try {
      await this.store.deleteMessage(ref)
    } catch (error) {
      this.emitError({ error })
    }
  }

  /** `before('send')` for a live preview. Resolves the (possibly rewritten) content, or `undefined` when a hook aborted. */
  private async runStreamSendHooks(chatId: ChatId, content: OutboundContent, stream: 'draft' | 'edit'): Promise<OutboundContent | undefined> {
    const payload: { chatId: ChatId; content: OutboundContent; options?: SendOptions; stream: 'draft' | 'edit' } = { chatId, content, stream }
    const proceed = await this.hooks.runBefore('send', payload as typeof payload & { abort(): void })
    return proceed ? payload.content : undefined
  }

  /** A `ctx.stream()` edit: send hooks, provider edit, then the message log is updated to the shown text. */
  private async dispatchStreamEdit(ref: MessageRef, content: OutboundContent): Promise<unknown> {
    const final = await this.runStreamSendHooks(ref.chatId, content, 'edit')
    if (!final) return undefined
    const res = await this.provider.editMessage!(ref, final)
    await this.messageLog.streamEdit(ref, final)
    return res
  }

  /** A `ctx.stream()` draft: send hooks, then the provider draft (skipped when aborted or no longer text). */
  private async dispatchStreamDraft(chatId: ChatId, draftId: number, text: string, opts?: DraftOptions): Promise<void> {
    const final = await this.runStreamSendHooks(chatId, { kind: 'text', text }, 'draft')
    if (!final || final.kind !== 'text') return
    await this.provider.sendDraft!(chatId, draftId, final.text, opts)
  }

  /**
   * Run hooks + emit for a provider event: `before` → `after` → `bot.on(event)`. A `before`
   * hook that aborts (or skips `next()`) suppresses the after-hooks and the event.
   * Resolves `false` if a before-hook aborted or it threw.
   */
  private async dispatchHookEvent(event: HookEvent, payload: unknown): Promise<boolean> {
    try {
      // Same contract as 'message' / 'send': an aborted event runs no after-hook and is not emitted.
      if (!(await this.hooks.runBefore(event, payload as { abort(): void }))) return false
      await this.hooks.runAfter(event, payload)
      this.emit(event, payload)
      return true
    } catch (error) {
      try { await this.hooks.runError(event, payload, error) } catch { /* no error hook registered */ }
      this.emitError({ error })
      return false
    }
  }

  /**
   * A call event. Access lists (blacklist / whitelist) and human handoff gate it first, like a
   * message: a blocked call runs no `'call'` hooks, emits no `'call'` event and reaches no `CALL`
   * trigger (it is counted in `metrics().dropped` and debug-logged). An admitted call runs the
   * hooks + `'call'` event, then — only when a `CALL` type trigger is registered — the first event
   * of each call id is projected into a `type: 'call'` context and dispatched to the type-trigger
   * matchers. Group calls follow `groupMode`: anything but `'all'` keeps them away from triggers.
   */
  private async handleCall(call: CallEvent): Promise<void> {
    const inbound = callToInbound(call)
    const access = checkAccess(this.blacklist, this.whitelist, inbound)
    if (access !== 'allowed') {
      this.counters.blockedDropped()
      this.logger.debug({ gate: access, chatId: inbound.chatId, senderId: inbound.senderId }, 'call dropped by access list')
      return
    }
    if (!this.handoffs.admits(inbound)) {
      this.counters.handoffDropped()
      this.logger.debug({ gate: 'handoff', chatId: inbound.chatId, senderId: inbound.senderId }, 'call dropped: chat handed off')
      return
    }
    const proceed = await this.dispatchHookEvent('call', call)
    if (!proceed || !this.acceptingInbound || !this.dispatcher.hasTypeMatcher('call')) return
    // A call can never mention the bot nor be a command: a restrictive groupMode keeps group calls out.
    if (call.isGroup === true && this.config.groupMode && this.config.groupMode !== 'all') return
    if (call.id && !this.seenCalls.add(call.id)) return
    const ctx = this.contextFor(inbound)
    ctx.call = call
    await this.dispatcher.dispatchEvent(ctx as unknown as DispatchContext)
  }
}

/* =============================================================================
 * TYPE GUARDS
 * ========================================================================== */

function isThenable(x: unknown): x is PromiseLike<unknown> {
  return typeof (x as { then?: unknown } | null | undefined)?.then === 'function'
}

function isPluginSpec(x: unknown): x is Plugin {
  if (typeof x === 'function') return true
  return typeof x === 'object' && x !== null && 'name' in x && 'install' in x
}
