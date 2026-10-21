/**
 * DeploymentRegistry — publish, gate and roll back bot versions over a
 * {@link DeploymentStore}. A gated publish reserves the version, runs the gate, records
 * the run (pass or fail) and then commits (activates) or releases the reservation.
 */

import { DeploymentGateError, normalizeGateResult, toJsonValue, type DeploymentCandidate, type DeploymentGate, type GateResult } from './gate.js'
import { MemoryDeploymentStore } from './memory.js'
import type { DeploymentStore } from './store.js'
import { DeploymentExistsError, type Deployment, type GateRecord, type GateRun } from './types.js'

/** Options for {@link DeploymentRegistry.publish}. */
export interface PublishOptions {
  /**
   * Check run before activation. The version is stored and activated only when
   * it passes; otherwise `publish` rejects with a {@link DeploymentGateError} and
   * no version is stored (the gate run is recorded either way).
   */
  gate?: DeploymentGate
}

export interface DeploymentRegistryOptions {
  /** How long a version stays reserved while its gate runs (default 10 minutes). A gate that dies frees the version after it. */
  gateTimeoutMs?: number
  /** Cap on the serialized gate `details` persisted per run (default 256 KiB); larger details are cut and flagged `truncated`. */
  maxGateDetailsBytes?: number
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
}

const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_GATE_DETAILS_BYTES = 256 * 1024

/**
 * Registry of bot deployments, isolated per tenant and bot. Without a store it keeps
 * everything in memory ({@link MemoryDeploymentStore}); give it a `KvDeploymentStore`
 * to persist. Every read returns a copy, so callers cannot mutate stored state.
 */
export class DeploymentRegistry {
  private readonly store: DeploymentStore
  private readonly gateTimeoutMs: number
  private readonly maxGateDetailsBytes: number
  private readonly clock: () => number

  constructor(store: DeploymentStore = new MemoryDeploymentStore(), options: DeploymentRegistryOptions = {}) {
    this.store = store
    this.gateTimeoutMs = options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
    this.maxGateDetailsBytes = options.maxGateDetailsBytes ?? DEFAULT_MAX_GATE_DETAILS_BYTES
    this.clock = options.clock ?? Date.now
    if (!(Number.isFinite(this.gateTimeoutMs) && this.gateTimeoutMs > 0)) throw new RangeError('gateTimeoutMs must be a positive number')
    if (!(Number.isInteger(this.maxGateDetailsBytes) && this.maxGateDetailsBytes > 0)) throw new RangeError('maxGateDetailsBytes must be a positive integer')
  }

  /**
   * Publish a new version and make it the active one. Rejects when `version` or
   * `artifact` is empty, or when the version already exists (or is reserved by a
   * running gate), with {@link DeploymentExistsError}.
   *
   * With `options.gate`, the gate runs first and the version is activated only when
   * it passes; a failing or throwing gate rejects with a {@link DeploymentGateError}
   * and stores no version (the run itself is kept, see {@link DeploymentRegistry.gateRuns}),
   * so the version can be fixed and published again. While the gate runs the version is
   * reserved. Activation happens when the gate finishes, so the last publish to finish
   * is the active one.
   */
  async publish(tenantId: string, botId: string, version: string, artifact: string, options: PublishOptions = {}): Promise<Deployment> {
    if (!version || !artifact) throw new Error('version and artifact are required')
    if (!options.gate) return this.store.commit({ tenantId, botId, version, artifact })
    return this.publishGated(tenantId, botId, version, artifact, options.gate)
  }

  private async publishGated(tenantId: string, botId: string, version: string, artifact: string, gate: DeploymentGate): Promise<Deployment> {
    const startedAt = this.clock()
    if (!(await this.store.reserve(tenantId, botId, version, startedAt + this.gateTimeoutMs))) throw new DeploymentExistsError()
    let committed = false
    try {
      const candidate: DeploymentCandidate = { tenantId, botId, version, artifact }
      let outcome: GateResult
      let cause: unknown
      try {
        outcome = normalizeGateResult(await gate({ ...candidate }))
      } catch (error) {
        cause = error
        outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      const run = await this.store.recordGateRun(this.gateRunOf(candidate, startedAt, outcome))
      if (!outcome.ok) throw new DeploymentGateError(candidate, outcome, { cause, runId: run.id })
      const gateRecord: GateRecord = {
        passed: true,
        checkedAt: run.finishedAt,
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        runId: run.id,
      }
      const deployment = await this.store.commit({ tenantId, botId, version, artifact, gate: gateRecord, reserved: true })
      committed = true
      return deployment
    } finally {
      if (!committed) await this.store.release(tenantId, botId, version)
    }
  }

  private gateRunOf(candidate: DeploymentCandidate, startedAt: number, outcome: GateResult): Omit<GateRun, 'id'> {
    const run: Omit<GateRun, 'id'> = { ...candidate, startedAt, finishedAt: this.clock(), ok: outcome.ok }
    if (outcome.reason !== undefined) run.reason = outcome.reason
    if (outcome.summary !== undefined) run.summary = outcome.summary
    const details = toJsonValue(outcome.details)
    if (details !== undefined) {
      const text = JSON.stringify(details)
      if (text.length > this.maxGateDetailsBytes) {
        run.details = text.slice(0, this.maxGateDetailsBytes)
        run.truncated = true
      } else {
        run.details = details
      }
    }
    return run
  }

  /** The active version, or `undefined` when nothing has been published. */
  active(tenantId: string, botId: string): Promise<Deployment | undefined> {
    return this.store.active(tenantId, botId)
  }

  /** One published version, or `undefined`. */
  get(tenantId: string, botId: string, version: string): Promise<Deployment | undefined> {
    return this.store.get(tenantId, botId, version)
  }

  /** Re-activate a previously published version. Rejects with `DeploymentNotFoundError` when it does not exist. */
  rollback(tenantId: string, botId: string, version: string): Promise<Deployment> {
    return this.store.activate(tenantId, botId, version)
  }

  /** All versions of a bot in publish order. */
  list(tenantId: string, botId: string, options?: { limit?: number }): Promise<Deployment[]> {
    return this.store.list(tenantId, botId, options)
  }

  /** The persisted gate runs of one version (passes and failures), oldest first. */
  gateRuns(tenantId: string, botId: string, version: string, options?: { limit?: number }): Promise<GateRun[]> {
    return this.store.listGateRuns(tenantId, botId, version, options)
  }
}
