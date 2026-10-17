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
