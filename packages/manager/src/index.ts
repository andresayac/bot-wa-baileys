/**
 * @botmesh/manager — multi-bot orchestrator for `@botmesh/core`.
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

// JSON flow documents (feature #24)
export { compileFlowDocument, validateFlowDocument, isFlowDocument, FlowDocumentError } from './flows/compile.js'
export type { FlowDocument, FlowDocumentIssue, FlowDocumentTrigger, FlowDuration, FlowStepDocument } from './flows/compile.js'
export { FLOW_DOCUMENT_SCHEMA, FLOW_DOCUMENT_SCHEMA_ID, FLOW_DOCUMENT_VERSION, FLOW_DOCUMENT_LIMITS, FLOW_ID_PATTERN } from './flows/schema.js'
export { parseExpression, evaluateExpression, evaluateCondition, renderTemplate, ExpressionError, EXPRESSION_LIMITS } from './flows/expression.js'
export type { ExpressionNode } from './flows/expression.js'

// Persistence, multi-tenant bots and auto-reconnect (features #26 / #27)
export { ManagerError } from './errors.js'
export type { CreateBotInput, UpdateBotInput, RestoreOutcome, ManagerConnectionEvent } from './BotManager.js'
export { FileBotConfigStore, MemoryBotConfigStore, SAFE_ID_PATTERN, assertSafeId } from './persistence.js'
export type { BotConfigRecord, BotConfigStore, BotDesiredRunState, BotFactory, BotProviderConfig, FileBotConfigStoreOptions } from './persistence.js'
export { computeBackoff, resolveAutoReconnect } from './reconnect.js'
export type { AutoReconnectOptions, ResolvedAutoReconnect, ReconnectingInfo, ReconnectedInfo, ReconnectFailedInfo } from './reconnect.js'
export type { BotConnectionInfo, BotMetrics } from './observer.js'
export { CapabilityError } from './capabilities.js'
export type { BotCapabilities } from './capabilities.js'

// REST API /v1 + OpenAPI 3.1 (feature #25)
export { createRestApi } from './rest/api.js'
export type { RestApiHandler, RestApiOptions, RestApiToken } from './rest/api.js'
export { buildOpenApiDocument } from './rest/openapi.js'
export type { OpenApiDocument, OpenApiOptions } from './rest/openapi.js'
export { API_SCOPES, ROUTES } from './rest/spec.js'
export type { ApiScope, RouteSpec } from './rest/spec.js'
export { MemoryIdempotencyStore, TokenBucketRateLimiter } from './rest/limits.js'
export type { IdempotencyStore, MemoryIdempotencyOptions, RateLimitDecision, RateLimiter, StoredResponse, TokenBucketOptions } from './rest/limits.js'
