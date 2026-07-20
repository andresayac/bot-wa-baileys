/**
 * Bot — public entry point of `@bot-wa/bot-wa-baileys`.
 *
 * A modern WhatsApp bot framework built on Baileys 7. Provides a declarative
 * API (`when`, `flow`, `plug`), hooks (`before`/`after`/`onError`), dependency
 * injection (`provide`), a scheduler (`schedule`/`every`/`delay`) and typed
 * sub-APIs (`groups`, `profile`, `privacy`, `chats`, `presence`).
 *
 * @example Create and start a bot
 * ```ts
 * import { Bot } from '@bot-wa/bot-wa-baileys'
 *
 * const bot = new Bot({
 *   session: 'demo-bot',
 *   sessionsDir: './sessions',
 *   qr: { terminal: true, small: true },
 *   markOnlineOnConnect: false,
 *   ignoreNewsletters: true,
 *   ignoreBroadcasts: true,
 * })
 *
 * bot.on('ready', () => console.log('✅ connected'))
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
 * bot.before('message', async (ctx, next) => {
 *   console.log('📥', ctx.from, ctx.body)
 *   await next()
 * })
 * bot.after('message', async (ctx) => console.log('📤 processed'))
 * bot.onError('message', async (ctx, err) => console.error(err))
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
 * bot.every('30 seconds', () => console.log('heartbeat'))
 * bot.schedule('0 9 * * 1-5', async () => { /* weekday 9am *\/ })
 * bot.delay('10 seconds', () => console.log('10s elapsed'))
 * ```
 *
 * Naming is unique and intuitive — not a copy of telegram/express.
 */

import { EventEmitter } from 'events'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import pino, { type Logger } from 'pino'

import type {
  BotConfig,
  ChatId,
  ConnectionUpdate,
  DefaultTools,
  Flow,
  HookEvent,
  HookHandler,
  HookPhase,
  MessageContext,
  MessageType,
  Plugin,
  ScheduledTask,
  SentMessage,
  GroupsAPI,
  ProfileAPI,
  PrivacyAPI,
  ChatsAPI,
  PresenceAPI,
} from './types'

import { HookSystem } from '../hooks/HookSystem'
import { BaileysProvider } from '../provider/BaileysProvider'
import { MemoryStore } from '../store/MemoryStore'
import type { IStore } from '../store/IStore'
import { MessageRouter } from './MessageRouter'
import { FlowEngine } from '../flows/FlowEngine'
import { randomId } from '../utils/timers'
import { GroupsAPIImpl } from '../api/GroupsAPI'
import { ProfileAPIImpl } from '../api/ProfileAPI'
import { PrivacyAPIImpl } from '../api/PrivacyAPI'
import { ChatsAPIImpl } from '../api/ChatsAPI'
import { PresenceAPIImpl } from '../api/PresenceAPI'
import { Scheduler } from '../scheduler/Scheduler'
import { toMediaUpload, makeSticker, transcodeToOpus } from '../media/MediaProcessor'

type AnyHandler = (ctx: MessageContext) => void | Promise<void>

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
  private provider: BaileysProvider
  private flows = new FlowEngine({ store: undefined })
  private scheduler = new Scheduler()
  private router: MessageRouter
  private tools: Record<string, any> = {}
  private disposables = new DisposableList()
  private isStarted = false

  /**
   * Promise resolved when the bot reaches the `'open'` connection state.
   * Useful to `await bot.ready` before sending proactive messages.
   *
   * @example
   * ```ts
   * await bot.start()
   * await bot.ready
   * await bot.sendText('57300XXXXXXX@s.whatsapp.net', 'hi')
   * ```
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
    } as any

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
        file: (this.config.storeConfig as any)?.file,
        maxMessagesPerChat: (this.config.storeConfig as any)?.maxMessagesPerChat,
        autoSaveInterval: (this.config.storeConfig as any)?.autoSaveInterval,
      })

    // Flow engine with store backing
    this.flows = new FlowEngine({
      store: this.store as any,
      logger: this.logger.child({ module: 'flows' }),
    })

    // Provider
    mkdirSync(dirname(this.config.sessionsDir! + '/' + this.config.session!), { recursive: true })
    this.provider = new BaileysProvider(
      this.config,
      this.logger.child({ module: 'provider' }),
      async (key) => this.store.getMessage(key)
    )

    // Message router — extracted from Bot
    this.router = new MessageRouter({
      provider: this.provider,
      store: this.store,
      hooks: this.hooks,
      flows: this.flows,
      tools: this.tools,
      config: {
        ignoreBroadcasts: this.config.ignoreBroadcasts ?? true,
        ignoreNewsletters: this.config.ignoreNewsletters ?? true,
      },
      emit: (event, payload) => this.emit(event, payload),
    })

    // Setup ready promise
    this.ready = new Promise<void>((resolve) => {
      const listener = (u: ConnectionUpdate) => {
        if (u.state === 'open') {
          this.provider.offTyped('connection', listener)
          resolve()
        }
      }
      this.provider.onTyped('connection', listener)
    })

    // Wire sub-APIs
    this.groups = new GroupsAPIImpl(() => this.requireSocket())
    this.profile = new ProfileAPIImpl(() => this.requireSocket(), () => this.requireAuthCreds())
    this.privacy = new PrivacyAPIImpl(() => this.requireSocket())
    this.chats = new ChatsAPIImpl(() => this.requireSocket(), this.store)
    this.presence = new PresenceAPIImpl(() => this.requireSocket())

    this.wireProviderEvents()
    this.router.wireProviderEvents()
  }

  /* =========================================================================
   * LIFECYCLE
   * ====================================================================== */

  async start(): Promise<void> {
    if (this.isStarted) return
    this.isStarted = true

    await this.store.start()
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
   *
   * @example
   * ```ts
   * await bot.send('57300XXXXXXX@s.whatsapp.net', { text: 'hi' })
   * await bot.send(groupId, { image: { url }, caption: 'look' })
   * ```
   */
  async send(jid: ChatId, content: any, options?: any): Promise<SentMessage> {
    const msg = await this.provider.send(jid, content, options)
    return { jid, messageId: msg.key.id!, key: msg.key, raw: msg }
  }

  /**
   * Helper to send plain text to a JID.
   *
   * @example
   * ```ts
   * await bot.sendText('57300XXXXXXX@s.whatsapp.net', 'Hello!')
   * ```
   */
  async sendText(jid: ChatId, text: string): Promise<SentMessage> {
    return this.send(jid, { text })
  }

  /**
   * Broadcast a message to multiple JIDs (one sendMessage per JID).
   * Returns the list of successful sends and per-JID failures.
   *
   * @example
   * ```ts
   * const { sent, failed } = await bot.broadcast(
   *   ['573001234567@s.whatsapp.net', '573009876543@s.whatsapp.net'],
   *   { text: '📣 announcement' },
   * )
   * console.log(`sent=${sent.length}, failed=${failed.length}`)
   * ```
   */
  async broadcast(jids: ChatId[], content: any): Promise<{ sent: SentMessage[]; failed: Array<{ jid: ChatId; error: Error }> }> {
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
   * DECLARATIVE API (when / when-type)
   * ====================================================================== */

  /**
   * Match an inbound message by keyword/regex/list and execute a handler.
   * Matching is case-insensitive substring (`contains`) for strings, and
   * `RegExp.test` for regexes. Returns an unsubscriber function.
   *
   * @example Text match
   * ```ts
   * bot.when('hola', async (ctx) => await ctx.reply('👋 ¡Hola!'))
   * ```
   *
   * @example Multiple keywords
   * ```ts
   * bot.when(['adios', 'chao', 'bye'], async (ctx) => await ctx.reply('👋 bye'))
   * ```
   *
   * @example Regex match
   * ```ts
   * bot.when(/\d{4,}/, async (ctx) => await ctx.reply('long number detected'))
   * ```
   *
   * @example Attach a flow (the flow triggers when the keyword matches)
   * ```ts
   * bot.when('soporte', supportFlow)
   * ```
   */
  when(
    pattern: string | RegExp | (string | RegExp)[],
    handler: AnyHandler | Flow
  ): () => void {
    const id = randomId('when')
    const matchers = Array.isArray(pattern) ? pattern : [pattern]

    const matchFn = (ctx: MessageContext): boolean => {
      const body = ctx.body ?? ''
      return matchers.some((p) => {
        if (p instanceof RegExp) return p.test(body)
        const lower = body.toLowerCase()
        return lower.includes(String(p).toLowerCase())
      })
    }

    if (isFlowRun(handler)) {
      this.flows.register(handler)
      return this.router.addPatternHandler(id, matchFn, async (ctx) => {
        await this.flows.runFromMatch(ctx, {
          send: async (text) => { await ctx.text(text) },
          end: () => this.flows.end(ctx.from),
        }, handler)
      })
    } else {
      return this.router.addPatternHandler(id, matchFn, handler as AnyHandler)
    }
  }

  /**
   * Register a catch-all message handler — runs when no `when()`/flow matched.
   *
   * @example
   * ```ts
   * bot.onMessage(async (ctx) => await ctx.reply('🤔 no reconocí ese comando'))
   * ```
   */
  onMessage(handler: AnyHandler): () => void {
    return this.router.addMessageHandler(handler)
  }

  /**
   * Register a typed-media handler for a specific {@link MessageType}.
   * Convenience aliases exist: {@link onImage}, {@link onAudio}, {@link onVideo},
   * {@link onDocument}, {@link onSticker}, {@link onLocation}, {@link onContact}, {@link onPoll}.
   *
   * @example
   * ```ts
   * bot.onImage(async (ctx) => await ctx.reply('📸 got your image!'))
   * bot.onAudio(async (ctx) => await ctx.reply('🎵 got your audio!'))
   * ```
   */
  onType(type: MessageType, handler: AnyHandler): () => void {
    return this.router.addTypeHandler(type, handler)
  }
  onImage(handler: AnyHandler) { return this.onType('image', handler) }
  onAudio(handler: AnyHandler) { return this.onType('audio', handler) }
  onVideo(handler: AnyHandler) { return this.onType('video', handler) }
  onDocument(handler: AnyHandler) { return this.onType('document', handler) }
  onSticker(handler: AnyHandler) { return this.onType('sticker', handler) }
  onLocation(handler: AnyHandler) { return this.onType('location', handler) }
  onContact(handler: AnyHandler) { return this.onType('contact', handler) }
  onPoll(handler: AnyHandler) { return this.onType('poll', handler) }

  /* =========================================================================
   * FLOWS
   * ====================================================================== */
  useFlow(flow: Flow): this { this.flows.register(flow); return this }
  /**
   * Generic `use()` — accepts flows or plugins (or an array of either).
   * Flows are registered with the flow engine; plugins are installed via {@link plug}.
   *
   * @example
   * ```ts
   * bot.use([registerFlow, buyFlow, supportFlow])
   * bot.use(slashCommandsPlugin)
   * ```
   */
  use(item: Flow | Plugin | (Flow | Plugin)[]): this {
    const items = Array.isArray(item) ? item : [item]
    for (const i of items) {
      if (isFlowRun(i)) this.flows.register(i as Flow)
      else if (isPluginSpec(i)) this.plug(i as Plugin)
      else throw new Error('use() expects a Flow or Plugin')
    }
    return this
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
   * is called immediately with a {@link PluginContext} containing `bot`, `logger`,
   * `tools` and `config`.
   *
   * @example
   * ```ts
   * bot.plug(slashCommandsPlugin, { greeting: 'Hi!' })
   * bot.plug(rateLimitPlugin, { max: 20, windowMs: 60_000 })
   * ```
   */
  plug(plugin: Plugin, config?: Record<string, unknown>): this {
    const spec = typeof plugin === 'function' ? plugin(config) : plugin
    const ctx = {
      bot: this,
      logger: this.logger.child({ plugin: spec.name }),
      tools: this.tools,
      config: config ?? {},
    }
    spec.install(ctx as any, config as any)
    return this
  }

  /* =========================================================================
   * DEPENDENCY INJECTION (provide)
   * ====================================================================== */

  /**
   * Inject a tool available as `ctx.tools.<name>` inside handlers/hooks/plugins.
   *
   * @example
   * ```ts
   * bot.provide('db', {
   *   users: new Map(),
   *   async touch(jid) { /* ... *\/ },
   * })
   *
   * bot.when('visitas', async (ctx) => {
   *   const user = await ctx.tools.db.touch(ctx.from)
   *   await ctx.reply(`visits: ${user.visits}`)
   * })
   * ```
   */
  provide<T extends string>(name: T, value: any): this {
    this.tools[name] = value
    return this
  }

  /** Read-only tools registry snapshot. */
  get injectTools() {
    return this.tools as DefaultTools & Record<string, any>
  }

  /* =========================================================================
   * SCHEDULER
   * ====================================================================== */

  /**
   * Schedule a task with a cron expression (5-field standard: `min hour dom mon dow`).
   *
   * @example
   * ```ts
   * bot.schedule('0 9 * * 1-5', async () => {
   *   await bot.sendText('57300XXXXXXX@s.whatsapp.net', '🌅 good morning')
   * })
   * ```
   */
  schedule(cron: string, fn: () => void | Promise<void>): ScheduledTask {
    return this.scheduler.cron(cron, fn)
  }

  /**
   * Run a task repeatedly at a human-like interval (`'30 seconds'`, `'5 minutes'`, or ms).
   *
   * @example
   * ```ts
   * bot.every('30 seconds', () => console.log('💓 heartbeat'))
   * ```
   */
  every(interval: string | number, fn: () => void | Promise<void>): ScheduledTask {
    return this.scheduler.every(interval, fn)
  }

  /**
   * Run a task once after a delay (`'10 seconds'`, `'2 minutes'`, or ms).
   *
   * @example
   * ```ts
   * bot.delay('10 seconds', () => console.log('⏰ 10s elapsed'))
   * ```
   */
  delay(duration: string | number, fn: () => void | Promise<void>): ScheduledTask {
    return this.scheduler.delay(duration, fn)
  }

  /* =========================================================================
   * HELPERS
   * ====================================================================== */

  getStore(): IStore { return this.store }

  /** Connection state right now (one-shot, best-effort). */
  async getConnectionState(): Promise<string> {
    const sock = this.provider.socket as any
    return sock?.ws?.open ? 'open' : 'unknown'
  }

  getSessionName() { return this.config.session ?? 'default' }

  /** Abort any active flow for a user (public, for slash commands). */
  abortFlow(userId: string): void {
    this.flows.abortFlow(userId)
  }

  /* =========================================================================
   * INTERNAL WIRING
   * ====================================================================== */

  private requireSocket() {
    const s = this.provider.socket
    if (!s) throw new Error('Bot not connected — await bot.start() and bot.ready first')
    return s
  }

  private requireAuthCreds() {
    return this.provider.auth.state.creds
  }

  /** Wire only connection + QR events (message routing is in MessageRouter). */
  private wireProviderEvents(): void {
    this.provider.onTyped('connection', (u) => {
      this.emit('connection', u)
      if (u.state === 'qr' && u.qr) {
        this.emit('qr', u.qr)
        this.renderQr(u.qr)
      }
      if (u.state === 'open') this.emit('ready')
    })
  }

  private renderQr(qr: string): void {
    const cfg = this.config.qr ?? {}
    if (cfg.terminal) {
      import('qrcode-terminal').then((mod) => {
        mod.generate(qr, { small: cfg.small ?? true }, (output: string) =>
          console.log(output)
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

function isFlowRun(x: any): x is Flow {
  return x && typeof x === 'object' && 'keyword' in x && 'steps' in x && typeof x.test === 'function'
}

function isPluginSpec(x: any): x is Plugin {
  if (typeof x === 'function') return true
  return x && typeof x === 'object' && 'name' in x && 'install' in x
}
