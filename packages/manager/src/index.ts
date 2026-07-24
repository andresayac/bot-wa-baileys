/**
 * @bot-wa/manager — multi-bot orchestrator for `@bot-wa/core`.
 *
 * - {@link BotManager}: registry, running-state tracking, lifecycle
 *   (`start`/`stop`/`startAll`/`stopAll`), events.
 * - {@link createManagerApi}: optional zero-dep `node:http` handler over a manager.
 */

export { BotManager } from './BotManager.js'
export type {
  AddBotOptions,
  BotEntry,
  BotManagerOptions,
  BotStatus,
  ManageableBot,
  ManagerErrorInfo,
  ManagerEventMap,
  StartStopOutcome,
} from './BotManager.js'
export { createManagerApi } from './http.js'
export type { ManagerApiHandler, ManagerApiOptions } from './http.js'
export { AuditLog, ControlPlaneError, IdempotencyRegistry, SecretVault, assertAuthorized, verifyApiKey } from './controlPlane.js'
export type { AuditEntry, ControlAction, Principal } from './controlPlane.js'
export { createControlPlaneApi } from './v1.js'
export type { ControlPlaneApiHandler, ControlPlaneApiKey, ControlPlaneApiOptions } from './v1.js'
export { BotReconciler, DesiredStateConflictError, MemoryDesiredStateStore } from './reconciler.js'
export type { BotDesiredState, DesiredLifecycleState, DesiredStateStore, ReconcileResult } from './reconciler.js'
