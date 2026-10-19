/**
 * The shared internals of one {@link Bot}: every subsystem object and the mutable
 * lifecycle state, built once by `composeBot()` and handed to the pipeline modules
 * (`lifecycle`, `inbound`, `outbound`, `routes`, `pluginHost`, `ops`, `gates`, `lang`).
 *
 * Internal — no semver guarantee. The kernel always belongs to the REAL bot: a
 * plugin-scoped bot (`Object.create(bot)`) reads it through the prototype, so state
 * written through either object is the same state.
 */
import type { Logger } from 'pino'

import type { HookSystem } from '../../hooks/HookSystem.js'
import type { IStore } from '../../store/IStore.js'
import type { StoreNamespace } from '../../store/NamespacedStore.js'
import type { ConversationRuntime } from '../../conversations/ConversationRuntime.js'
import type { Scheduler } from '../../scheduler/Scheduler.js'
import type { FlowRouteLog } from '../../flows/inventory.js'
import type { AccessList, Whitelist } from '../../gates/accessList.js'
import type { HandoffRegistry } from '../../gates/handoff.js'
import type { UserDataService } from '../../user/UserDataService.js'
import type { MetricsCollector } from '../../ops/metrics.js'
import type { I18n } from '../../i18n/I18n.js'
import type { KeyedQueue } from '../../utils/keyedQueue.js'
import type { BotConfig, ChatId, ConnectionState, IProvider, MessageContext, OutboundContent } from '../types.js'
import type { DispatchContext, Dispatcher } from '../Dispatcher.js'
import type { ExternalSendClock, Pacer } from '../messaging.js'
import type { InboundDeduper } from '../dedupe.js'
import type { ChatIdleWatchers } from '../idle.js'
import type { WelcomeTracker } from '../welcome.js'
import type { DynamicFlowRegistry } from '../flowRegistry.js'
import type { MessageLog } from '../ledger.js'
import type { BotCoordination } from '../../coordination/botCoordination.js'
import type { DurableEngine } from '../../durability/bind.js'
import type { TracingImpl } from '../../telemetry/tracing.js'

/** Mutable start/stop state of a bot (one object, shared by every module). */
export interface LifecycleState {
  isStarted: boolean
  /** Inbound events are processed (false before `start()` and from the first line of `stop()`). */
  acceptingInbound: boolean
  /**
   * Paced replies may still go out once their wait ends. Opened by `start()`, closed by
   * `stop()` after the optional drain — a reply waiting on its typing indicator past that
   * point is dropped instead of hitting a stopped provider.
   */
  pacedSendsOpen: boolean
  connState: ConnectionState
  /** Aborted by `stop()`: cancels running broadcasts so nothing is sent through a stopped provider. */
  lifecycleAbort: AbortController
  /**
   * Aborted by `stop()` when `pacedSendsOpen` closes (after the optional drain): wakes paced
   * replies still waiting and cancels running `ctx.stream()`s, so no timer outlives stop.
   */
  sendsAbort: AbortController
}

export function createLifecycleState(): LifecycleState {
  return {
    isStarted: false,
    acceptingInbound: false,
    pacedSendsOpen: false,
    connState: 'closed',
    lifecycleAbort: new AbortController(),
    sendsAbort: new AbortController(),
  }
}

/** Tiny helper to keep a list of unsubscribers. */
export class DisposableList {
  private list: Array<() => void> = []
  add(fn: () => void) { this.list.push(fn) }
  disposeAll() { while (this.list.length) this.list.pop()!() }
}

/** The bot's error / observability event outlet (see `events.ts`). */
export interface BotEventSink {
  /** Late-bound `bot.emit` (a spy or subclass override installed later is honoured). */
  emit(event: string, ...args: unknown[]): boolean
  listenerCount(event: string): number
  /** Count the error, then emit `'error'` — or log it when nobody listens. */
  error(payload: { error: unknown; ctx?: MessageContext }): void
  /** Emit an observability event; a throwing listener is reported, never propagated. */
  safely(event: 'conversation:started' | 'conversation:ended', payload: unknown): void
}

export interface BotKernel {
  readonly config: BotConfig
  readonly logger: Logger
  readonly provider: IProvider
  /** The namespaced store every module reads and writes. */
  readonly store: IStore
  readonly namespace: StoreNamespace
  readonly hooks: HookSystem
  readonly runtime: ConversationRuntime
  readonly dispatcher: Dispatcher
  readonly handoffs: HandoffRegistry
  readonly welcome: WelcomeTracker
  readonly users: UserDataService
  readonly i18n: I18n
  readonly messageLog: MessageLog
  readonly counters: MetricsCollector
  readonly pacer: Pacer
  readonly scheduler: Scheduler
  readonly idle: ChatIdleWatchers
  readonly flowRegistry: DynamicFlowRegistry
  /** Trigger routes, kept for `describe()` / `lint()` introspection. */
  readonly flowRoutes: FlowRouteLog
  readonly access: { readonly blacklist: AccessList; readonly whitelist: Whitelist }
  /** Inbound idempotency guard (`BotConfig.dedupe`); `null` when disabled. */
  readonly inboundDedupe: InboundDeduper | null
  /** Serializes this bot's chat upserts per chat (see `persistence.ts`). */
  readonly chatWrites: KeyedQueue
  /** Sends outside a chat's own `ctx` replies — they invalidate `ctx.edit(content)` targets. */
  readonly externalSends: ExternalSendClock
  /** In-flight outbound sends — tracked so `stop({ drain: true })` can wait for them. */
  readonly inflightSends: Set<Promise<unknown>>
  /** Provider events still being handled (stored, dispatched) — see `Bot.isBusy`. */
  readonly inflightEvents: Set<Promise<void>>
  readonly tools: Record<string, unknown>
  readonly disposables: DisposableList
  readonly state: LifecycleState
  readonly events: BotEventSink
  /** Late-bound handoff check (`bot.isHandedOff`, a subclass may override it). */
  readonly isHandedOff: (chatId: ChatId) => boolean
  /** Multi-replica coordination (`BotConfig.coordination`); `undefined` for a single process. */
  readonly coordination?: BotCoordination
  /** Durable inbox/outbox (`BotConfig.durability`); `null` when off — every durable branch checks it. */
  readonly durable: DurableEngine | null
  /** Tracing (`BotConfig.telemetry`); `null` when off — every instrumentation site checks it first. */
  readonly tracing: TracingImpl | null
}

/**
 * Multi-replica fence for anything that reaches the transport (sends, edits, stream
 * previews, deletes, read receipts, typing): throws when this replica's turn on the chat
 * being worked on was lost, or it does not hold the provider session. No-op without
 * `coordination`.
 */
export function assertCoordinated(k: BotKernel): void {
  k.coordination?.assertSend(k.dispatcher.currentKey())
}

/** The dispatcher's context type is the full `MessageContext` the bot built. */
export function asMessage(ctx: DispatchContext): MessageContext { return ctx as unknown as MessageContext }

/** Does `x` look like a promise? */
export function isThenable(x: unknown): x is PromiseLike<unknown> {
  return typeof (x as { then?: unknown } | null | undefined)?.then === 'function'
}

/** A plain string is sent as text (`bot.send`, `bot.enqueue`, `bot.broadcast`). */
export function toOutbound(content: string | OutboundContent): OutboundContent {
  return typeof content === 'string' ? { kind: 'text', text: content } : content
}
