/**
 * @bot-wa/core — transport-agnostic bot engine.
 *
 * Flows, hooks, plugins, conversations, scheduler and DI. Pair it with a
 * transport provider (`@bot-wa/baileys` for WhatsApp) and, optionally, a store
 * (`@bot-wa/sqlite-store`, `@bot-wa/redis-store`) and the `@bot-wa/ai` plugin.
 *
 * @example
 * ```ts
 * import { Bot, flow } from '@bot-wa/core'
 * import { BaileysProvider } from '@bot-wa/baileys'
 *
 * const bot = new Bot({ provider: new BaileysProvider({ session: 'demo' }) })
 * bot.when('hola', async (ctx) => await ctx.reply('¡Hola! 👋'))
 * await bot.start()
 * ```
 */

// Core
export { Bot } from './core/Bot.js'
export type { BotEvents, MessageHandler, CommandHandler } from './core/Bot.js'
export { buildMessageContext } from './core/context.js'
export { Dispatcher } from './core/Dispatcher.js'
export type { DispatchContext } from './core/Dispatcher.js'

// Transport-agnostic contract + core vocabulary
export type {
  BotConfig,
  BotConfig as Config,
  IProvider,
  ProviderCapabilities,
  ConnectionState,
  ConnectionUpdate,
  DisconnectReason,
  ChatId,
  UserId,
  MessageId,
  MessageRef,
  ChatKind,
  ChatInfo,
  SenderInfo,
  DefaultTools,
  InboundEvent,
  InboundMessage,
  InboundInteraction,
  DeliveryStatus,
  InboundReaction,
  PollVote,
  Button,
  ListSection,
  SendOptions,
  OutboundContent,
  SendResult,
  MediaSource,
  MediaRef,
  MediaPayload,
  MessageContext,
  MessageType,
  SentMessage,
  BuildContextDeps,
  StoreKind,
  LoggerLike,
  // Hooks / plugins / triggers / scheduler / conversations
  HookEvent,
  HookHandler,
  HookPhase,
  Plugin,
  PluginContext,
  PluginSpec,
  ScheduledTask,
  BroadcastResult,
  Trigger,
  TriggerObject,
  TriggerScope,
  MatchStrategy,
  WaitOptions,
} from './core/types.js'
export {
  ProviderError,
  UnsupportedContentError,
  RateLimitedError,
  RecipientUnreachableError,
  PayloadTooLargeError,
  OutsideSessionWindowError,
} from './core/types.js'

// Flows DSL
export { flow, addKeyword, FlowBuilder, isCompiledFlow } from './flows/FlowBuilder.js'
export type { CompiledFlow, CompiledStep, DynamicText, FlowAction } from './flows/FlowBuilder.js'

// Conversations (async runtime)
export { ConversationRuntime } from './conversations/ConversationRuntime.js'
export type { RuntimeMessage, ConversationFn, ConversationControlsBase, RuntimeConfig } from './conversations/ConversationRuntime.js'
export { createControls } from './conversations/controls.js'
export type { ConversationControls } from './conversations/controls.js'
export {
  ConversationError,
  ConversationTimeout,
  ConversationCancelled,
  ConversationEnded,
  ConversationGoto,
  RetriesExceeded,
} from './conversations/errors.js'

// Hooks & plugins
export { HookSystem } from './hooks/HookSystem.js'
export { definePlugin, isPlugin } from './plugins/definePlugin.js'
export { slashCommandsPlugin } from './plugins/slashCommands.js'

// Store
export { MemoryStore } from './store/MemoryStore.js'
export type { IStore, AIMessage, StoredMessage, StoredChat, StoredContact, FlowCheckpoint } from './store/IStore.js'
export type { MemoryStoreOptions } from './store/MemoryStore.js'
export { messageKey } from './store/IStore.js'

// Config validation
export { validateConfig, ConfigValidationError } from './utils/validateConfig.js'

// Utils (advanced)
export { sleep, parseDuration, humanTypingDelay, withTimeout, TimeoutError, randomId } from './utils/timers.js'

// Scheduler
export { Scheduler } from './scheduler/Scheduler.js'

// Testing helpers live under the "./testing" subpath export
// (import from '@bot-wa/core/testing') — not re-exported here to keep the entry lean.
