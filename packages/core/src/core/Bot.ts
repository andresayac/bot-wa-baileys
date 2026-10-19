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
import { type Logger } from 'pino'

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
  InboundReaction,
  PollVote,
  GroupEvent,
  PresenceEvent,
  CallEvent,
  DeliveryStatus,
  MessageContext,
  MessageType,
  OutboundContent,
  Plugin,
  ScheduledTask,
  CronTaskOptions,
  DurableTaskHandler,
  DurableTaskOptions,
  SendOptions,
  SentMessage,
  Trigger,
} from './types.js'

import { type StoreNamespace } from '../store/NamespacedStore.js'
import type { IStore } from '../store/IStore.js'
import type { Dispatcher } from './Dispatcher.js'
import type { ExternalSendClock } from './messaging.js'
import type { InboundDeduper } from './dedupe.js'
import type { ConversationRuntime, ConversationFn } from '../conversations/ConversationRuntime.js'
import type { ConversationSnapshot } from '../conversations/ConversationRuntime.js'
import type { ConversationHandler } from '../conversations/handler.js'
import { ChatIdleWatchers, type IdleHandler } from './idle.js'
import { FlowBuilder, type CompiledFlow } from '../flows/FlowBuilder.js'
import { Scheduler } from '../scheduler/Scheduler.js'
import type { FlowInventory, FlowRouteLog } from '../flows/inventory.js'
import { describeFlows, type DescribeOptions, type FlowGraph } from '../flows/describe.js'
import { lintFlows, type LintDiagnostic, type LintOptions } from '../flows/lint.js'
import { AccessList, Whitelist, type AccessListSnapshot, type AccessListsSnapshot, type WhitelistSnapshot } from '../gates/accessList.js'
import type { KeyedQueue } from '../utils/keyedQueue.js'
import { type HandoffEvent, type HandoffOptions, type HandoffRegistry, type HandoffState, type ResumeEvent, type ResumeOptions } from '../gates/handoff.js'
import type { WelcomeTracker } from './welcome.js'
import { type DynamicFlowRegistry, type FlowTriggerOptions, type FlowTriggerTarget, type RegisteredFlowInfo } from './flowRegistry.js'
import type { UserDataService } from '../user/UserDataService.js'
import type { UserData } from '../user/types.js'
import { MetricsCollector, type BotMetricsSnapshot, type ConversationEndedEvent, type ConversationStartedEvent } from '../ops/metrics.js'
import { type BroadcastOptions, type BroadcastResult } from '../ops/broadcast.js'
import { deleteSubjectData, exportSubjectData, type SubjectDataExport, type SubjectDeletionResult } from './subjectData.js'
import { type TriggerOptions, type TriggerResult } from '../ops/trigger.js'
import type { I18n } from '../i18n/I18n.js'
import type { ConversationHandoverEvent, CoordinatorEvents, Fence, LeaseLossReason } from '../coordination/types.js'
import type { DurabilityControl } from '../durability/bind.js'
import type { I18nConfig, LocaleMessages, TranslateParams } from '../i18n/types.js'
import { composeBot } from './bot/compose.js'
import { createLifecycleState, toOutbound, type BotKernel, type LifecycleState } from './bot/kernel.js'
import type { Lifecycle } from './bot/lifecycle.js'
import type { OutboundPipeline } from './bot/outbound.js'
import type { RouteRegistrar } from './bot/routes.js'
import type { PluginHost } from './bot/pluginHost.js'
import type { BotOps } from './bot/ops.js'

/** A user message handler — receives the full inbound {@link MessageContext}. */
export type MessageHandler = (ctx: MessageContext) => unknown | Promise<unknown>
/** A slash-command handler — receives the context plus the parsed argument list. */
export type CommandHandler = (ctx: MessageContext, args: string[]) => unknown | Promise<unknown>

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
  /** Multi-replica (`coordination`): this replica was elected for a singleton (`provider:<id>`) and starts it. */
  'coordination:leader': { name: string; fence: Fence }
  /** Multi-replica: this replica lost (or gave up) a singleton leadership and stands by. */
  'coordination:follower': { name: string; reason?: LeaseLossReason }
  /** Multi-replica: a chat turn or leadership was lost before its release (pause, partition, backend down). */
  'coordination:lease-lost': CoordinatorEvents['lease-lost']
  /**
   * Multi-replica (`coordination.handover`): a conversation another replica ran was taken
   * over on this one — resumed, or handled by the hand-over fallback (see `outcome`).
   */
  'coordination:handover': ConversationHandoverEvent
  /**
   * Durability (`BotConfig.durability`): an inbound event or a send was dead-lettered after its
   * retries (`id` is the inbox record id or the outbox key). Replay/retry it through `bot.durability`.
   */
  'durability:dead': { kind: 'inbound' | 'outbound'; id: string; chatId?: ChatId; error: unknown }
  /**
   * Durability: a send's outcome is unknown after a crash (the provider was called, the result
   * was never recorded). Handled per `durability.outbox.onAmbiguous`.
   */
  'durability:ambiguous': { key: string; chatId: ChatId }
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

  /*
   * The engine lives in `./bot/*` (built by `composeBot`); this class is a facade over it
   * and holds no logic of its own. No ECMAScript `#private` here: `plug()` builds the
   * plugin's bot with `Object.create(bot)` and its methods run with `this` set to that
   * object. The private getters below read the kernel through `this` (so through the
   * prototype for a plugin-scoped bot); diagnostics such as the soak script read some of
   * them by name.
   */
  /** Start/stop state shared by every module (see bot/kernel.ts). */
  private readonly state: LifecycleState = createLifecycleState()
  /** Runtime counters behind {@link metrics}. */
  private counters = new MetricsCollector()
  /** Per-chat inactivity watchers ({@link onIdle}); backed by the scheduler. */
  private idle = new ChatIdleWatchers({
    events: this,
    delay: (ms, fn) => this.scheduler.delay(ms, fn),
    isActive: () => this.state.acceptingInbound,
    isSuspended: (chatId) => this.isChatHandedOff(chatId),
    onError: (error, ctx) => this.kernel.events.error({ error, ctx }),
  })

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

  private readonly kernel: BotKernel
  private readonly lifecycle: Lifecycle
  private readonly outbound: OutboundPipeline
  private readonly routes: RouteRegistrar
  private readonly plugins: PluginHost
  private readonly ops: BotOps

  private get config(): BotConfig { return this.kernel.config }
  private get store(): IStore { return this.kernel.store }
  private get provider(): IProvider { return this.kernel.provider }
  private get namespace(): StoreNamespace { return this.kernel.namespace }
  /** `ctx.user` profiles — one service so writes of a user serialise across chats. */
  private get users(): UserDataService { return this.kernel.users }
  private get runtime(): ConversationRuntime { return this.kernel.runtime }
  private get dispatcher(): Dispatcher { return this.kernel.dispatcher }
  /** Inbound idempotency guard (`BotConfig.dedupe`); `null` when disabled. */
  private get inboundDedupe(): InboundDeduper | null { return this.kernel.inboundDedupe }
  private get tools(): Record<string, unknown> { return this.kernel.tools }
  /** In-flight outbound sends — tracked so `stop({ drain: true })` can wait for them. */
  private get inflightSends(): Set<Promise<unknown>> { return this.kernel.inflightSends }
  /** Trigger routes, kept for `describe()` / `lint()` introspection. */
  private get flowRoutes(): FlowRouteLog { return this.kernel.flowRoutes }
  /** Store-backed first-contact state for the `WELCOME` trigger. */
  private get welcome(): WelcomeTracker { return this.kernel.welcome }
  /** Provider events still being handled (stored, dispatched) — see {@link isBusy}. */
  private get inflightEvents(): Set<Promise<void>> { return this.kernel.inflightEvents }
  private get handoffs(): HandoffRegistry { return this.kernel.handoffs }
  /** Serializes this bot's chat upserts per chat. */
  private get chatWrites(): KeyedQueue { return this.kernel.chatWrites }
  /** Sends outside a chat's own `ctx` replies — they invalidate `ctx.edit(content)` targets. */
  private get externalSends(): ExternalSendClock { return this.kernel.externalSends }
  /** Locale registry behind `bot.locale()` / `ctx.t()` (see i18n/I18n.ts). */
  private get i18n(): I18n { return this.kernel.i18n }
  /** Runtime flow CRUD (`registerFlow`/`unregisterFlow`/`replaceFlow`/`triggerFlow`). */
  private get flowRegistry(): DynamicFlowRegistry { return this.kernel.flowRegistry }
  /** Plain timers, or the durable scheduler `BotConfig.scheduler` builds (see bot/compose.ts). */
  private get scheduler(): Scheduler { return this.kernel.scheduler }

  constructor(config: BotConfig) {
    super()
    // Every lookup on the bot below is late-bound (a spy, a subclass override or a
    // plugin-scoped override installed later is honoured).
    const parts = composeBot(
      {
        emit: (event, ...args) => this.emit(event, ...args),
        listenerCount: (event) => this.listenerCount(event),
        registerEnterMatcher: (trigger, target) => this.registerEnterMatcher(trigger, target),
        isChatHandedOff: (chatId) => this.isChatHandedOff(chatId),
        handoff: (chatId, opts) => this.handoff(chatId, opts),
      },
      config,
      {
        state: this.state,
        scheduler: new Scheduler(),
        idle: this.idle,
        counters: this.counters,
        blacklist: this.blacklist,
        whitelist: this.whitelist,
      },
    )
    const k = parts.kernel
    this.kernel = k
    this.logger = k.logger
    this.ready = parts.ready
    this.lifecycle = parts.lifecycle
    this.outbound = parts.outbound
    this.routes = parts.routes
    this.plugins = parts.plugins
    this.ops = parts.ops
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
    return this.lifecycle.start()
  }

  /**
   * Stop the bot. By default aborts conversations and tears down immediately.
   * @param opts.drain - Wait for in-flight sends to complete before stopping (default false).
   * @param opts.timeout - Max time to wait for drain before forcing stop: a duration
   *   (`'5s'`, same grammar as every other duration option) or ms (default 10000).
   */
  stop(opts?: StopOptions): Promise<void> {
    return this.lifecycle.stop(opts)
  }

  /**
   * Send normalized content to any chat (a plain string is sent as text, like
   * {@link broadcast} and {@link sendTo}). Runs the `before('send')`/`after('send')` hook
   * pipeline; a `before('send')` hook may mutate `payload.content` or `abort()` to skip.
   */
  async send(chatId: ChatId, content: string | OutboundContent, options?: SendOptions): Promise<SentMessage> {
    const r = await this.outbound.send(chatId, toOutbound(content), options)
    return { ref: r.ref, id: r.ref.id, chatId: r.ref.chatId, raw: r.raw, skipped: r.skipped }
  }

  /**
   * Durable message processing controls — the inbox/outbox journals, operator replay/retry
   * of dead-lettered records and counters. `undefined` unless `BotConfig.durability` is set.
   *
   * @example
   * ```ts
   * for (const r of await bot.durability!.outbox.list({ state: 'dead' })) await bot.durability!.retrySend(r.key)
   * ```
   */
  get durability(): DurabilityControl | undefined { return this.kernel.durable ?? undefined }

  /**
   * Durable fire-and-forget send (needs `BotConfig.durability`): runs the `before('send')`
   * hooks, journals the send and returns its outbox key at once; the background sweeper
   * delivers it (retries, backoff, dead-letter queue). Enqueueing an `idempotencyKey` that
   * already exists is a no-op (`status: 'exists'`) — use it for campaigns and scheduled
   * jobs that may run twice.
   *
   * @example
   * ```ts
   * await bot.enqueue(chatId, 'Tu cita es mañana', { idempotencyKey: `reminder:${citaId}` })
   * ```
   */
  async enqueue(chatId: ChatId, content: string | OutboundContent, options?: SendOptions): Promise<{ key: string; status: 'queued' | 'exists' | 'skipped' }> {
    const durable = this.kernel.durable
    if (!durable) throw new Error('bot.enqueue() needs BotConfig.durability')
    return durable.enqueue(chatId, toOutbound(content), options)
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
    return this.ops.broadcast((chatId, c, o) => this.send(chatId, c, o), chatIds, content, opts)
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
  trigger(name: string, opts: TriggerOptions): Promise<TriggerResult> {
    return this.ops.trigger(name, opts)
  }

  /**
   * Snapshot of the runtime counters: conversations (started/completed/cancelled/
   * timedOut/retriesExceeded/errored, active, mean duration) overall and per flow,
   * messages in/out, inbound drops (duplicate/blocked/handoff), triggers, errors and
   * uptime. In-process only. Render it for Prometheus with `toPrometheus()`.
   */
  metrics(): BotMetricsSnapshot {
    return this.ops.metrics()
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
    return this.routes.when(trigger, handler, (t, target) => this.registerEnterMatcher(t, target))
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
    return this.routes.conversation(name, fn, opts?.trigger ?? name, (t, target) => this.registerEnterMatcher(t, target))
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
      .catch((error) => this.kernel.events.error({ error, ctx }))
  }

  /**
   * Register flows and/or plugins (an array is accepted). Chainable; to remove one later
   * use the unsubscriber of {@link plug} or {@link unregisterFlow}.
   */
  use(item: FlowBuilder | CompiledFlow | Plugin | Array<FlowBuilder | CompiledFlow | Plugin>): this {
    const items = Array.isArray(item) ? item : [item]
    this.routes.use(items, (t, target) => this.registerEnterMatcher(t, target), (p) => this.plug(p))
    return this
  }

  /** Same as `use(flow)`, typed for a single flow. */
  useFlow(flow: FlowBuilder | CompiledFlow): this { return this.use(flow) }

  /** Register a `/name` command (wins over an active conversation). Returns an unsubscriber. */
  command(name: string, handler: CommandHandler): () => void {
    return this.routes.command(name, handler)
  }

  /**
   * Catch-all handler: receives the messages no command, conversation or matcher took.
   * Not to be confused with `bot.on('message', …)`, the event that observes every
   * inbound message. Returns an unsubscriber.
   */
  onMessage(handler: MessageHandler): () => void {
    return this.routes.onMessage(handler)
  }

  /**
   * Handle every message of one {@link MessageType}. `onImage`, `onAudio`, … are
   * shorthands for it. Returns an unsubscriber.
   */
  onType(type: MessageType, handler: MessageHandler): () => void {
    return this.routes.onType(type, handler)
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
  triggerFlow(id: string, target: FlowTriggerTarget, opts: FlowTriggerOptions = {}): Promise<boolean> {
    return this.ops.triggerFlow((name, o) => this.trigger(name, o), id, target, opts)
  }

  /** Snapshots of every live conversation (`key`, `state`, `waiting`, `queued`). */
  listConversations(): ConversationSnapshot[] { return this.flowRegistry.conversations() }

  /**
   * Cancel the live conversation of `target` (a {@link ConversationTarget}, e.g. a `ctx`,
   * or a raw runtime key from {@link listConversations}). Returns `false` when none is live.
   */
  abortConversation(target: string | ConversationTarget): boolean {
    return this.runtime.abort(this.ops.conversationKey(target))
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
    return this.runtime.inspect(this.ops.conversationKey(target))
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
    return this.ops.isBusy()
  }

  /* =========================================================================
   * HOOKS
   * ====================================================================== */

  /** Register a `before` hook (higher `priority` runs first). Chainable. */
  before(event: HookEvent, handler: HookHandler, priority = 0): this {
    this.routes.hook(event, 'before', handler, priority)
    return this
  }
  /** Register an `after` hook (higher `priority` runs first). Chainable. */
  after(event: HookEvent, handler: HookHandler, priority = 0): this {
    this.routes.hook(event, 'after', handler, priority)
    return this
  }
  /** Register an `error`-phase hook. `priority` orders it like {@link before}/{@link after} (default 0). */
  onError(event: HookEvent, handler: HookHandler, priority = 0): this {
    this.routes.hook(event, 'error', handler, priority)
    return this
  }
  /** Register a hook for any phase: the generic form of {@link before}/{@link after}/{@link onError}. */
  hook(event: HookEvent, phase: HookPhase, handler: HookHandler, priority = 0): this {
    this.routes.hook(event, phase, handler, priority)
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
    return this.plugins.plug(this, plugin, config)
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
  /**
   * Cron task read in a time zone: `bot.schedule('0 9 * * 1-5', { timeZone: 'America/Bogota' }, fn)`
   * (see {@link CronTaskOptions} for the daylight-saving rules). Add an `id` to make it durable.
   */
  schedule(cron: string, opts: CronTaskOptions, fn: () => void | Promise<void>): ScheduledTask
  schedule(
    cron: string,
    a: (() => void | Promise<void>) | DurableTaskOptions | CronTaskOptions,
    b?: DurableTaskHandler | (() => void | Promise<void>),
  ): ScheduledTask {
    return typeof a === 'function' ? this.scheduler.cron(cron, a) : this.scheduler.cron(cron, a as DurableTaskOptions, b as DurableTaskHandler)
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
  getConnectionState(): ConnectionState { return this.state.connState }
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
    return exportSubjectData(this.ops.subjectDeps(), userId)
  }

  /**
   * Delete normalized subject data in this bot namespace, including the handoff of chat
   * `userId` and the subject's live or dormant conversations.
   */
  deleteSubject(userId: UserId): Promise<SubjectDeletionResult> {
    return deleteSubjectData(this.ops.subjectDeps(), userId)
  }

  /* =========================================================================
   * INTROSPECTION (describe / lint)
   * ====================================================================== */

  /**
   * Read-only snapshot of the registered flows, conversations and trigger routes,
   * plus the bits of config the linter needs. Input of `describeFlows()`/`lintFlows()`.
   */
  flowInventory(): FlowInventory {
    return this.ops.flowInventory()
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
   * Register the route that enters conversation/flow `target` when `trigger` matches.
   * Every flow/conversation route goes through this method, called on the receiver, so a
   * plugin-scoped bot can override it to track (and remove on unplug) its routes.
   */
  private registerEnterMatcher(trigger: Trigger, target: string): () => void {
    return this.routes.enterMatcher(trigger, target)
  }
}
