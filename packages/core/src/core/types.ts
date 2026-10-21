/**
 * @botmesh/core — Public Types
 * ===========================
 *
 * Transport-agnostic. The provider/message/store contract lives in
 * `core/provider.ts`; this module re-exports the shared pieces and adds the
 * core-only vocabulary (hooks, plugins, triggers, scheduler, conversations).
 * WhatsApp-specific types (JID, QrConfig, GroupsAPI, …) live in @botmesh/baileys.
 */

import type { Logger } from 'pino'
import type { RuntimeMessage } from '../conversations/ConversationRuntime.js'
import type { Bot } from './Bot.js'
import type {
  CallEvent, ChatId, ConnectionUpdate, DefaultTools, DeliveryStatus, GroupEvent, InboundReaction, MessageContext,
  MessageRef, OutboundContent, PollVote, PresenceEvent, SendOptions, SentMessage,
} from './provider.js'
import type { TypeTrigger, WelcomeTrigger } from './triggers.js'

/* ============================================================================
 * SHARED CONTRACT (re-exported from core/provider.ts)
 * ========================================================================== */

export type {
  ChatId,
  UserId,
  MessageId,
  MessageRef,
  QuotedRef,
  ChatKind,
  ChatInfo,
  SenderInfo,
  MessageType,
  MediaRef,
  MediaPayload,
  MediaSource,
  InboundEvent,
  InboundLocation,
  InboundMessage,
  InboundInteraction,
  DeliveryStatus,
  InboundReaction,
  PollVote,
  GroupEvent,
  PresenceEvent,
  CallEvent,
  Button,
  ListSection,
  SendOptions,
  OutboundContent,
  SendResult,
  ProviderCapabilities,
  ConnectionState,
  DisconnectReason,
  ConnectionUpdate,
  IProvider,
  MessageContext,
  SentMessage,
  DefaultTools,
  BuildContextDeps,
  StoreKind,
  BotConfig,
  LoggerLike,
  StoredMessage,
  StoredChat,
  StoredContact,
  FlowCheckpoint,
  AIMessage,
} from './provider.js'
export {
  ProviderError,
  UnsupportedContentError,
  RateLimitedError,
  RecipientUnreachableError,
  PayloadTooLargeError,
  MediaTooLargeError,
  OutsideSessionWindowError,
} from './provider.js'

/* ============================================================================
 * HOOKS & MIDDLEWARES
 * ========================================================================== */

export type HookEvent =
  | 'message'
  | 'send'
  | 'connection'
  | 'group'
  | 'call'
  | 'presence'
  | 'reaction'
  | 'poll'
  | 'status'
  // Custom plugin events are any other string; `string & {}` keeps editor autocomplete
  // for the built-in names (a bare `| string` collapses the union to `string`).
  | (string & {})

export type HookPhase = 'before' | 'after' | 'error'

/**
 * A `before`/`after` hook: `(ctx, next)`. `before` hooks must call `next()` to let the event
 * through (returning without it stops the event, like `ctx.abort()`); `after` hooks receive
 * no usable `next`. The context type is inferred from the event name through
 * {@link HookContextMap}; for a custom event it is `unknown` unless the handler annotates it.
 */
export type HookHandler<TCtx = unknown> = (
  ctx: TCtx,
  next: () => Promise<void>,
) => void | Promise<void>

/** An `error`-phase hook (`bot.onError`): receives the failing context and the error. */
export type HookErrorHandler<TCtx = unknown> = (
  ctx: TCtx,
  error: unknown,
) => void | Promise<void>

/**
 * Payload of the `'send'` hooks: every outbound send (`ctx.reply`, `bot.send`, broadcasts),
 * plus edits (`edit`) and streamed output (`stream`). A `before` hook may rewrite `content`
 * and `options` in place, or `abort()` to skip the send (it then resolves `skipped`).
 */
export interface SendHookContext {
  chatId: ChatId
  content: OutboundContent
  options?: SendOptions
  /** Set on streamed output: a new message, a live edit or a native draft preview. */
  stream?: 'message' | 'draft' | 'edit'
  /** Set when the send edits an existing message in place (`ctx.edit()`). */
  edit?: MessageRef
}

/**
 * Context type of each built-in hook event. Augment it (declaration merging) to type the
 * hooks of a plugin's custom event:
 *
 * ```ts
 * declare module '@botmesh/core' {
 *   interface HookContextMap { 'crm.lead': { leadId: string } }
 * }
 * bot.after('crm.lead', (lead) => lead.leadId) // typed
 * ```
 */
export interface HookContextMap {
  message: MessageContext
  send: SendHookContext
  connection: ConnectionUpdate
  group: GroupEvent
  call: CallEvent
  presence: PresenceEvent
  reaction: InboundReaction
  poll: PollVote
  status: DeliveryStatus
}

/** The context a hook on `E` receives: the {@link HookContextMap} entry, else `TCtx` (default `unknown`). */
export type HookContextOf<E extends HookEvent, TCtx = unknown> = E extends keyof HookContextMap ? HookContextMap[E] : TCtx

/** A `before` hook's context: the event context plus `abort()`. */
export type HookBeforeContext<T> = T & { abort(): void }

/**
 * Registry-side handler type: every {@link HookHandler} and {@link HookErrorHandler} is
 * assignable to it (the parameter is `never`), so it can hold handlers of any event. It is
 * not callable without a cast; the hook pipeline does that internally.
 */
export type AnyHookHandler = HookHandler<never> | HookErrorHandler<never>

export interface HookRegistration {
  event: HookEvent
  phase: HookPhase
  handler: AnyHookHandler
  priority: number // higher = runs first; default 0
}

/* ============================================================================
 * PLUGINS
 * ========================================================================== */

export interface PluginContext<TTools extends object = DefaultTools> {
  /** Scoped facade of the Bot; registrations auto-track their unsubscribers. */
  bot: Bot
  logger: Logger
  tools: TTools
  config: Record<string, unknown>
  /** Register extra cleanup to run when the plugin is unplugged. */
  onDispose(fn: () => void): void
}

export interface PluginSpec<TConfig = Record<string, unknown>> {
  name: string
  version: string
  description?: string
  /**
   * Names of plugins that must already be plugged (`bot.plug()` throws a descriptive
   * error before `install()` runs otherwise). Checked at plug time only.
   */
  requires?: string[]
  /**
   * Register the plugin's handlers, hooks and tools. It must be **synchronous and return
   * nothing**: `bot.plug()` does not await it. An `async install` (or one that returns a
   * promise) does not compile ({@link SyncInstallError} names the reason); at runtime a
   * rejected promise is still reported on the bot's `'error'` event, but the plugin is
   * already considered installed and nothing is rolled back. Do async setup lazily on first
   * use (the `LazyProvider` pattern in `@botmesh/ai`).
   */
  install(ctx: PluginContext, config?: TConfig): void | SyncInstallError
  uninstall?(ctx: PluginContext): void | Promise<void>
}

/**
 * Carried in the return type of {@link PluginSpec.install} so an `async install()` fails to
 * compile with this text in the error (`Promise<void>` is not assignable to it). Never a
 * value: a sync `install` returns nothing.
 */
export type SyncInstallError =
  'Plugin.install() must be synchronous and return nothing: bot.plug() does not await it. Do async setup lazily on first use (LazyProvider in @botmesh/ai).'

/** A plugin is just a PluginSpec or a factory returning one. */
export type Plugin<TConfig = Record<string, unknown>> =
  | PluginSpec<TConfig>
  | ((config?: TConfig) => PluginSpec<TConfig>)

/* ============================================================================
 * SCHEDULER
 * ========================================================================== */

export interface ScheduledTask {
  id: string
  readonly cron?: string
  readonly interval?: string | number
  readonly runAt?: Date
  readonly nextRun: Date | null
  readonly isRecurring: boolean
  /**
   * `true` for a durable task (registered with {@link DurableTaskOptions}): its schedule
   * lives in a `ScheduleStore`, and `cancel()` also deletes the stored row. Absent on
   * in-memory tasks.
   */
  readonly durable?: boolean
  /**
   * The IANA zone a cron task's fields are read in (`CronTaskOptions.timeZone`,
   * `DurableTaskOptions.timeZone` or `SchedulerOptions.timeZone`). Absent when they are
   * read in the process zone, and on interval and one-shot tasks.
   */
  readonly timeZone?: string
  cancel(): void
}

/**
 * Options of a plain (in-memory) cron task: `bot.schedule(cron, { timeZone }, fn)`.
 * Add an `id` (see {@link DurableTaskOptions}) to make it durable.
 */
export interface CronTaskOptions {
  /**
   * IANA zone the five cron fields are read in (`'America/Bogota'`, `'Europe/Madrid'`,
   * `'UTC'`), or `'local'` (the process zone). Default: `SchedulerOptions.timeZone`, else
   * the process zone. Daylight-saving rules: a fixed-hour slot in a skipped hour runs once,
   * shifted forward by the gap (02:30 → 03:30); in a repeated hour it runs once, at the
   * first occurrence; wildcard-hour slots (an hour field starting with `*`) follow the real
   * clock (none in a skipped hour, both passes of a repeated one). An unknown zone throws a
   * `RangeError` when the task is registered.
   */
  timeZone?: string
}

/**
 * What a durable task does with the occurrences that fell due while no scheduler was
 * running (the bot was down, or every replica was stopped). A slot is missed when it is
 * claimed more than the grace period after it fell due (`SchedulerOptions.tickMs`, plus
 * twice `leaderTtlMs` with a leader lease); a slot interrupted by a crashed runner is
 * retried as itself instead:
 * - `'skip'` (default): run none of them and wait for the next slot after now.
 * - `'run-once'`: run one occurrence (`missed: true`, `scheduledAt` = the first missed
 *   slot), then wait for the next slot after now.
 * - `'catch-up'`: run every missed slot in order, each with its own `scheduledAt`, up to
 *   {@link DurableTaskOptions.maxCatchUp}; later missed slots are skipped (logged).
 *
 * A one-shot `delay` task counts as one slot: `'skip'` drops a reminder that was due
 * while the bot was down, the other two run it once.
 */
export type MissedRunPolicy = 'skip' | 'run-once' | 'catch-up'

/**
 * Options that make a `schedule`/`every`/`delay` task durable: its next run time is
 * persisted in the scheduler's `ScheduleStore` under `id`, so it survives restarts, and
 * each occurrence is claimed under a fenced lease so only one replica runs it.
 */
export interface DurableTaskOptions {
  /**
   * Stable task id, unique per bot (the bot's store namespace is applied, so two bots
   * sharing a backend never collide). The schedule's state is keyed by it: keep it
   * stable across deploys. Registering the same id twice throws a `TypeError`.
   */
  id: string
  /** Policy for occurrences missed while no scheduler ran. Default `'skip'`. */
  missed?: MissedRunPolicy
  /** Most missed slots one `'catch-up'` runs. Default `10`. Positive integer. */
  maxCatchUp?: number
  /**
   * How long one claimed occurrence stays leased to this process: a duration (`'2m'`)
   * or ms. Renewed every third of it while the handler runs; a crashed runner's
   * occurrence is retried by another process once it expires. Default `'60s'`.
   */
  leaseMs?: string | number
  /**
   * Cron tasks only (a `TypeError` on `every`/`delay`): the IANA zone the cron fields are
   * read in, with the daylight-saving rules of {@link CronTaskOptions.timeZone}. Default:
   * `SchedulerOptions.timeZone`, else the process zone. The zone is part of the stored spec
   * (`TZ=<zone> <cron>`), so adding or changing it recomputes the task's next run.
   */
  timeZone?: string
}

/** One occurrence of a durable task, passed to its handler. */
export interface ScheduledRun {
  /** The task's {@link DurableTaskOptions.id} (without the store namespace). */
  taskId: string
  /** The slot this run covers (not the wall clock at which it started). */
  scheduledAt: Date
  /**
   * `${taskId}@${scheduledAt.toISOString()}`: stable per occurrence, so a run retried
   * after a crash or a lost lease reuses it. Use it as an idempotency key.
   */
  occurrenceKey: string
  /**
   * Fencing token of this claim: strictly increasing per task id (also across deletes).
   * Pass it downstream to reject stale writes. The runs of one catch-up share their claim.
   */
  fencingToken: number
  /** `true` when the run comes from the `'run-once'`/`'catch-up'` missed-run policy. */
  missed: boolean
  /** Aborted when the scheduler stops or the lease on this occurrence is lost. */
  signal: AbortSignal
}

/** Handler of a durable task. */
export type DurableTaskHandler = (run: ScheduledRun) => void | Promise<void>

/* ============================================================================
 * BROADCAST
 * ========================================================================== */

// Defined with the broadcast engine (`bot.broadcast()`); re-exported here for compatibility.
export type { BroadcastResult } from '../ops/broadcast.js'

/* ============================================================================
 * TRIGGER MATCHING
 * ========================================================================== */

export type MatchStrategy = 'equals' | 'contains' | 'startsWith' | 'endsWith'
export type TriggerScope = 'dm' | 'group' | 'all'

export interface TriggerObject {
  pattern: string | RegExp | Array<string | RegExp>
  match?: MatchStrategy
  scope?: TriggerScope
}

export type Trigger =
  | string
  | RegExp
  | Array<string | RegExp>
  | TriggerObject
  | ((ctx: { body: string; isGroup: boolean }) => boolean)
  /** `IMAGE`, `MEDIA`, `CALL`, … or `typeTrigger(...)` — see `core/triggers.ts`. */
  | TypeTrigger
  /** The first-contact `WELCOME` trigger — see `core/triggers.ts`. */
  | WelcomeTrigger

/* ============================================================================
 * CONVERSATIONS — CONTROLS
 * ========================================================================== */

/** Options shared by the conversation controls that wait for an inbound message. */
export interface WaitOptions {
  timeout?: number | string
  validate?: (body: string, ctx: RuntimeMessage) => true | string | Promise<true | string>
  retries?: number
  otherwise?: string
  filter?: (ctx: RuntimeMessage) => boolean
}
