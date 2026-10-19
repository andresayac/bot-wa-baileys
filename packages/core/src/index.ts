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
  StopOptions,
  ConversationTarget,
} from './core/Bot.js'
export {
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  buildMessageContext,
} from './internal.js'
export { Dispatcher } from './core/Dispatcher.js'
export type {
  DispatchContext,
  DispatcherDeps,
  HooksLike,
  MessageHandler as DispatcherMessageHandler,
  CommandHandler as DispatcherCommandHandler,
} from './core/Dispatcher.js'

// Transport-agnostic contract + core vocabulary
import type { BotConfig as BotConfigForAlias } from './core/types.js'
/** @deprecated Use {@link BotConfig}: `Config` is an older alias of the same type. */
export type Config = BotConfigForAlias
export type {
  BotConfig,
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
  InboundLocation,
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
  MediaTooLargeError,
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
export {
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  createControls,
} from './internal.js'
export type { ConversationControls, WaitMediaType } from './conversations/controls.js'
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
export { messageKey, legacyMessageKey } from './store/IStore.js'
export { NamespacedStore } from './store/NamespacedStore.js'
export type { StoreNamespace } from './store/NamespacedStore.js'

// Config validation
export { validateConfig, ConfigValidationError } from './utils/validateConfig.js'

// Utils (advanced)
export { sleep, parseDuration, humanTypingDelay, withTimeout, TimeoutError, randomId } from './utils/timers.js'

// Scheduler
export { Scheduler } from './scheduler/Scheduler.js'
// Scheduler: durable tasks (persistent schedule store + fenced leases)
export type { DurableTaskOptions, DurableTaskHandler, ScheduledRun, MissedRunPolicy } from './core/types.js'
export { MemoryScheduleStore, isScheduleClaimable, applyScheduleComplete } from './scheduler/ScheduleStore.js'
export type {
  ScheduleStore,
  ScheduleRecord,
  ScheduleKind,
  ClaimResult,
  CompletePatch,
  SchedulerOptions,
} from './scheduler/ScheduleStore.js'
export { cronNextRun } from './scheduler/cron.js'
// Scheduler leadership: a low-level fenced LeaseProvider, or the multi-replica Coordinator
// (`SchedulerLease`; a bot with `coordination` uses its coordinator by default).
export { MemoryLeaseProvider } from './coordination/lease.js'
export type { LeaseProvider, LeaseGrant, SchedulerLease } from './coordination/lease.js'

// Engine internals (buildMessageContext, createPacer, runBroadcast, MetricsCollector, …) live
// under the "./internal" subpath (import from '@bot-wa/core/internal'). The main entry still
// re-exports them, marked @deprecated, until v3.

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
export type { ConversationSnapshot, WaitAccepts } from './conversations/ConversationRuntime.js'

// chaos-mock
// Inbound idempotency (BotConfig.dedupe). The chaos kit and the identity
// contract helpers live under '@bot-wa/core/testing'.
export { InboundDeduper, createInboundDeduper, inboundDedupeKey, DEFAULT_DEDUPE_SIZE } from './core/dedupe.js'
export type { InboundDedupeOptions, InboundDeduperOptions, InboundDedupeKey } from './core/dedupe.js'
export { toInboundLocation } from './core/location.js'
export type { InboundLocationInput } from './core/location.js'

// ctx-user
export { UserDataService, userOf, supportsUserData, DEFAULT_USER_NAMESPACE } from './user/UserDataService.js'
export type { UserDataServiceOptions, UserDataStore } from './user/UserDataService.js'
export { UserDataError } from './user/errors.js'
export type { UserDataErrorCode } from './user/errors.js'
export type { UserData, UserSetOptions } from './user/types.js'
export type { UserDataEntry } from './core/provider.js'

// golden-transcripts
// Recording + redaction are usable in production (wrap the real provider; the recorder
// keeps a bounded, unredacted buffer in RAM, see `maxTurns`, so clear() it after use); the
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
  JsonValue,
  FromMessagesOptions,
  TranscriptMessageSource,
  TranscriptStoreOwner,
} from './testing/transcripts/format.js'
export { recordTranscript, RecordingProvider, DEFAULT_MAX_TURNS } from './testing/transcripts/record.js'
export type { RecordTranscriptOptions, TranscriptRecorder } from './testing/transcripts/record.js'
export { redactTranscript, createRedactionMap } from './testing/transcripts/redact.js'
export type { RedactOptions, RedactionRule, RedactionMap } from './testing/transcripts/redact.js'
// flow-dsl
// Flow composition (.use), guards, schema validation, full .media(), per-step delays and typed state.
export type {
  EmptyFlowState,
  FlowControls,
  FlowStateWith,
  FlowStateMerge,
  FlowStateOf,
  FlowGuard,
  FlowDelay,
  SayStepOptions,
  AskStepOptions,
  ChooseStepOptions,
  ChooseOption,
  GuardFailure,
  CompiledAskOptions,
  CompiledChooseOption,
} from './flows/FlowBuilder.js'
export { FLOW_MEDIA_KINDS, isFlowMediaKind } from './flows/media.js'
export type { FlowMediaKind, FlowFileMediaKind, FlowLocation, FlowMediaOptions, FlowMediaSource, DynamicMediaSource } from './flows/media.js'
export { isSchemaLike, DEFAULT_SCHEMA_MESSAGE } from './flows/schema.js'
export type { SchemaLike, SchemaParseResult, SchemaIssueLike, InferSchema } from './flows/schema.js'
export type { SchemaWaitOptions } from './conversations/controls.js'
// messaging
// Automatic typing indicator (BotConfig.typing), reply delays, ctx.edit / ctx.react
// capability resolution (native / degraded / unsupported).
export { DEFAULT_TYPING, messagingSupport, PacedSendCancelled } from './core/messaging.js'
export {
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  TYPING_REFRESH_MS,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  ExternalSendClock,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  createPacer,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  normalizeTypingConfig,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  resolveReplyTyping,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  typingDuration,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  parseReplyDelay,
} from './internal.js'
export type {
  TypingConfig,
  ResolvedTypingConfig,
  ReplyOptions,
  EditOptions,
  EditResult,
  MessagingFeature,
  MessagingSupport,
  Pacer,
  PacerOptions,
  PaceGuard,
  PacerLogger,
} from './core/messaging.js'
// bot-ops
// bot.broadcast() engine, bot.trigger() types, bot.metrics() snapshot + Prometheus exporter,
// and the conversation lifecycle types behind the 'conversation:started'/'conversation:ended' events.
export {
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  runBroadcast,
} from './internal.js'
export type { BroadcastOptions, BroadcastFailure, BroadcastProgress, BroadcastDeps } from './ops/broadcast.js'
export type { TriggerOptions, TriggerResult, TriggerSkipReason, TriggerRaw } from './ops/trigger.js'
export {
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  MetricsCollector,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  formatUptime,
} from './internal.js'
export type { BotMetricsSnapshot, ConversationCounters, ConversationStartedEvent, ConversationEndedEvent } from './ops/metrics.js'
export { toPrometheus, PROMETHEUS_CONTENT_TYPE } from './ops/prometheus.js'
export type { PrometheusOptions } from './ops/prometheus.js'
export type { ConversationOutcome, EnterOptions, ConversationStartInfo, ConversationEndInfo } from './conversations/ConversationRuntime.js'
// i18n
// Native i18n: `bot.locale()`, `ctx.t()` / `c.t()`, `ctx.setLang()` and the
// localizable built-in core messages (`core.*`, `es` + `en`).
export { I18n, normalizeLocale, providerLanguageOf } from './i18n/I18n.js'
export type { I18nOptions, I18nLogger } from './i18n/I18n.js'
export { CORE_MESSAGES, BUILTIN_LOCALES } from './i18n/builtins.js'
export type { CoreMessageKey } from './i18n/builtins.js'
export type {
  I18nConfig,
  LanguageDetector,
  LangSource,
  LocaleMessages,
  PluralCategory,
  PluralForms,
  Translate,
  TranslateParams,
} from './i18n/types.js'
export type { ContextI18n, InboundListener } from './core/provider.js'
// manager
// Dynamic flow registry: bot.registerFlow/unregisterFlow/replaceFlow/listFlows/triggerFlow.
export type { FlowTriggerOptions, FlowTriggerTarget, RegisteredFlowInfo } from './core/flowRegistry.js'
// streaming
// ctx.stream(): live replies (native drafts / throttled edits / sentence chunks).
export { streamText, resolveStreamStrategy } from './streaming/streamText.js'
export { splitMessage, findSplitPoint } from './streaming/split.js'
export type { StreamSource, StreamStrategy, StreamOptions, StreamResult, StreamTarget } from './streaming/types.js'
export type { StreamingMode, TextFormat, DraftOptions } from './core/provider.js'
// wa-flows
// Native forms: `flow().form(definition)` renders a WhatsApp Flow on providers with
// `capabilities.forms === 'native'` (@bot-wa/meta) and asks field by field elsewhere.
export {
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  runFormStep,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  resolveFormMode,
  /** @deprecated Import from '@bot-wa/core/internal' (engine internal; removed from the main entry in v3). */
  newFormToken,
} from './internal.js'
export { formReplyBody, parseFormReply } from './forms/reply.js'
export { withFormDefaults } from './forms/defaults.js'
export {
  assertFormDefinition, validateFormValues, parseFieldAnswer, parseFormDate,
  formOptionEntries, isFieldRequired, selectionBounds,
} from './forms/validate.js'
export type { FieldCheck, FormFieldError, FormValidation } from './forms/validate.js'
export type {
  FormDefinition, FormField, FormFieldType, FormOptions, FormValue, FormValues, FormReply,
  FormMode, FormStepOptions, FormContent, FormFieldBase,
  TextFormField, NumberFormField, EmailFormField, DateFormField, SelectFormField,
  MultiSelectFormField, OptInFormField,
} from './forms/types.js'
export type { FlowGraphFormInfo } from './flows/describe.js'
// voice
// Lazily download an inbound message's media (populates `ctx.media`); used by
// plugins such as @bot-wa/voice that need the bytes before routing.
export { loadMediaOf } from './core/context.js'
export type { LoadMediaOptions } from './core/context.js'
// multi-replica coordination
// `BotConfig.coordination`: per-chat turns (cross-replica FIFO) and leader-elected
// provider sessions. Backends: MemoryCoordinator here, RedisCoordinator in @bot-wa/redis-store.
export {
  LeaseLostError, CoordinationUnavailableError, MemoryCoordinator, MemoryCoordinationHub, ProviderNotLeaderError,
} from './coordination/index.js'
export type {
  Fence, LeaseLossReason, LeaseInfo, Ticket, ChatTurn, Leadership, Coordinator, CoordinatorEvents,
  AcquireTurnOptions, CoordinationConfig, MemoryCoordinatorOptions,
} from './coordination/index.js'

// durability
// Durable message processing (BotConfig.durability): inbox/outbox journal contract,
// the in-memory + file backends, the KV seam store packages implement, and errors.
export { MemoryDurability } from './durability/memory.js'
export { FileDurability } from './durability/file.js'
export type { FileDurabilityOptions } from './durability/file.js'
export { KvDurability, KvInbox, KvOutbox } from './durability/journal.js'
export type { KvDurabilityOptions } from './durability/journal.js'
export { MemoryKv } from './durability/kv.js'
export type { DurableKv, DurableKvEntry, DurableKvIndex, DurableTable, MemoryKvSnapshot } from './durability/kv.js'
export { StaleLeaseError, SendDeferredError } from './durability/errors.js'
export { computeBackoff, DEFAULT_BACKOFF } from './durability/backoff.js'
export type { DurabilityControl, DurabilityMetrics } from './durability/engine.js'
export type {
  DurabilityConfig, DurabilityBackend, RetryBackoff,
  InboxJournal, InboxRecord, InboxState, InboxAppend,
  OutboxJournal, OutboxRecord, OutboxState, OutboxPut, OutboxError, ClaimedSend,
  ClaimOptions, LeaseOptions,
} from './durability/types.js'

// Telemetry
// Tracing hooks (BotConfig.telemetry, bot.tracing): the minimal BotTracer contract an
// integration implements (OpenTelemetry: @bot-wa/otel) and the attribute names.
export { noopTracer, NOOP_TRACING, errorTypeOf } from './telemetry/tracing.js'
export { TRACE_ATTR, SPAN_NAMES } from './telemetry/attributes.js'
export type {
  BotTracer, BotTracing, BotSpan, SpanOptions, SpanKind, SpanStatus, SpanLink, SpanContextRef, SpanException,
  TraceAttributes, TraceAttributeValue, TelemetryConfig,
} from './telemetry/types.js'
export type { ConversationTraceHooks, ConversationTurnTrace } from './conversations/ConversationRuntime.js'
