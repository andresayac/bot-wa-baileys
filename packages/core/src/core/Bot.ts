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
  MessageType,
  OutboundContent,
  Plugin,
  PluginContext,
  ScheduledTask,
  SendOptions,
  SendResult,
  SentMessage,
  StoredMessage,
  Trigger,
} from './types.js'

import { HookSystem } from '../hooks/HookSystem.js'
import { MemoryStore } from '../store/MemoryStore.js'
import type { IStore } from '../store/IStore.js'
import { Dispatcher, type DispatchContext } from './Dispatcher.js'
import { buildMessageContext } from './context.js'
import { ConversationRuntime, type CheckpointStore, type ConversationFn } from '../conversations/ConversationRuntime.js'
import { createControls, type ConversationControls } from '../conversations/controls.js'
import { FlowBuilder, isCompiledFlow, type CompiledFlow } from '../flows/FlowBuilder.js'
import { Scheduler } from '../scheduler/Scheduler.js'
import { parseDuration } from '../utils/duration.js'
import { validateConfig } from '../utils/validateConfig.js'

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

type BotEventArgs<K extends keyof BotEvents> = BotEvents[K] extends void ? [] : [BotEvents[K]]

export class Bot extends EventEmitter {
  readonly logger: Logger

  private config: BotConfig
  private hooks: HookSystem
  private store: IStore
  private provider: IProvider
  private runtime: ConversationRuntime
  private dispatcher: Dispatcher
  private scheduler = new Scheduler()
  private tools: Record<string, unknown> = {}
  private disposables = new DisposableList()
  private isStarted = false
  private connState: ConnectionState = 'closed'
  /** In-flight outbound sends — tracked so `stop({ drain: true })` can wait for them. */
  private inflightSends = new Set<Promise<unknown>>()

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
      transport: config.debug ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    })

    this.hooks = new HookSystem(this.logger.child({ module: 'hooks' }))

    // Store — injected instance, or the built-in MemoryStore.
    this.store =
      (typeof this.config.store === 'object' && this.config.store !== null
        ? (this.config.store as IStore)
        : null) ??
      new MemoryStore({
        file: (this.config.storeConfig as { file?: string } | undefined)?.file,
        maxMessagesPerChat: (this.config.storeConfig as { maxMessagesPerChat?: number } | undefined)?.maxMessagesPerChat,
        autoSaveInterval: (this.config.storeConfig as { autoSaveInterval?: number } | undefined)?.autoSaveInterval,
        logger: this.logger.child({ module: 'store' }),
      })

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

  async start(): Promise<void> {
    if (this.isStarted) return
    this.isStarted = true
    await this.store.start()
    await this.runtime.loadDormant()
    await this.provider.start()
    await this.scheduler.start(this.logger.child({ module: 'scheduler' }))
    this.emit('started')
  }

  /**
   * Stop the bot. By default aborts conversations and tears down immediately.
   * @param opts.drain - Wait for in-flight sends to complete before stopping (default false).
   * @param opts.timeout - Max ms to wait for drain before forcing stop (default 10000).
   */
  async stop(opts?: { drain?: boolean; timeout?: number }): Promise<void> {
    if (!this.isStarted) return
    this.isStarted = false
    this.scheduler.stop()
    if (opts?.drain && this.inflightSends.size > 0) {
      const timeout = opts.timeout ?? 10_000
      await Promise.race([
        Promise.allSettled([...this.inflightSends]),
        new Promise<void>((resolve) => setTimeout(resolve, timeout)),
      ])
    }
    this.runtime.abortAll()
    await this.provider.stop()
    await this.store.stop()
    this.emit('stopped')
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
    const op = this.provider.send(payload.chatId, payload.content, payload.options)
    this.inflightSends.add(op)
    const res = await op.finally(() => { this.inflightSends.delete(op) })
    await this.hooks.runAfter('send', payload)
    return res
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
    const unsub = this.dispatcher.matcher(trigger, (ctx) => fn(this.asMessage(ctx)))
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
  getSessionName() { return this.config.session ?? 'default' }

  /* =========================================================================
   * INTERNAL WIRING
   * ====================================================================== */

  private asMessage(ctx: DispatchContext): MessageContext { return ctx as unknown as MessageContext }

  private emitError(payload: { error: unknown; ctx?: MessageContext }): void {
    if (this.listenerCount('error') > 0) this.emit('error', payload)
    else this.logger.error({ err: payload.error }, 'unhandled bot error')
  }

  private registerEnterMatcher(trigger: Trigger, target: string): () => void {
    const unsub = this.dispatcher.matcher(trigger, (ctx) => {
      void this.runtime.enter(target, ctx).catch((error) => this.emitError({ error, ctx: ctx as unknown as MessageContext }))
    })
    this.disposables.add(unsub)
    return unsub
  }

  /** Subscribe to the provider's normalized event stream and route each kind. */
  private wireEvents(): void {
    this.disposables.add(this.provider.onEvent((event: InboundEvent) => {
      switch (event.kind) {
        case 'message':
          if (event.message.fromMe) return
          void this.handleInbound(event.message)
          return
        case 'interaction':
          void this.handleInteraction(event.interaction)
          return
        case 'connection': {
          const u = event.update
          this.connState = u.state
          this.emit('connection', u)
          if (typeof u.authPayload === 'string') this.emit('qr', u.authPayload)
          if (u.state === 'ready') this.emit('ready')
          return
        }
        case 'reaction': void this.dispatchHookEvent('reaction', event.reaction); return
        case 'poll-vote': void this.dispatchHookEvent('poll', event.vote); return
        case 'call': void this.dispatchHookEvent('call', event.event); return
        case 'group': void this.dispatchHookEvent('group', event.event); return
        case 'presence': void this.dispatchHookEvent('presence', event.event); return
        case 'status': void this.dispatchHookEvent('status', event.status); return
      }
    }))
  }

  private async handleInbound(inbound: InboundMessage): Promise<void> {
    const stored: StoredMessage = {
      ref: inbound.ref,
      chatId: inbound.chatId,
      senderId: inbound.senderId,
      timestamp: inbound.timestamp,
      type: inbound.type,
      body: inbound.body,
      fromMe: inbound.fromMe,
      raw: inbound.raw,
    }
    await this.store.saveMessage(stored)
    await this.processMessage(inbound)
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
    await this.processMessage(inbound, { id: it.interactionId, data: it.data, respondBy: it.respondBy })
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
