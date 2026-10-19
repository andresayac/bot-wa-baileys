/**
 * @bot-wa/core — Public Types
 * ===========================
 *
 * Transport-agnostic. The provider/message/store contract lives in
 * `core/provider.ts`; this module re-exports the shared pieces and adds the
 * core-only vocabulary (hooks, plugins, triggers, scheduler, conversations).
 * WhatsApp-specific types (JID, QrConfig, GroupsAPI, …) live in @bot-wa/baileys.
 */

import type { Logger } from 'pino'
import type { RuntimeMessage } from '../conversations/ConversationRuntime.js'
import type { Bot } from './Bot.js'
import type { DefaultTools, SentMessage, ChatId } from './provider.js'
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
  // Custom plugin events are any other string; `string & {}` keeps editor autocomplete
  // for the built-in names (a bare `| string` collapses the union to `string`).
  | (string & {})

export type HookPhase = 'before' | 'after' | 'error'

export type HookHandler<TCtx = any> = (
  ctx: TCtx,
  next: () => Promise<void>,
) => void | Promise<void>

export interface HookRegistration {
  event: HookEvent
  phase: HookPhase
  handler: HookHandler
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
   * Register the plugin's handlers, hooks and tools. Keep it synchronous: `bot.plug()`
   * does not await it — a rejected promise is reported on the bot's `'error'` event
   * (it does not crash the process), but the plugin is already considered installed and
   * nothing is rolled back. Do async setup lazily on first use instead.
   * (`Promise<void>` stays in the type for compatibility.)
   */
  install(ctx: PluginContext, config?: TConfig): void | Promise<void>
  uninstall?(ctx: PluginContext): void | Promise<void>
}

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
  cancel(): void
}

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
