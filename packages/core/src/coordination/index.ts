/**
 * Public surface of multi-replica coordination: the `Coordinator` contract with its
 * errors and option types, the in-process `MemoryCoordinator` / `MemoryCoordinationHub`
 * and `ProviderNotLeaderError`.
 */
export {
  LeaseLostError,
  CoordinationUnavailableError,
} from './types.js'
export type {
  Fence,
  LeaseLossReason,
  LeaseInfo,
  Ticket,
  ChatTurn,
  Leadership,
  Coordinator,
  CoordinatorEvents,
  AcquireTurnOptions,
  CoordinationConfig,
  ConversationHandoverConfig,
  ConversationHandoverEvent,
  HandoverFallback,
  HandoverContext,
  InterruptedConversation,
} from './types.js'
export { MemoryCoordinator, MemoryCoordinationHub } from './MemoryCoordinator.js'
export type { MemoryCoordinatorOptions } from './MemoryCoordinator.js'
export { ProviderNotLeaderError } from './botCoordination.js'
