/**
 * Bot — public entry point of `@bot-wa/bot-wa-baileys`.
 *
 * A modern WhatsApp bot framework built on Baileys 7. Provides a declarative
 * API (`when`, `flow`, `conversation`, `plug`), hooks (`before`/`after`/`onError`),
 * dependency injection (`provide`), a scheduler (`schedule`/`every`/`delay`) and
 * typed sub-APIs (`groups`, `profile`, `privacy`, `chats`, `presence`).
 *
 * Inbound messages are routed by a {@link Dispatcher} (specificity-ordered matchers,
 * per-chat FIFO) and interactive flows run on the async {@link ConversationRuntime}.
 *
 * @example Create and start a bot
 * ```ts
 * import { Bot } from '@bot-wa/bot-wa-baileys'
 *
 * const bot = new Bot({
 *   session: 'demo-bot',
 *   sessionsDir: './sessions',
 *   qr: { terminal: true, small: true },
 * })
 *
 * bot.on('ready', () => bot.logger.info('connected'))
 * await bot.start()
 * ```
 *
 * @example Declarative handlers
 * ```ts
 * bot.when('hola', async (ctx) => await ctx.reply('¡Hola! 👋'))
 * bot.when(['adios', 'chao'], async (ctx) => await ctx.reply('bye 👋'))
 * bot.when(/\d{4,}/, async (ctx) => await ctx.reply('número largo detectado'))
 * ```
 *
 * @example Hooks (middleware)
 * ```ts
 * bot.before('message', async (ctx, next) => { await next() })
 * bot.after('message', async (ctx) => bot.logger.debug({ from: ctx.from }, 'processed'))
 * bot.onError('message', async (ctx, err) => bot.logger.error(err))
 * ```
 *
 * @example Plugins & dependency injection
 * ```ts
 * bot.plug(slashCommandsPlugin, { greeting: 'Hi!' })
 * bot.provide('db', myDatabase)
 * ```
 *
 * @example Scheduler
 * ```ts
 * bot.every('30 seconds', () => bot.logger.debug('heartbeat'))
 * bot.schedule('0 9 * * 1-5', async () => { \/* weekday 9am *\/ })
 * bot.delay('10 seconds', () => bot.logger.debug('10s elapsed'))
 * ```
 */

import { EventEmitter } from 'events'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import pino, { type Logger } from 'pino'
import type { makeWASocket } from '@whiskeysockets/baileys'

import type {
  BotConfig,
  ChatId,
  ConnectionUpdate,
  DefaultTools,
  HookEvent,
  HookHandler,
  HookPhase,
  IProvider,
  MessageContext,
  MessageType,
  Plugin,
  PluginContext,
  ScheduledTask,
  SentMessage,
  Trigger,
  WAMessage,
  GroupsAPI,
  ProfileAPI,
  PrivacyAPI,
  ChatsAPI,
  PresenceAPI,
} from './types.js'

import { HookSystem } from '../hooks/HookSystem.js'
import { BaileysProvider, TypedEmitter, type ProviderEvents } from '../provider/BaileysProvider.js'
import { MemoryStore } from '../store/MemoryStore.js'
import type { IStore } from '../store/IStore.js'
import { Dispatcher, type DispatchContext } from './Dispatcher.js'
import { buildMessageContext } from './context.js'
import { ConversationRuntime, type CheckpointStore, type ConversationFn } from '../conversations/ConversationRuntime.js'
import { createControls, type ConversationControls } from '../conversations/controls.js'
import { FlowBuilder, isCompiledFlow, type CompiledFlow } from '../flows/FlowBuilder.js'
import { GroupsAPIImpl } from '../api/GroupsAPI.js'
import { ProfileAPIImpl } from '../api/ProfileAPI.js'
import { PrivacyAPIImpl } from '../api/PrivacyAPI.js'
import { ChatsAPIImpl } from '../api/ChatsAPI.js'
import { PresenceAPIImpl } from '../api/PresenceAPI.js'
import { Scheduler } from '../scheduler/Scheduler.js'
import { parseDuration } from '../utils/duration.js'
import { toMediaUpload, makeSticker, transcodeToOpus } from '../media/MediaProcessor.js'

/** A user message handler — receives the full inbound {@link MessageContext}. */
export type MessageHandler = (ctx: MessageContext) => unknown | Promise<unknown>
/** A slash-command handler — receives the context plus the parsed argument list. */
export type CommandHandler = (ctx: MessageContext, args: string[]) => unknown | Promise<unknown>

type Socket = ReturnType<typeof makeWASocket>

/** Tiny helper to keep a list of unsubscribers. */
class DisposableList {
  private list: Array<() => void> = []
  add(fn: () => void) { this.list.push(fn) }
  disposeAll() {
    while (this.list.length) this.list.pop()!()
  }
}

export interface BotEvents {
  ready: void
  qr: string
  connection: ConnectionUpdate
  message: MessageContext
  error: { error: unknown; ctx?: MessageContext }
}

export class Bot extends EventEmitter {
  readonly logger: Logger

  private config: Required<Pick<BotConfig, 'session' | 'sessionsDir' | 'debug'>> & BotConfig
  private hooks = new HookSystem()
  private store: IStore
  private provider: IProvider
  private runtime: ConversationRuntime
  private dispatcher: Dispatcher
  private scheduler = new Scheduler()
  private tools: Record<string, unknown> = {}
  private disposables = new DisposableList()
  private isStarted = false

  /**
   * Promise resolved when the bot reaches the `'open'` connection state.
   * Useful to `await bot.ready` before sending proactive messages.
   */
  readonly ready: Promise<void>

  // Public sub-APIs
  readonly groups: GroupsAPI
  readonly profile: ProfileAPI
  readonly privacy: PrivacyAPI
  readonly chats: ChatsAPI
  readonly presence: PresenceAPI

  constructor(config: BotConfig = {}) {
    super()
    this.config = {
      session: 'default',
      sessionsDir: './sessions',
      reconnect: true,
      markOnlineOnConnect: false,
      ignoreNewsletters: true,
      ignoreBroadcasts: true,
      debug: false,
      qr: { terminal: true, small: true },
      ...config,
    } as Required<Pick<BotConfig, 'session' | 'sessionsDir' | 'debug'>> & BotConfig

    this.logger = config.logger ?? pino({
      level: this.config.debug ? 'debug' : 'error',
      transport: this.config.debug
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    })

    // Store
    this.store =
      (typeof this.config.store === 'object' && this.config.store !== null
        ? (this.config.store as IStore)
        : null) ??
      new MemoryStore({
        file: (this.config.storeConfig as { file?: string } | undefined)?.file,
        maxMessagesPerChat: (this.config.storeConfig as { maxMessagesPerChat?: number } | undefined)?.maxMessagesPerChat,
        autoSaveInterval: (this.config.storeConfig as { autoSaveInterval?: number } | undefined)?.autoSaveInterval,
      })

    // Conversation runtime (replaces the old step-based FlowEngine)
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
      onError: (error, ctx) => this.emit('error', { error, ctx }),
    })
    if (typeof (this.store as Partial<CheckpointStore>).setCheckpoint === 'function') {
      this.runtime.attachStore(this.store as CheckpointStore)
    }

    // Dispatcher (replaces the old MessageRouter routing)
    this.dispatcher = new Dispatcher({
      hooks: this.hooks,
      runtime: this.runtime,
      commandPrefix: this.config.commandPrefix,
      logger: this.logger.child({ module: 'dispatcher' }),
      emit: (event, payload) => { this.emit(event, payload) },
    })

    // Provider — injected (tests) or a real BaileysProvider. Only touch the
    // filesystem / build a socket when we actually own the provider.
    if (config.provider) {
      this.provider = config.provider
    } else {
      mkdirSync(dirname(this.config.sessionsDir + '/' + this.config.session), { recursive: true })
      this.provider = new BaileysProvider(
        this.config,
        this.logger.child({ module: 'provider' }),
        async (key) => this.store.getMessage(key)
      )
    }

    // Setup ready promise
    this.ready = new Promise<void>((resolve) => {
      const listener = (u: ConnectionUpdate) => {
        if (u.state === 'open') {
          this.providerEvents.offTyped('connection', listener)
          resolve()
        }
      }
      this.providerEvents.onTyped('connection', listener)
    })

    // Wire sub-APIs
    this.groups = new GroupsAPIImpl(() => this.requireSocket())
    this.profile = new ProfileAPIImpl(() => this.requireSocket(), () => this.requireAuthCreds())
    this.privacy = new PrivacyAPIImpl(() => this.requireSocket())
    this.chats = new ChatsAPIImpl(() => this.requireSocket(), this.store)
    this.presence = new PresenceAPIImpl(() => this.requireSocket())

    this.wireConnectionEvents()
    this.wireMessageEvents()
  }

  /** Typed view of the provider's event emitter (both BaileysProvider and MockProvider are TypedEmitters). */
  private get providerEvents(): TypedEmitter<ProviderEvents> {
    return this.provider as unknown as TypedEmitter<ProviderEvents>
  }

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

  async stop(): Promise<void> {
    if (!this.isStarted) return
    this.isStarted = false
    this.scheduler.stop()
    this.disposables.disposeAll()
    await this.provider.stop()
    await this.store.stop()
    this.emit('stopped')
  }

  /**
   * Send any content to any JID — lowest-level helper.
   * `content` is a Baileys message payload object (e.g. `{ text }`, `{ image, caption }`).
   */
  async send(jid: ChatId, content: Record<string, unknown>, options?: Record<string, unknown>): Promise<SentMessage> {
    const msg = await this.provider.send(jid, content, options)
    return { jid, messageId: msg.key.id ?? '', key: msg.key as SentMessage['key'], raw: msg as unknown as WAMessage }
  }

  /** Helper to send plain text to a JID. */
  async sendText(jid: ChatId, text: string): Promise<SentMessage> {
    return this.send(jid, { text })
  }

  /**
   * Broadcast a message to multiple JIDs (one sendMessage per JID).
   * Returns the list of successful sends and per-JID failures.
   */
  async broadcast(jids: ChatId[], content: Record<string, unknown>): Promise<{ sent: SentMessage[]; failed: Array<{ jid: ChatId; error: Error }> }> {
    const sent: SentMessage[] = []
    const failed: Array<{ jid: ChatId; error: Error }> = []
    for (const jid of jids) {
      try {
        sent.push(await this.send(jid, content))
      } catch (error) {
        failed.push({ jid, error: error as Error })
      }
    }
    return { sent, failed }
  }

  /* =========================================================================
   * DECLARATIVE API
   * ====================================================================== */

  /**
   * Match an inbound message by keyword/regex/trigger and either run a handler or
   * start a flow. Returns an unsubscriber.
   *
   * @example Text / list / regex
   * ```ts
   * bot.when('hola', async (ctx) => await ctx.reply('👋 ¡Hola!'))
   * bot.when(['adios', 'chao'], async (ctx) => await ctx.reply('👋 bye'))
   * bot.when(/\d{4,}/, async (ctx) => await ctx.reply('long number'))
   * ```
   *
   * @example Attach a flow (starts when the trigger matches)
   * ```ts
   * bot.when('soporte', flow('soporte').ask('¿Qué pasa?', 'issue').say('Gracias'))
   * ```
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
    const unsub = this.dispatcher.matcher(trigger, (ctx) => fn(this.asMessage(ctx)))
    this.disposables.add(unsub)
    return unsub
  }

  /**
   * Register a stateful conversation by name. `fn` receives conversation controls
   * (`ask`, `waitText`, `choose`, `state`, …) and the triggering message.
   *
   * @example
   * ```ts
   * bot.conversation('soporte', async (c, ctx) => {
   *   await ctx.reply('Describe tu problema')
   *   const detail = await c.waitText()
   *   await ctx.reply(`🎫 registrado: ${detail}`)
   * })
   * ```
   */
  conversation(name: string, fn: ConversationFn<ConversationControls>, opts?: { trigger?: Trigger }): () => void {
    this.runtime.register(name, fn as ConversationFn)
    return this.registerEnterMatcher(opts?.trigger ?? name, name)
  }

  /**
   * Generic `use()` — register flows (FlowBuilder/CompiledFlow) on their own trigger,
   * or install plugins. Accepts a single item or an array.
   *
   * @example
   * ```ts
   * bot.use([registerFlow, buyFlow, supportFlow])
   * bot.use(slashCommandsPlugin)
   * ```
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

  /** Alias of {@link use} kept for flows registered the old way. */
  useFlow(flow: FlowBuilder | CompiledFlow): this { return this.use(flow) }

  /**
   * Register a slash command handler. Commands beat active conversations, so a
   * `/reset` always escapes a running flow.
   *
   * @example
   * ```ts
   * bot.command('reset', async (ctx) => { bot.abortConversation(ctx.from); await ctx.reply('✅ reiniciado') })
   * ```
   */
  command(name: string, handler: CommandHandler): () => void {
    const unsub = this.dispatcher.command(name, (ctx, args) => handler(this.asMessage(ctx), args))
    this.disposables.add(unsub)
    return unsub
  }

  /** Register a catch-all message handler — runs when nothing else matched. */
  onMessage(handler: MessageHandler): () => void {
    const unsub = this.dispatcher.catchAll((ctx) => handler(this.asMessage(ctx)))
    this.disposables.add(unsub)
    return unsub
  }

  /**
   * Register a typed-media handler for a specific {@link MessageType}.
   * Convenience aliases exist: {@link onImage}, {@link onAudio}, {@link onVideo}, etc.
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

  /**
   * Abort an active conversation, by chat-key/JID or by a message-context-shaped object.
   *
   * A bare string is tried as-is and, if it has no `:`, also as a DM chat-key. An object
   * (e.g. a `MessageContext`) is resolved through the runtime's `keyFor` — this is what makes
   * `/reset` work inside a group, where the active conversation is keyed per-participant
   * (`${from}:${sender}`), not just by `from`.
   *
   * @example DM
   * ```ts
   * bot.command('reset', async (ctx) => { bot.abortConversation(ctx.from); await ctx.reply('ok') })
   * ```
   * @example Group-safe (recommended)
   * ```ts
   * bot.command('reset', async (ctx) => { bot.abortConversation(ctx); await ctx.reply('ok') })
   * ```
   */
  abortConversation(target: string | { from: string; sender: string; isGroup: boolean }): boolean {
    if (typeof target !== 'string') {
      return this.runtime.abort(this.runtime.keyFor(target))
    }
    const direct = this.runtime.abort(target)
    if (target.includes(':')) return direct
    const dmKey = this.runtime.keyFor({ from: target, sender: target, isGroup: false })
    const dm = dmKey !== target ? this.runtime.abort(dmKey) : false
    return direct || dm
  }

  /* =========================================================================
   * HOOKS (before / after / error)
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

  /** Generic alias for pipeline registration. */
  hook(event: HookEvent, phase: HookPhase, handler: HookHandler, priority = 0): this {
    this.disposables.add(this.hooks.register(event, phase, handler, priority))
    return this
  }

  /* =========================================================================
   * PLUGINS
   * ====================================================================== */

  /**
   * Install a plugin with optional config. The plugin's `install(ctx, config)`
   * is called immediately with a {@link PluginContext} containing a *scoped* `bot`
   * facade, `logger`, `tools` and `config`.
   *
   * Every `command`/`when`/`onMessage`/`onType`/`before`/`after`/`onError` call made
   * through `ctx.bot` — plus anything passed to `ctx.onDispose(fn)` — is tracked, so the
   * returned `unplug()` reverts everything the plugin registered (handlers, hooks, and
   * any custom disposables such as `bot.off(...)` listeners).
   *
   * @example
   * ```ts
   * const unplug = bot.plug(slashCommandsPlugin, { greeting: 'Hi!' })
   * // later, to fully remove it:
   * unplug()
   * ```
   */
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
    // `Object.create(this)` makes scopedBot delegate reads to the real bot for anything we
    // don't override (send, provide, sub-APIs, …). EventEmitter methods are the one trap:
    // `EventEmitter.prototype.on/off` read+write `this._events`/`this._eventsCount`, and when
    // called with `this === scopedBot` a `--this._eventsCount === 0` (e.g. the plugin's LAST
    // listener being removed) reassigns a *shadow* `_events` on scopedBot instead of clearing
    // the real bot's shared map — the listener would silently keep firing after unplug(). Bind
    // these straight to the real bot so plugin `on`/`off`/`once`/`emit` calls act on it directly.
    scopedBot.on = this.on.bind(this) as Bot['on']
    scopedBot.off = this.off.bind(this) as Bot['off']
    scopedBot.once = this.once.bind(this) as Bot['once']
    scopedBot.emit = this.emit.bind(this) as Bot['emit']
    scopedBot.command = track(this.command.bind(this))
    scopedBot.when = track(this.when.bind(this))
    scopedBot.onMessage = track(this.onMessage.bind(this))
    scopedBot.onType = track(this.onType.bind(this))
    // before/after/onError return `this` on the real Bot — the scoped versions register
    // the unsubscribe with the HookSystem directly and return the scoped bot for chaining.
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
   * DEPENDENCY INJECTION (provide)
   * ====================================================================== */

  /**
   * Inject a tool available as `ctx.tools.<name>` inside handlers/hooks/plugins.
   *
   * @example
   * ```ts
   * bot.provide('db', myDatabase)
   * bot.when('visitas', async (ctx) => await ctx.reply(String(ctx.tools.db)))
   * ```
   */
  provide<T extends string>(name: T, value: unknown): this {
    this.tools[name] = value
    return this
  }

  /** Read-only tools registry snapshot. */
  get injectTools(): DefaultTools & Record<string, unknown> {
    return this.tools as DefaultTools & Record<string, unknown>
  }

  /* =========================================================================
   * SCHEDULER
   * ====================================================================== */

  /** Schedule a task with a 5-field cron expression (`min hour dom mon dow`). */
  schedule(cron: string, fn: () => void | Promise<void>): ScheduledTask {
    return this.scheduler.cron(cron, fn)
  }

  /** Run a task repeatedly at a human-like interval (`'30 seconds'`, `'5 minutes'`, or ms). */
  every(interval: string | number, fn: () => void | Promise<void>): ScheduledTask {
    return this.scheduler.every(interval, fn)
  }

  /** Run a task once after a delay (`'10 seconds'`, `'2 minutes'`, or ms). */
  delay(duration: string | number, fn: () => void | Promise<void>): ScheduledTask {
    return this.scheduler.delay(duration, fn)
  }

  /* =========================================================================
   * HELPERS
   * ====================================================================== */

  getStore(): IStore { return this.store }

  /** Connection state right now (one-shot, best-effort). */
  async getConnectionState(): Promise<string> {
    const sock = this.provider.socket as { ws?: { open?: boolean } } | null
    return sock?.ws?.open ? 'open' : 'unknown'
  }

  getSessionName() { return this.config.session ?? 'default' }

  /* =========================================================================
   * INTERNAL WIRING
   * ====================================================================== */

  /** Cast a Dispatcher context back to the rich MessageContext handed to user code. */
  private asMessage(ctx: DispatchContext): MessageContext {
    return ctx as unknown as MessageContext
  }

  /**
   * Register a Dispatcher matcher that STARTS a conversation/flow when `trigger` fires.
   *
   * The handler is intentionally fire-and-forget: `runtime.enter()` only resolves when the
   * conversation ENDS, while the Dispatcher serializes each chat's messages in a FIFO queue.
   * If we `await`ed enter() here the queue would stay blocked inside this handler, so the
   * conversation's own next message could never be dispatched → deadlock at the first `ask`.
   * We kick off enter() without awaiting and forward any failure to the `error` event.
   */
  private registerEnterMatcher(trigger: Trigger, target: string): () => void {
    const unsub = this.dispatcher.matcher(trigger, (ctx) => {
      void this.runtime.enter(target, ctx).catch((error) => this.emit('error', { error, ctx }))
    })
    this.disposables.add(unsub)
    return unsub
  }

  private requireSocket(): Socket {
    const s = this.provider.socket
    if (!s) throw new Error('Bot not connected — await bot.start() and bot.ready first')
    return s as Socket
  }

  private requireAuthCreds() {
    return (this.provider as unknown as BaileysProvider).auth.state.creds
  }

  /** Wire connection + QR events. */
  private wireConnectionEvents(): void {
    this.providerEvents.onTyped('connection', (u) => {
      this.emit('connection', u)
      if (u.state === 'qr' && u.qr) {
        this.emit('qr', u.qr)
        this.renderQr(u.qr)
      }
      if (u.state === 'open') this.emit('ready')
    })
  }

  /**
   * Wire inbound messages → context → Dispatcher, plus store persistence and the
   * forwarding of reaction/poll/call/group/presence provider events to the hook system.
   * (Replaces the deleted MessageRouter.)
   */
  private wireMessageEvents(): void {
    this.providerEvents.onTyped('rawMessage', async ({ message, type }) => {
      if (type !== 'notify') return
      if (message.key?.fromMe) return

      const jid = (message.key as { remoteJidAlt?: string })?.remoteJidAlt ?? message.key?.remoteJid ?? ''
      if (jid === 'status@broadcast') return
      if ((this.config.ignoreBroadcasts ?? true) && jid.endsWith('@broadcast')) return
      if ((this.config.ignoreNewsletters ?? true) && jid.endsWith('@newsletter')) return

      await this.store.saveMessage(message)
      await this.processMessage(message)
    })

    // Persist chats/contacts/history from provider events
    this.providerEvents.onTyped('chatsUpsert', async (chats) => {
      for (const c of chats) await this.store.upsertChat(c as Parameters<IStore['upsertChat']>[0])
    })
    this.providerEvents.onTyped('chatsUpdate', async (updates) => {
      for (const u of updates) await this.store.upsertChat(u as Parameters<IStore['upsertChat']>[0])
    })
    this.providerEvents.onTyped('chatsDelete', async (jids) => {
      for (const j of jids) await this.store.deleteChat(j)
    })
    this.providerEvents.onTyped('contactsUpsert', async (contacts) => {
      for (const c of contacts) await this.store.upsertContact(c as Parameters<IStore['upsertContact']>[0])
    })
    this.providerEvents.onTyped('contactsUpdate', async (updates) => {
      for (const u of updates) await this.store.upsertContact(u as Parameters<IStore['upsertContact']>[0])
    })
    this.providerEvents.onTyped('historySet', async (data) => {
      for (const c of data.chats) await this.store.upsertChat(c as Parameters<IStore['upsertChat']>[0])
      for (const c of data.contacts) await this.store.upsertContact(c as Parameters<IStore['upsertContact']>[0])
      for (const m of data.messages) await this.store.saveMessage(m as Parameters<IStore['saveMessage']>[0])
    })

    // Forward the remaining provider events as hook events
    this.providerEvents.onTyped('reaction', (p) => { void this.dispatchHookEvent('reaction', p) })
    this.providerEvents.onTyped('pollVote', (p) => { void this.dispatchHookEvent('poll', p) })
    this.providerEvents.onTyped('call', (p) => { void this.dispatchHookEvent('call', p) })
    this.providerEvents.onTyped('groupParticipants', (p) => { void this.dispatchHookEvent('group', p) })
    this.providerEvents.onTyped('presenceUpdate', (p) => { void this.dispatchHookEvent('presence', p) })
  }

  private async processMessage(message: WAMessage): Promise<void> {
    const ctx = buildMessageContext({
      rawMessage: message,
      tools: this.tools,
      send: (jid, content, opts) => this.provider.send(jid, content, opts) as unknown as Promise<WAMessage>,
      markRead: async (k) => { await this.provider.readMessages?.([k]) },
      presence: (s, jid) => {
        const sock = this.provider.socket as { sendPresenceUpdate?: (state: string, jid?: string) => Promise<void> } | null
        return sock?.sendPresenceUpdate ? sock.sendPresenceUpdate(s, jid) : Promise.resolve()
      },
      deleteMessage: async (k) => { await this.provider.send(k.remoteJid ?? '', { delete: k }) },
      media: { toMediaUpload, makeSticker, transcodeToOpus },
    })
    // Provide a media downloader for lazy ctx.media loading
    ;(ctx as unknown as { __mediaDownloader?: (m: WAMessage) => Promise<Buffer | NodeJS.ReadableStream> }).__mediaDownloader =
      (m) => this.provider.downloadMedia?.(m) ?? Promise.resolve(Buffer.alloc(0))

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
      this.emit('error', { error })
    }
  }

  private renderQr(qr: string): void {
    const cfg = this.config.qr ?? {}
    if (cfg.terminal) {
      import('qrcode-terminal').then((mod) => {
        mod.generate(qr, { small: cfg.small ?? true }, (output: string) =>
          process.stdout.write(`${output}\n`)
        )
      }).catch(() => {})
    }
    if (cfg.file) {
      const file = `${this.config.session ?? 'default'}.qr.png`
      import('qr-image').then((mod) => {
        const fs = require('fs')
        mod.image(qr, { type: 'png' }).pipe(fs.createWriteStream(file))
      }).catch(() => {})
    }
    if (cfg.handler) cfg.handler(qr)
  }
}

/* =============================================================================
 * TYPE GUARDS
 * ========================================================================== */

function isPluginSpec(x: unknown): x is Plugin {
  if (typeof x === 'function') return true
  return typeof x === 'object' && x !== null && 'name' in x && 'install' in x
}
