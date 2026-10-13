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
  SendOptions,
  SendResult,
  SentMessage,
  StoredMessage,
  StoredChat,
  StoredContact,
  AIMessage,
  FlowCheckpoint,
  Trigger,
} from './types.js'

import { HookSystem } from '../hooks/HookSystem.js'
import { MemoryStore } from '../store/MemoryStore.js'
import { NamespacedStore, type StoreNamespace } from '../store/NamespacedStore.js'
import type { IStore } from '../store/IStore.js'
import { Dispatcher, type DispatchContext } from './Dispatcher.js'
import { buildMessageContext } from './context.js'
import { ConversationRuntime, type CheckpointStore, type ConversationFn } from '../conversations/ConversationRuntime.js'
import { createControls, type ConversationControls } from '../conversations/controls.js'
import { FlowBuilder, isCompiledFlow, type CompiledFlow } from '../flows/FlowBuilder.js'
import { Scheduler } from '../scheduler/Scheduler.js'
import { parseDuration } from '../utils/duration.js'
import { randomId } from '../utils/timers.js'
import { validateConfig } from '../utils/validateConfig.js'
import { FlowRouteLog, isDurableStore, type FlowInventory } from '../flows/inventory.js'
import { describeFlows, type DescribeOptions, type FlowGraph } from '../flows/describe.js'
import { lintFlows, type LintDiagnostic, type LintOptions } from '../flows/lint.js'

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
}

export type BotEventArgs<K extends keyof BotEvents> = BotEvents[K] extends void ? [] : [BotEvents[K]]

export interface SubjectDataExport {
  namespace: Readonly<StoreNamespace>
  userId: UserId
  contact?: StoredContact
  chats: StoredChat[]
  messages: StoredMessage[]
  conversation?: AIMessage[]
  checkpoints: Array<[string, FlowCheckpoint]>
  exportedAt: number
}

export interface SubjectDeletionResult {
  contacts: number
  chats: number
  messages: number
  conversations: number
  checkpoints: number
}

export class Bot extends EventEmitter {
  readonly logger: Logger

  private config: BotConfig
  private hooks: HookSystem
  private store: IStore
  private provider: IProvider
  private namespace: StoreNamespace
  private runtime: ConversationRuntime
  private dispatcher: Dispatcher
  private scheduler = new Scheduler()
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

  /** Resolves when the bot reaches the `'ready'` connection state. */
  readonly ready: Promise<void>

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

    this.logger = config.logger as Logger ?? pino({
      level: config.debug ? 'debug' : 'error',
    })

    this.hooks = new HookSystem(this.logger.child({ module: 'hooks' }))

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

    const conv = this.config.conversation ?? {}
    this.runtime = new ConversationRuntime({
      controlsFactory: createControls,
      defaultTimeoutMs: conv.timeout !== undefined ? parseDuration(conv.timeout) : undefined,
      timeoutMessage: conv.timeoutMessage,
      retriesMessage: conv.retriesMessage,
      errorMessage: conv.errorMessage,
      cancelledMessage: conv.cancelledMessage,
      scope: this.config.conversationScope === 'chat' ? 'chat' : 'participant',
      logger: this.logger.child({ module: 'conversations' }),
      onError: (error, ctx) => this.emitError({ error, ctx: ctx as unknown as MessageContext }),
    })
    if (typeof (this.store as Partial<CheckpointStore>).setCheckpoint === 'function') {
      this.runtime.attachStore(this.store as CheckpointStore)
    }

    this.dispatcher = new Dispatcher({
      hooks: this.hooks,
      runtime: this.runtime,
      commandPrefix: this.config.commandPrefix,
      logger: this.logger.child({ module: 'dispatcher' }),
      emit: (event, payload) => {
        if (event === 'error') {
          this.emitError(payload as { error: unknown; ctx?: MessageContext })
          return this.listenerCount('error') > 0
        }
        return this.emit(event, payload)
      },
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
      await this.runtime.loadDormant()
      providerAttempted = true
      await this.provider.start()
      this.scheduler.start(this.logger.child({ module: 'scheduler' }))
      this.isStarted = true
      this.acceptingInbound = true
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
   * @param opts.timeout - Max ms to wait for drain before forcing stop (default 10000).
   */
  stop(opts?: { drain?: boolean; timeout?: number }): Promise<void> {
    return this.enqueueLifecycle(() => this.stopOnce(opts))
  }

  private async stopOnce(opts?: { drain?: boolean; timeout?: number }): Promise<void> {
    if (!this.isStarted) return
    this.acceptingInbound = false
    this.scheduler.stop()
    if (opts?.drain && this.inflightSends.size > 0) {
      const timeout = opts.timeout ?? 10_000
      await Promise.race([
        Promise.allSettled([...this.inflightSends]),
        new Promise<void>((resolve) => setTimeout(resolve, timeout)),
      ])
    }
    this.runtime.abortAll()
    let stopError: unknown
    try { await this.provider.stop() }
    catch (error) { stopError = error }
    try { await this.store.stop() }
    catch (error) { stopError ??= error }
    this.isStarted = false
    this.connState = 'closed'
    this.emit('stopped')
    if (stopError) throw stopError
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycleQueue.then(operation, operation)
    this.lifecycleQueue = next.catch(() => undefined)
    return next
  }

  /**
   * Send normalized content to any chat. Runs the `before('send')`/`after('send')` hook
   * pipeline; a `before('send')` hook may mutate `payload.content` or `abort()` to skip.
   */
  async send(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SentMessage> {
    const r = await this.dispatchSend(chatId, content, options)
    return { ref: r.ref, id: r.ref.id, chatId: r.ref.chatId, raw: r.raw, skipped: r.skipped }
  }

  /**
   * Central outbound path: `before('send')` (mutable/abortable) → provider.send → `after('send')`.
   * Both {@link send} and every `ctx.reply`/`ctx.photo`/… reply helper route through here.
   */
  private async dispatchSend(chatId: ChatId, content: OutboundContent, options?: SendOptions): Promise<SendResult> {
    const payload: { chatId: ChatId; content: OutboundContent; options?: SendOptions } = { chatId, content, options }
    const proceed = await this.hooks.runBefore('send', payload as typeof payload & { abort(): void })
    if (!proceed) {
      return { ref: { id: 'skipped', chatId: payload.chatId }, skipped: true }
    }
    const localRef = { id: randomId('out'), chatId: payload.chatId }
    const op = this.provider.send(payload.chatId, payload.content, payload.options)
    this.inflightSends.add(op)
    try {
      const res = await op
      await this.hooks.runAfter('send', payload)
      await this.persistOutbound({
        ref: res.ref,
        chatId: payload.chatId,
        content: payload.content,
        options: payload.options,
        status: 'sent',
        raw: this.config.persistRaw ? res.raw : undefined,
      })
      return res
    } catch (error) {
      await this.persistOutbound({
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

  /** Helper to send plain text to a chat. */
  async sendText(chatId: ChatId, text: string): Promise<SentMessage> {
    return this.send(chatId, { kind: 'text', text })
  }

  /** Broadcast content to multiple chats (one send per chat). */
  async broadcast(chatIds: ChatId[], content: OutboundContent): Promise<{ sent: SentMessage[]; failed: Array<{ chatId: ChatId; error: Error }> }> {
    const sent: SentMessage[] = []
    const failed: Array<{ chatId: ChatId; error: Error }> = []
    for (const chatId of chatIds) {
      try { sent.push(await this.send(chatId, content)) }
      catch (error) { failed.push({ chatId, error: error as Error }) }
    }
    return { sent, failed }
  }

  /* =========================================================================
   * DECLARATIVE API
   * ====================================================================== */

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

  conversation(name: string, fn: ConversationFn<ConversationControls>, opts?: { trigger?: Trigger }): () => void {
    this.runtime.register(name, fn as ConversationFn)
    return this.registerEnterMatcher(opts?.trigger ?? name, name)
  }

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

  useFlow(flow: FlowBuilder | CompiledFlow): this { return this.use(flow) }

  command(name: string, handler: CommandHandler): () => void {
    const unsub = this.dispatcher.command(name, (ctx, args) => handler(this.asMessage(ctx), args))
    this.disposables.add(unsub)
    return unsub
  }

  onMessage(handler: MessageHandler): () => void {
    const unsub = this.dispatcher.catchAll((ctx) => handler(this.asMessage(ctx)))
    this.disposables.add(unsub)
    return unsub
  }

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

  abortConversation(target: string | { from: string; sender: string; isGroup: boolean }): boolean {
    if (typeof target !== 'string') return this.runtime.abort(this.runtime.keyFor(target))
    return this.runtime.abort(target)
  }

  /* =========================================================================
   * HOOKS
   * ====================================================================== */

  before(event: HookEvent, handler: HookHandler, priority = 0): this {
    this.disposables.add(this.hooks.register(event, 'before', handler, priority))
    return this
  }
  after(event: HookEvent, handler: HookHandler, priority = 0): this {
    this.disposables.add(this.hooks.register(event, 'after', handler, priority))
    return this
  }
  onError(event: HookEvent, handler: HookHandler): this {
    this.disposables.add(this.hooks.register(event, 'error', handler, 0))
    return this
  }
  hook(event: HookEvent, phase: HookPhase, handler: HookHandler, priority = 0): this {
    this.disposables.add(this.hooks.register(event, phase, handler, priority))
    return this
  }

  /* =========================================================================
   * PLUGINS
   * ====================================================================== */

  plug(plugin: Plugin, config?: Record<string, unknown>): () => void {
    const spec = typeof plugin === 'function' ? plugin(config) : plugin
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
    scopedBot.before = ((event: HookEvent, handler: HookHandler, priority = 0) => {
      disposables.push(this.hooks.register(event, 'before', handler, priority))
      return scopedBot
    }) as Bot['before']
    scopedBot.after = ((event: HookEvent, handler: HookHandler, priority = 0) => {
      disposables.push(this.hooks.register(event, 'after', handler, priority))
      return scopedBot
    }) as Bot['after']
    scopedBot.onError = ((event: HookEvent, handler: HookHandler) => {
      disposables.push(this.hooks.register(event, 'error', handler, 0))
      return scopedBot
    }) as Bot['onError']

    const ctx: PluginContext = {
      bot: scopedBot,
      logger: this.logger.child({ plugin: spec.name }),
      tools: this.tools,
      config: config ?? {},
      onDispose: (fn: () => void) => disposables.push(fn),
    }
    spec.install(ctx, config)
    return () => { while (disposables.length) disposables.pop()!() }
  }

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

  schedule(cron: string, fn: () => void | Promise<void>): ScheduledTask { return this.scheduler.cron(cron, fn) }
  every(interval: string | number, fn: () => void | Promise<void>): ScheduledTask { return this.scheduler.every(interval, fn) }
  delay(duration: string | number, fn: () => void | Promise<void>): ScheduledTask { return this.scheduler.delay(duration, fn) }

  /* =========================================================================
   * HELPERS
   * ====================================================================== */

  getStore(): IStore { return this.store }
  getProvider(): IProvider { return this.provider }
  getConnectionState(): ConnectionState { return this.connState }
  getNamespace(): Readonly<StoreNamespace> { return this.namespace }
  getSessionName() { return this.config.session ?? 'default' }

  /** Export normalized data associated with one subject in this bot namespace. */
  async exportSubject(userId: UserId): Promise<SubjectDataExport> {
    const contact = await this.store.getContact(userId)
    const chats = await this.store.listChats()
    const messages: StoredMessage[] = []
    for (const chat of chats) {
      const history = await this.store.getMessagesByChat(chat.id, 2_147_483_647)
      messages.push(...history.filter((message) => message.senderId === userId || message.chatId === userId))
    }
    const checkpoints = (await this.store.listCheckpoints())
      .filter(([key]) => checkpointBelongsToSubject(key, userId))
    return {
      namespace: this.namespace,
      userId,
      contact,
      chats: chats.filter((chat) => chat.id === userId || messages.some((message) => message.chatId === chat.id)),
      messages,
      conversation: await this.store.getConversation(userId),
      checkpoints,
      exportedAt: Date.now(),
    }
  }

  /** Delete normalized subject data in this bot namespace. */
  async deleteSubject(userId: UserId): Promise<SubjectDeletionResult> {
    const result: SubjectDeletionResult = {
      contacts: 0,
      chats: 0,
      messages: 0,
      conversations: 0,
      checkpoints: 0,
    }
    if (await this.store.getContact(userId)) {
      await this.store.deleteContact(userId)
      result.contacts++
    }
    const chats = await this.store.listChats()
    for (const chat of chats) {
      if (chat.id === userId) {
        result.messages += (await this.store.getMessagesByChat(chat.id, 2_147_483_647)).length
        await this.store.deleteChat(chat.id)
        result.chats++
        continue
      }
      const messages = await this.store.getMessagesByChat(chat.id, 2_147_483_647)
      for (const message of messages) {
        if (message.senderId !== userId) continue
        await this.store.deleteMessage(message.ref)
        result.messages++
      }
    }
    if (await this.store.getConversation(userId)) {
      await this.store.clearConversation(userId)
      result.conversations++
    }
    for (const [key] of await this.store.listCheckpoints()) {
      if (!checkpointBelongsToSubject(key, userId)) continue
      await this.store.clearCheckpoint(key)
      result.checkpoints++
    }
    return result
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
      defaultTimeoutMs: timeout !== undefined ? parseDuration(timeout) : undefined,
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

  private emitError(payload: { error: unknown; ctx?: MessageContext }): void {
    if (this.listenerCount('error') > 0) this.emit('error', payload)
    else this.logger.error({ err: payload.error }, 'unhandled bot error')
  }

  private registerEnterMatcher(trigger: Trigger, target: string): () => void {
    const unmatch = this.dispatcher.matcher(trigger, (ctx) => {
      void this.runtime.enter(target, ctx).catch((error) => this.emitError({ error, ctx: ctx as unknown as MessageContext }))
    })
    const unroute = this.flowRoutes.add(trigger, target)
    const unsub = () => { unmatch(); unroute() }
    this.disposables.add(unsub)
    return unsub
  }

  /** Subscribe to the provider's normalized event stream and route each kind. */
  private wireEvents(): void {
    this.disposables.add(this.provider.onEvent((event: InboundEvent) => {
      void this.handleProviderEvent(event).catch((error) => this.emitError({ error }))
    }))
  }

  private async handleProviderEvent(event: InboundEvent): Promise<void> {
    switch (event.kind) {
      case 'message':
        if (!this.acceptingInbound || event.message.fromMe) return
        await this.handleInbound(event.message)
        return
      case 'interaction':
        if (!this.acceptingInbound) return
        await this.handleInteraction(event.interaction)
        return
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
      case 'call': await this.dispatchHookEvent('call', event.event); return
      case 'group': await this.dispatchHookEvent('group', event.event); return
      case 'presence': await this.dispatchHookEvent('presence', event.event); return
      case 'status':
        await this.handleDeliveryStatus(event.status)
        await this.dispatchHookEvent('status', event.status)
        return
    }
  }

  private async handleInbound(
    inbound: InboundMessage,
    interaction?: { id: string; data: string; respondBy?: number },
  ): Promise<void> {
    const timestamp = normalizeTimestamp(inbound.timestamp)
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
      raw: this.config.persistRaw ? inbound.raw : undefined,
    }
    await Promise.all([
      this.store.upsertChat({
        id: inbound.chatId,
        ...this.namespace,
        kind: inbound.chat.kind,
        name: inbound.chat.name,
        lastMessageAt: timestamp,
        updatedAt: timestamp,
        raw: this.config.persistRaw ? inbound.chat.platformData : undefined,
      }),
      this.store.upsertContact({
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
    await this.processMessage(inbound, interaction)
  }

  /** Project an interaction (button/slash/callback) into a message-shaped context. */
  private async handleInteraction(it: InboundInteraction): Promise<void> {
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
    await this.handleInbound(inbound, { id: it.interactionId, data: it.data, respondBy: it.respondBy })
  }

  private async persistOutbound(input: {
    ref: MessageRef
    chatId: ChatId
    content: OutboundContent
    options?: SendOptions
    status: 'sent' | 'failed'
    error?: { code?: string | number; message?: string }
    raw?: unknown
  }): Promise<void> {
    const timestamp = Date.now()
    try {
      // A delivery/read receipt for this ref may already have landed during the
      // after-send hook window. Don't regress a more-advanced status back to
      // 'sent' — keep whichever is further along.
      const existing = await this.store.getMessage(input.ref)
      const status = higherDeliveryStatus(existing?.status, input.status)
      await Promise.all([
        this.store.upsertChat({
          id: input.chatId,
          ...this.namespace,
          lastMessageAt: timestamp,
          updatedAt: timestamp,
        }),
        this.store.saveMessage({
          ref: input.ref,
          chatId: input.chatId,
          senderId: this.provider.selfId ?? undefined,
          ...this.namespace,
          timestamp,
          type: input.content.kind,
          body: outboundBody(input.content),
          fromMe: true,
          direction: 'outbound',
          status,
          error: status === 'failed' ? input.error : existing?.error,
          quoted: input.options?.quoted,
          raw: input.raw,
        }),
      ])
    } catch (error) {
      // The provider may already have delivered the message. Reporting a false
      // send failure would encourage a retry and duplicate it, so ledger errors
      // travel through the bot error channel instead.
      this.emitError({ error })
    }
  }

  private async handleDeliveryStatus(status: DeliveryStatus): Promise<void> {
    const existing = await this.store.getMessage(status.ref)
    await this.store.saveMessage({
      ...(existing ?? {
        ref: status.ref,
        chatId: status.ref.chatId,
        timestamp: normalizeTimestamp(status.timestamp),
        type: 'unknown' as const,
        fromMe: true,
        direction: 'outbound' as const,
      }),
      ...this.namespace,
      status: status.status,
      error: status.error,
      timestamp: existing?.timestamp ?? normalizeTimestamp(status.timestamp),
    })
  }

  private async processMessage(inbound: InboundMessage, interaction?: { id: string; data: string; respondBy?: number }): Promise<void> {
    const ctx = buildMessageContext({
      inbound,
      tools: this.tools,
      send: (chatId, content, opts) => this.dispatchSend(chatId, content, opts),
      markRead: async (ref) => { await this.provider.markRead?.([ref]) },
      typing: async (chatId, state) => { await this.provider.typing?.(chatId, state) },
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
        if (!mentioned) return
      }
      if (this.config.groupMode === 'commands' && !ctx.body.startsWith(prefix)) return
    }

    this.logger.debug({ from: ctx.from, type: ctx.type }, 'dispatching message')
    await this.dispatcher.dispatch(ctx as unknown as DispatchContext)
  }

  private async dispatchHookEvent(event: HookEvent, payload: unknown): Promise<void> {
    try {
      await this.hooks.runBefore(event, payload as { abort(): void })
      await this.hooks.runAfter(event, payload)
      this.emit(event, payload)
    } catch (error) {
      try { await this.hooks.runError(event, payload, error) } catch { /* no error hook registered */ }
      this.emitError({ error })
    }
  }
}

/* =============================================================================
 * TYPE GUARDS
 * ========================================================================== */

function isPluginSpec(x: unknown): x is Plugin {
  if (typeof x === 'function') return true
  return typeof x === 'object' && x !== null && 'name' in x && 'install' in x
}

function normalizeTimestamp(timestamp: number): number {
  return timestamp > 0 && timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
}

/**
 * Does a conversation checkpoint key belong to `userId`? Keys are `keyFor(ctx)`:
 * the bare subject id (DM) or `${chatJid}:${participantJid}` (group scope). Match
 * on boundaries — NOT substring — so `5511999...` does not falsely match
 * `15511999...` (one JID being a substring of another), which would leak/delete
 * an unrelated subject's data in the export/erasure APIs.
 */
function checkpointBelongsToSubject(key: string, userId: string): boolean {
  return key === userId || key.startsWith(`${userId}:`) || key.endsWith(`:${userId}`)
}

type StoredStatus = NonNullable<StoredMessage['status']>
const DELIVERY_RANK: Record<StoredStatus, number> = {
  received: 0, queued: 0, sent: 1, failed: 1, delivered: 2, read: 3,
}
/** Pick the further-along delivery status so a late 'sent' write can't regress a delivered/read receipt. */
function higherDeliveryStatus(existing: StoredStatus | undefined, incoming: StoredStatus): StoredStatus {
  if (!existing) return incoming
  return (DELIVERY_RANK[existing] ?? 0) > (DELIVERY_RANK[incoming] ?? 0) ? existing : incoming
}

function outboundBody(content: OutboundContent): string | undefined {
  switch (content.kind) {
    case 'text': return content.text
    case 'image':
    case 'video':
    case 'document': return content.caption
    case 'location': return content.name ?? content.address
    case 'contact': return content.displayName ?? content.phone
    case 'poll': return content.question
    case 'buttons':
    case 'list': return content.text
    case 'card': return content.title
    case 'template': return content.name
    case 'reaction': return content.emoji
    default: return undefined
  }
}

function toStoredError(error: unknown): { code?: string | number; message?: string } {
  if (!(error instanceof Error)) return { message: String(error).slice(0, 500) }
  const code = (error as Error & { code?: string | number }).code
  return { code, message: error.message.slice(0, 500) }
}
