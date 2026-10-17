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
export type {
  BotEvents,
  BotEventArgs,
  MessageHandler,
  CommandHandler,
  SubjectDataExport,
  SubjectDeletionResult,
} from './core/Bot.js'
export { buildMessageContext } from './core/context.js'
export { Dispatcher } from './core/Dispatcher.js'
export type {
  DispatchContext,
  DispatcherDeps,
  HooksLike,
  MessageHandler as DispatcherMessageHandler,
  CommandHandler as DispatcherCommandHandler,
} from './core/Dispatcher.js'

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
  QuotedRef,
  GroupEvent,
  PresenceEvent,
  CallEvent,
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
export type {
  RuntimeMessage,
  ConversationFn,
  ConversationControlsBase,
  RuntimeConfig,
  ResolvedWaitOptions,
  ConversationHandle,
  CheckpointStore,
} from './conversations/ConversationRuntime.js'
export { createControls } from './conversations/controls.js'
export type { ConversationControls } from './conversations/controls.js'
export {
  ConversationError,
  ConversationTimeout,
  ConversationCancelled,
  ConversationEnded,
  ConversationGoto,
  RetriesExceeded,
  ConcurrentWaitError,
} from './conversations/errors.js'

// Hooks & plugins
export { HookSystem } from './hooks/HookSystem.js'
export type { RegisteredHook, HookLogger } from './hooks/HookSystem.js'
export { definePlugin, isPlugin } from './plugins/definePlugin.js'
export { slashCommandsPlugin } from './plugins/slashCommands.js'
export type { SlashCommandsConfig } from './plugins/slashCommands.js'

// Store
export { MemoryStore } from './store/MemoryStore.js'
export type { IStore, AIMessage, StoredMessage, StoredChat, StoredContact, FlowCheckpoint } from './store/IStore.js'
export type { MemoryStoreOptions, MemoryStoreLogger } from './store/MemoryStore.js'
export { messageKey } from './store/IStore.js'
export { NamespacedStore } from './store/NamespacedStore.js'
export type { StoreNamespace } from './store/NamespacedStore.js'

// Config validation
export { validateConfig, ConfigValidationError } from './utils/validateConfig.js'

// Utils (advanced)
export { sleep, parseDuration, humanTypingDelay, withTimeout, TimeoutError, randomId } from './utils/timers.js'

// Scheduler
export { Scheduler } from './scheduler/Scheduler.js'

// Testing helpers live under the "./testing" subpath export
// (import from '@bot-wa/core/testing') — not re-exported here to keep the entry lean.

// describe-lint
export { describeFlows } from './flows/describe.js'
export type {
  DescribeOptions,
  FlowGraph,
  FlowGraphFlow,
  FlowGraphNode,
  FlowGraphNodeKind,
  FlowGraphEdge,
  FlowGraphEdgeKind,
  FlowGraphGroup,
  FlowGraphOption,
  FlowGraphTimeoutSource,
} from './flows/describe.js'
export { lintFlows } from './flows/lint.js'
export type { LintCode, LintDiagnostic, LintOptions, LintSeverity } from './flows/lint.js'
export { describeTrigger } from './flows/inventory.js'
export type {
  FlowInventory,
  FlowInventoryProvider,
  FlowRoute,
  FlowSource,
  TriggerInfo,
  TriggerPatternInfo,
} from './flows/inventory.js'
export type { ConversationRegistration } from './conversations/ConversationRuntime.js'

// conversations
export { ConversationRetry, RetryUnavailableError } from './conversations/retry.js'
export type { ConversationHandler } from './conversations/handler.js'
export type { IdleCallback } from './conversations/idle.js'
export type { ConversationObserver } from './conversations/ConversationRuntime.js'
export type { IdleHandler, IdleEvent } from './core/idle.js'

// handoff-gates
export { AccessList, Whitelist, checkAccess } from './gates/accessList.js'
export type {
  AccessDecision,
  AccessListAction,
  AccessListChange,
  AccessListName,
  AccessListSnapshot,
  AccessListsSnapshot,
  WhitelistSnapshot,
} from './gates/accessList.js'
export { HANDOFF_INDEX_KEY, validateHandoffConfig } from './gates/handoff.js'
export type {
  HandoffConfig,
  HandoffEvent,
  HandoffOptions,
  HandoffState,
  ResumeEvent,
  ResumeOptions,
  StoredHandoff,
} from './gates/handoff.js'

// triggers
export {
  WELCOME,
  MEDIA,
  IMAGE,
  VIDEO,
  AUDIO,
  VOICE_NOTE,
  DOCUMENT,
  STICKER,
  LOCATION,
  CONTACT,
  POLL,
  CALL,
  typeTrigger,
  isTypeTrigger,
  isWelcomeTrigger,
} from './core/triggers.js'
export type { TypeTrigger, WelcomeTrigger } from './core/triggers.js'

// dev-simulator
// Bot factory pattern shared by `npm start` and the `bot-wa dev` terminal simulator.
// The simulator itself (DevSession, DevProvider, runCli, ...) lives under the
// "./dev" subpath export (import from '@bot-wa/core/dev').
export { defineBot, isBotFactory, isMainModule } from './dev/defineBot.js'
export type { BotFactory } from './dev/defineBot.js'
export type { ConversationSnapshot } from './conversations/ConversationRuntime.js'

// chaos-mock
// Inbound idempotency (BotConfig.dedupe). The chaos kit and the identity
// contract helpers live under '@bot-wa/core/testing'.
export { InboundDeduper, createInboundDeduper, inboundDedupeKey, DEFAULT_DEDUPE_SIZE } from './core/dedupe.js'
export type { InboundDedupeOptions, InboundDeduperOptions, InboundDedupeKey } from './core/dedupe.js'

// ctx-user
export { UserDataService, userOf, supportsUserData, DEFAULT_USER_NAMESPACE } from './user/UserDataService.js'
export type { UserDataServiceOptions } from './user/UserDataService.js'
export { UserDataError } from './user/errors.js'
export type { UserDataErrorCode } from './user/errors.js'
export type { UserData, UserSetOptions } from './user/types.js'
export type { UserDataEntry } from './core/provider.js'

// golden-transcripts
// Recording + redaction are usable in production (wrap the real provider); the
// replay/diff helpers (replayTranscript, assertTranscript) live under '@bot-wa/core/testing'.
export {
  TRANSCRIPT_FORMAT,
  TRANSCRIPT_VERSION,
  TranscriptFormatError,
  createTranscript,
  parseTranscript,
  serializeTranscript,
  transcriptFromMessages,
  transcriptFromStore,
} from './testing/transcripts/format.js'
export type {
  Transcript,
  TranscriptTurn,
  TranscriptInbound,
  TranscriptOutbound,
  FromMessagesOptions,
  TranscriptMessageSource,
} from './testing/transcripts/format.js'
export { recordTranscript, RecordingProvider } from './testing/transcripts/record.js'
export type { RecordTranscriptOptions, TranscriptRecorder } from './testing/transcripts/record.js'
export { redactTranscript, createRedactionMap } from './testing/transcripts/redact.js'
export type { RedactOptions, RedactionRule, RedactionMap } from './testing/transcripts/redact.js'
