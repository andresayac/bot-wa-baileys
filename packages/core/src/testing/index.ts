export { MockProvider } from './MockProvider.js'
export { createTestBot } from './createTestBot.js'
export type { TestChat } from './createTestBot.js'

// chaos-mock: adversarial delivery kit + identity stability contract helpers
export type { TestBot, CreateTestBotOptions } from './createTestBot.js'
export {
  ChaosProvider,
  ChaosDisconnectedError,
  withChaos,
  createSeededRandom,
  cloneInboundEvent,
} from './chaos.js'
export type {
  ChaosOptions,
  ChaosDelay,
  ChaosRange,
  ChaosDuplicateOptions,
  ChaosReorderOptions,
  ChaosSendFailureOptions,
  ChaosSendErrorKind,
  ChaosSendAttempt,
  ChaosErrorFactory,
  ChaosDisconnectOptions,
  ChaosAliasOptions,
  ChaosLogEntry,
} from './chaos.js'
export {
  checkIdentityContract,
  assertStableIdentity,
  IdentityContractError,
  recordEvents,
} from './identityContract.js'
export type {
  IdentityEventInput,
  IdentityExpectation,
  IdentityExpectations,
  IdentityContractOptions,
  IdentityRule,
  IdentityViolation,
  EventRecorder,
} from './identityContract.js'

// golden-transcripts: record, redact and replay conversations
export {
  TRANSCRIPT_FORMAT,
  TRANSCRIPT_VERSION,
  TranscriptFormatError,
  createTranscript,
  parseTranscript,
  serializeTranscript,
  serializeContent,
  outboundText,
  transcriptFromMessages,
  transcriptFromStore,
} from './transcripts/format.js'
export type {
  Transcript,
  TranscriptTurn,
  TranscriptInbound,
  TranscriptOutbound,
  JsonValue,
  FromMessagesOptions,
  TranscriptMessageSource,
  TranscriptStoreOwner,
} from './transcripts/format.js'
export { recordTranscript, RecordingProvider, DEFAULT_MAX_TURNS } from './transcripts/record.js'
export type { RecordTranscriptOptions, TranscriptRecorder } from './transcripts/record.js'
export { redactTranscript, createRedactionMap } from './transcripts/redact.js'
export type { RedactOptions, RedactionRule, RedactionMap } from './transcripts/redact.js'
export {
  replayTranscript,
  assertTranscript,
  formatReplayReport,
  TranscriptMismatchError,
  REPLAY_MASKS,
} from './transcripts/replay.js'
export type {
  ReplayOptions,
  ReplayResult,
  ReplayBotFactory,
  ReplayMask,
  TranscriptDiff,
} from './transcripts/replay.js'
