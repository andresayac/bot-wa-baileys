/**
 * @botmesh/deployments — versioned bot deployments per tenant and bot: immutable
 * versions, exactly one active version, publish gates (golden transcripts) whose every
 * run is persisted, and rollback.
 *
 * - {@link DeploymentRegistry} — publish / rollback / list over a {@link DeploymentStore}.
 * - {@link MemoryDeploymentStore} — the in-RAM reference store (default).
 * - {@link KvDeploymentStore} — persisted through any `DurableKv` of `@botmesh/core`
 *   (SQLite, PostgreSQL, Redis, file) via `@botmesh/tenant-kv`.
 *
 * The artifact is an opaque reference (e.g. a content hash); the real rollout and
 * gradual traffic shifting belong to an infrastructure adapter.
 *
 * Private package: not published to npm.
 *
 * @example
 * ```ts
 * const registry = new DeploymentRegistry(new KvDeploymentStore(new PostgresDurableKv({ pool })))
 * await registry.publish('acme', 'support', '1.2.0', 'sha256:...')
 * await registry.rollback('acme', 'support', '1.1.0')
 *
 * // Gated publish: only activates when the gate (e.g. golden transcripts) passes.
 * await registry.publish('acme', 'support', '1.3.0', 'sha256:...', {
 *   gate: goldenTranscriptGate({ transcripts, createBot: (candidate) => factoryFor(candidate) }),
 * })
 * ```
 */

export { DeploymentRegistry } from './registry.js'
export type { PublishOptions, DeploymentRegistryOptions } from './registry.js'
export { MemoryDeploymentStore } from './memory.js'
export type { MemoryDeploymentStoreOptions } from './memory.js'
export { KvDeploymentStore } from './kv.js'
export type { KvDeploymentStoreOptions } from './kv.js'
export type { DeploymentStore, CommitInput } from './store.js'
export { DeploymentExistsError, DeploymentNotFoundError } from './types.js'
export type { Deployment, GateRecord, GateRun } from './types.js'
export {
  DeploymentGateError,
  goldenTranscriptGate,
  normalizeGateResult,
  toJsonValue,
} from './gate.js'
export type {
  DeploymentCandidate,
  DeploymentGate,
  GateResult,
  GoldenTranscriptGateOptions,
  GoldenTranscriptGateDetails,
} from './gate.js'

// Integrations
