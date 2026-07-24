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
  | string // allow plugins to declare custom events

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
  requires?: string[]
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

export interface BroadcastResult {
  sent: SentMessage[]
  failed: Array<{ chatId: ChatId; error: Error }>
}

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
