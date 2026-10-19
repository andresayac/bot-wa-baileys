/**
 * The body of the `Bot` constructor: config defaults, logger, store + namespace and every
 * subsystem, built in the same order as always (it fixes the order of the provider
 * listeners and of the bot's own listeners), then the pipeline modules over them.
 *
 * Cycles (the dispatcher's handoff gate reads `handoffs`; `handoffs.hasCommand` reads the
 * dispatcher; the ledger persists chats through `persistence`) are kept as lazy closures
 * over the kernel, never as eager reads.
 */
import pino, { type Logger } from 'pino'

import { HookSystem } from '../../hooks/HookSystem.js'
import { MemoryStore } from '../../store/MemoryStore.js'
import { NamespacedStore, type StoreNamespace } from '../../store/NamespacedStore.js'
import type { IStore } from '../../store/IStore.js'
import { ConversationRuntime, type CheckpointStore, type RuntimeMessage } from '../../conversations/ConversationRuntime.js'
import { BotCoordination } from '../../coordination/botCoordination.js'
import { createDurability } from '../../durability/bind.js'
import { createControls } from '../../conversations/controls.js'
import { FlowRouteLog } from '../../flows/inventory.js'
import type { AccessList, Whitelist } from '../../gates/accessList.js'
import { HANDOFF_INDEX_KEY, HandoffRegistry, type HandoffEvent, type HandoffOptions, type ResumeEvent } from '../../gates/handoff.js'
import { I18n } from '../../i18n/I18n.js'
import type { ConversationEndedEvent, MetricsCollector } from '../../ops/metrics.js'
import type { Scheduler } from '../../scheduler/Scheduler.js'
import { createBotScheduler } from '../../scheduler/botScheduler.js'
import { UserDataService } from '../../user/UserDataService.js'
import { KeyedQueue } from '../../utils/keyedQueue.js'
import { parseTimerDuration } from '../../utils/timers.js'
import { validateConfig } from '../../utils/validateConfig.js'
import { Dispatcher } from '../Dispatcher.js'
import { createInboundDeduper } from '../dedupe.js'
import { DynamicFlowRegistry } from '../flowRegistry.js'
import type { ChatIdleWatchers } from '../idle.js'
import { MessageLog } from '../ledger.js'
import { ExternalSendClock, createPacer, normalizeTypingConfig } from '../messaging.js'
import type { BotConfig, ChatId, MessageContext, Trigger } from '../types.js'
import { WelcomeTracker } from '../welcome.js'
import { createContextFactory, type ContextFactory } from './contextFactory.js'
import { createEventSink, dispatcherEmit, type EventHost } from './events.js'
import { InboundPipeline } from './inbound.js'
import { asMessage, DisposableList, type BotKernel, type LifecycleState } from './kernel.js'
import { Lifecycle, defaultLifecycleSteps } from './lifecycle.js'
import { BotOps, resolveLang } from './ops.js'
import { OutboundPipeline } from './outbound.js'
import { Persistence } from './persistence.js'
import { PluginHost } from './pluginHost.js'
import { RouteRegistrar } from './routes.js'

/** What `composeBot` needs from the real bot: its events plus the late-bound seams. */
export interface ComposeHost extends EventHost {
  /** Private `Bot.registerEnterMatcher`, called through the bot at call time. */
  registerEnterMatcher(trigger: Trigger, target: string): () => void
  /** Private `Bot.isChatHandedOff`. */
  isChatHandedOff(chatId: ChatId): boolean
  handoff(chatId: ChatId, opts?: HandoffOptions): Promise<boolean>
}

/** State the bot creates in its field initializers (they run before the constructor body). */
export interface ComposeFields {
  state: LifecycleState
  scheduler: Scheduler
  idle: ChatIdleWatchers
  counters: MetricsCollector
  blacklist: AccessList
  whitelist: Whitelist
}

export interface BotParts {
  kernel: BotKernel
  /** `config.store` (or the built-in MemoryStore) before namespacing. */
  baseStore: IStore
  ready: Promise<void>
  lifecycle: Lifecycle
  outbound: OutboundPipeline
  inbound: InboundPipeline
  persistence: Persistence
  contextFor: ContextFactory
  routes: RouteRegistrar
  plugins: PluginHost
  ops: BotOps
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] }

export function composeBot(host: ComposeHost, inputConfig: BotConfig, fields: ComposeFields): BotParts {
  validateConfig(inputConfig)
  if (!inputConfig.provider) {
    throw new Error(
      'Bot requires a transport provider. Construct one and pass it: ' +
        "new Bot({ provider: new BaileysProvider({ session: 'demo' }) }). " +
        'See @bot-wa/baileys for the WhatsApp transport.',
    )
  }
  const k = {} as Mutable<BotKernel>
  const config: BotConfig = { commandPrefix: '/', ...inputConfig }
  const provider = inputConfig.provider
  k.config = config
  k.provider = provider
  k.inboundDedupe = createInboundDeduper(inputConfig.dedupe)

  const logger: Logger = inputConfig.logger as Logger ?? pino({
    // 'warn' by default so plugin/handler failures logged at warn stay visible.
    level: inputConfig.debug ? 'debug' : 'warn',
  })
  k.logger = logger
  k.state = fields.state
  k.scheduler = fields.scheduler
  k.idle = fields.idle
  k.counters = fields.counters
  k.access = { blacklist: fields.blacklist, whitelist: fields.whitelist }
  k.tools = {}
  k.disposables = new DisposableList()
  k.flowRoutes = new FlowRouteLog()
  k.chatWrites = new KeyedQueue()
  k.externalSends = new ExternalSendClock()
  k.inflightSends = new Set()
  k.inflightEvents = new Set()
  k.events = createEventSink(host, fields.counters, () => logger)
  k.isHandedOff = (chatId) => host.isChatHandedOff(chatId)

  k.hooks = new HookSystem(logger.child({ module: 'hooks' }))
  k.pacer = createPacer({
    provider,
    typing: normalizeTypingConfig(inputConfig.typing),
    logger,
    signal: () => k.state.sendsAbort.signal,
  })

  // Store — injected instance, or the built-in MemoryStore. Every key is
  // namespaced so sharing one backend across bots cannot collide.
  const baseStore =
    (typeof config.store === 'object' && config.store !== null
      ? (config.store as IStore)
      : null) ??
    new MemoryStore({
      file: (config.storeConfig as { file?: string } | undefined)?.file,
      maxMessagesPerChat: (config.storeConfig as { maxMessagesPerChat?: number } | undefined)?.maxMessagesPerChat,
      autoSaveInterval: (config.storeConfig as { autoSaveInterval?: number } | undefined)?.autoSaveInterval,
      logger: logger.child({ module: 'store' }),
    })
  let namespace: StoreNamespace = {
    tenantId: config.tenantId ?? 'local',
    environmentId: config.environmentId ?? 'default',
    botId: config.botId ?? config.session ?? provider.id,
    providerId: provider.id,
    connectionId: config.connectionId ?? config.session ?? 'default',
  }
  let store: IStore
  if (baseStore instanceof NamespacedStore) {
    store = baseStore
    namespace = baseStore.namespace
  } else {
    store = new NamespacedStore(baseStore, namespace)
  }
  k.store = store
  k.namespace = namespace
  // Durable scheduler tasks (opt-in): only replaced when `BotConfig.scheduler` is set. Its
  // leadership defaults to the multi-replica coordinator (`BotConfig.coordination`).
  if (config.scheduler) k.scheduler = createBotScheduler(config.scheduler, namespace, config.coordination?.coordinator)
  const persistence = new Persistence(store, k.chatWrites)
  k.messageLog = new MessageLog({
    store,
    namespace,
    selfId: () => provider.selfId ?? undefined,
    persistChat: (chat) => persistence.persistChat(chat),
    reportError: (error) => k.events.error({ error }),
  })
  k.users = new UserDataService(store, { logger: logger.child({ module: 'user-data' }) })
  k.i18n = new I18n({ logger: logger.child({ module: 'i18n' }) })
  if (config.i18n !== undefined) k.i18n.configure(config.i18n)

  const conv = config.conversation ?? {}
  k.runtime = new ConversationRuntime({
    controlsFactory: createControls,
    defaultTimeoutMs: conv.timeout !== undefined ? parseTimerDuration(conv.timeout, 'conversation.timeout') : undefined,
    timeoutMessage: conv.timeoutMessage,
    retriesMessage: conv.retriesMessage,
    errorMessage: conv.errorMessage,
    cancelledMessage: conv.cancelledMessage,
    scope: config.conversationScope === 'chat' ? 'chat' : 'participant',
    logger: logger.child({ module: 'conversations' }),
    onError: (error, ctx) => k.events.error({ error, ctx: ctx as unknown as MessageContext }),
    onConversationStart: ({ id, name, key, ctx }) => {
      k.counters.conversationStarted(name)
      k.events.safely('conversation:started', { id, name, key, chatId: ctx.from, userId: ctx.sender })
    },
    onConversationEnd: ({ id, name, key, ctx, outcome, durationMs, goto }) => {
      k.counters.conversationEnded(name, outcome, durationMs)
      const event: ConversationEndedEvent = {
        id, name, key, chatId: ctx.from, userId: ctx.sender, outcome, completed: outcome === 'completed', durationMs,
      }
      if (goto !== undefined) event.goto = goto
      k.events.safely('conversation:ended', event)
    },
    // Multi-replica: timers of a conversation act only under the chat's turn (a stale
    // replica's timer refreshes instead of messaging the user or clearing the checkpoint).
    ...(config.coordination
      ? {
          trackParked: true,
          timerGate: (_key: string, ctx: RuntimeMessage, fire: () => unknown) => {
            void k.dispatcher.runExclusive(ctx, async () => { await fire() }).catch(() => {})
          },
        }
      : {}),
  })
  if (typeof (store as Partial<CheckpointStore>).setCheckpoint === 'function') {
    k.runtime.attachStore(store as CheckpointStore)
  }

  k.flowRegistry = new DynamicFlowRegistry({
    runtime: k.runtime,
    enterMatcher: (trigger, target) => host.registerEnterMatcher(trigger, target),
  })

  k.welcome = new WelcomeTracker({ store, onError: (error) => k.events.error({ error }) })

  if (config.coordination) {
    k.coordination = new BotCoordination({
      config: config.coordination,
      provider,
      runtime: k.runtime,
      logger: logger.child({ module: 'coordination' }),
      emit: (event, payload) => { k.events.emit(event, payload) },
      reportError: (error, ctx) => k.events.error({ error, ctx: ctx as unknown as MessageContext | undefined }),
    })
  }

  /** `ctx.lang` as `prepare` resolved it, to tell whether a hook overrode it. */
  const preparedLang = new WeakMap<object, string>()
  k.dispatcher = new Dispatcher({
    hooks: k.hooks,
    runtime: k.runtime,
    commandPrefix: config.commandPrefix,
    firstContact: (ctx) => k.welcome.isFirstContact(ctx),
    // A message queued before stop() is dropped when its turn comes after it.
    isOpen: () => k.state.acceptingInbound,
    turns: k.coordination?.turns,
    logger: logger.child({ module: 'dispatcher' }),
    emit: dispatcherEmit(k.events),
    gate: (ctx) => {
      const admitted = k.handoffs.admits(ctx)
      if (!admitted) k.counters.handoffDropped()
      return admitted
    },
    prepare: async (ctx) => {
      if (!k.i18n.enabled) return
      const mctx = asMessage(ctx)
      await resolveLang(k.i18n, mctx)
      preparedLang.set(mctx, mctx.lang)
    },
    // A before('message') hook rewrote ctx.body (e.g. a voice transcript): let a
    // body-based detector see the final text. Skipped when the language came from a
    // signal the body cannot change (stored preference, provider) or when a hook
    // already set ctx.lang itself.
    reprepare: async (ctx) => {
      if (!k.i18n.enabled || !k.i18n.hasDetector) return
      const mctx = asMessage(ctx)
      if (mctx.langSource !== 'detector' && mctx.langSource !== 'default') return
      if (preparedLang.get(mctx) !== mctx.lang) return
      await resolveLang(k.i18n, mctx)
    },
  })

  // The handoff index lives under a store cursor key; a backend without cursor support
  // makes the registry fall back to scanning listChats() on start.
  const backing = baseStore instanceof NamespacedStore ? baseStore.innerStore : baseStore
  const hasCursors = typeof backing.getCursor === 'function' && typeof backing.setCursor === 'function'
  k.handoffs = new HandoffRegistry({
    store: {
      writeHandoff: (chatId, handoff) => persistence.writeHandoff(chatId, handoff),
      getChat: (chatId) => store.getChat(chatId),
      listChats: () => store.listChats(),
    },
    index: hasCursors
      ? {
          get: async () => store.getCursor?.(HANDOFF_INDEX_KEY),
          set: async (value) => { await store.setCursor?.(HANDOFF_INDEX_KEY, value) },
        }
      : undefined,
    config: config.handoff,
    commandPrefix: config.commandPrefix,
    hasCommand: (name) => k.dispatcher.hasCommand(name),
    abortChat: (chatId) => { k.runtime.abortChat(chatId) },
    emit: (event: 'handoff' | 'resume', payload: HandoffEvent | ResumeEvent) => { k.events.emit(event, payload) },
    reportError: (error) => k.events.error({ error }),
    logger: logger.child({ module: 'handoff' }),
  })

  // Durable inbox/outbox (opt-in). Replays go through the inbound pipeline (built below:
  // the closures only read it at call time).
  let inbound!: InboundPipeline
  k.durable = createDurability(config.durability, {
    logger: logger.child({ module: 'durability' }),
    namespace,
    hooks: k.hooks,
    messageLog: k.messageLog,
    provider,
    persistRaw: config.persistRaw === true,
    admits: (ids) => inbound.admitsSender(ids),
    handleInbound: (m) => inbound.handleInbound(m),
    handleInteraction: (i) => inbound.handleInteraction(i),
    emit: (event, payload) => { k.events.emit(event, payload) },
    reportError: (error) => k.events.error({ error }),
  })

  const ready = new Promise<void>((resolve) => {
    const off = provider.onEvent((e) => {
      if (e.kind === 'connection' && e.update.state === 'ready') { off(); resolve() }
    })
  })

  const kernel: BotKernel = k
  const outbound = new OutboundPipeline(kernel)
  const contextFor = createContextFactory(kernel, outbound, (chatId, opts) => host.handoff(chatId, opts))
  inbound = new InboundPipeline(kernel, contextFor, persistence)
  // Subscribed after the `ready` listener: the `ready` promise resolves before 'ready' handlers run.
  kernel.disposables.add(inbound.attach())

  return {
    kernel,
    baseStore,
    ready,
    lifecycle: new Lifecycle(kernel, defaultLifecycleSteps(kernel)),
    outbound,
    inbound,
    persistence,
    contextFor,
    routes: new RouteRegistrar(kernel),
    plugins: new PluginHost(kernel),
    ops: new BotOps(kernel, contextFor),
  }
}
