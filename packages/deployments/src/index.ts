/**
 * @bot-wa/deployments — in-memory prototype of versioned bot deployments.
 *
 * - {@link DeploymentRegistry} — immutable versions per tenant and bot, with
 *   exactly one active version, publish and rollback.
 *
 * The artifact is an opaque reference (e.g. a content hash); the real rollout
 * and gradual traffic shifting belong to an infrastructure adapter.
 *
 * Private prototype: state lives in RAM and is not published to npm.
 *
 * @example
 * ```ts
 * const registry = new DeploymentRegistry()
 * registry.publish('acme', 'support', '1.2.0', 'sha256:...')
 * registry.rollback('acme', 'support', '1.1.0')
 *
 * // Gated publish: only activates when the gate (e.g. golden transcripts) passes.
 * await registry.publish('acme', 'support', '1.3.0', 'sha256:...', {
 *   gate: goldenTranscriptGate({ transcripts, createBot: (candidate) => factoryFor(candidate) }),
 * })
 * ```
 */

import {
  DeploymentGateError,
  normalizeGateResult,
  type DeploymentCandidate,
  type DeploymentGate,
  type GateRecord,
} from './gate.js'

export {
  DeploymentGateError,
  goldenTranscriptGate,
} from './gate.js'
export type {
  DeploymentCandidate,
  DeploymentGate,
  GateResult,
  GateRecord,
  GoldenTranscriptGateOptions,
  GoldenTranscriptGateDetails,
} from './gate.js'

/** One published version of a bot. */
export interface Deployment {
  tenantId: string
  botId: string
  /** Version label, unique per tenant and bot. */
  version: string
  /** Opaque reference to the deployable artifact. */
  artifact: string
  /** Epoch ms of the publish. */
  createdAt: number
  /** `true` for the single version currently serving traffic. */
  active: boolean
  /** Present when the version went through a publish gate (it always passed: failing gates store nothing). */
  gate?: GateRecord
}

/** Options for {@link DeploymentRegistry.publish}. */
export interface PublishOptions {
  /**
   * Check run before activation. The version is stored and activated only when
   * it passes; otherwise `publish` rejects with a {@link DeploymentGateError} and
   * nothing changes. With a gate, `publish` returns a Promise.
   */
  gate?: DeploymentGate
}

/**
 * In-memory registry of bot deployments, isolated per tenant and bot. Every
 * read returns a copy, so callers cannot mutate stored state.
 */
export class DeploymentRegistry {
  private readonly records = new Map<string, Deployment[]>()
  /** Versions whose gate is still running (reserved against duplicate publishes). */
  private readonly pending = new Set<string>()

  /**
   * Publish a new version and make it the active one. Throws when `version`
   * or `artifact` is empty, or when the version already exists.
   */
  publish(tenantId: string, botId: string, version: string, artifact: string, options?: PublishOptions & { gate?: undefined }): Deployment
  /**
   * Gated publish: run `options.gate` first and activate the version only when it
   * passes. Rejects with the same validation errors, or with a
   * {@link DeploymentGateError} when the gate fails or throws (nothing is stored,
   * so the version can be fixed and published again). While the gate runs the
   * version is reserved. Activation happens when the gate finishes, so the last
   * version to finish its publish is the active one.
   */
  publish(tenantId: string, botId: string, version: string, artifact: string, options: PublishOptions & { gate: DeploymentGate }): Promise<Deployment>
  publish(tenantId: string, botId: string, version: string, artifact: string, options: PublishOptions = {}): Deployment | Promise<Deployment> {
    if (options.gate) return this.publishGated(tenantId, botId, version, artifact, options.gate)
    this.assertPublishable(tenantId, botId, version, artifact)
    return this.commit(tenantId, botId, version, artifact)
  }

  /** The active version, or `undefined` when nothing has been published. */
  active(tenantId: string, botId: string): Deployment | undefined {
    const current = (this.records.get(botKey(tenantId, botId)) ?? []).find((deployment) => deployment.active)
    return current && clone(current)
  }

  /** Re-activate a previously published version. Throws when it does not exist. */
  rollback(tenantId: string, botId: string, version: string): Deployment {
    const key = botKey(tenantId, botId)
    const all = this.records.get(key) ?? []
    if (!all.some((deployment) => deployment.version === version)) {
      throw new Error('deployment not found')
    }

    const next = all.map((deployment) => ({ ...deployment, active: deployment.version === version }))
    this.records.set(key, next)
    return clone(next.find((deployment) => deployment.active)!)
  }

  private async publishGated(tenantId: string, botId: string, version: string, artifact: string, gate: DeploymentGate): Promise<Deployment> {
    this.assertPublishable(tenantId, botId, version, artifact)
    const reservation = versionKey(tenantId, botId, version)
    this.pending.add(reservation)
    try {
      const candidate: DeploymentCandidate = { tenantId, botId, version, artifact }
      let outcome
      try {
        outcome = normalizeGateResult(await gate({ ...candidate }))
      } catch (error) {
        throw new DeploymentGateError(candidate, { ok: false, reason: error instanceof Error ? error.message : String(error) }, { cause: error })
      }
      if (!outcome.ok) throw new DeploymentGateError(candidate, outcome)
      return this.commit(tenantId, botId, version, artifact, {
        passed: true,
        checkedAt: Date.now(),
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
      })
    } finally {
      this.pending.delete(reservation)
    }
  }

  private assertPublishable(tenantId: string, botId: string, version: string, artifact: string): void {
    if (!version || !artifact) throw new Error('version and artifact are required')
    const current = this.records.get(botKey(tenantId, botId)) ?? []
    if (current.some((deployment) => deployment.version === version) || this.pending.has(versionKey(tenantId, botId, version))) {
      throw new Error('deployment version already exists')
    }
  }

  private commit(tenantId: string, botId: string, version: string, artifact: string, gate?: GateRecord): Deployment {
    const key = botKey(tenantId, botId)
    const current = this.records.get(key) ?? []
    const deployment: Deployment = { tenantId, botId, version, artifact, createdAt: Date.now(), active: true, ...(gate ? { gate } : {}) }
    this.records.set(key, [...current.map((existing) => ({ ...existing, active: false })), deployment])
    return clone(deployment)
  }

  /** All versions of a bot in publish order. */
  list(tenantId: string, botId: string): Deployment[] {
    return (this.records.get(botKey(tenantId, botId)) ?? []).map(clone)
  }
}

/** Tenant-scoped map key (NUL-separated, so equal bot ids in different tenants never collide). */
function botKey(tenantId: string, botId: string): string {
  return `${tenantId}\u0000${botId}`
}

function versionKey(tenantId: string, botId: string, version: string): string {
  return `${botKey(tenantId, botId)}\u0000${version}`
}

function clone(deployment: Deployment): Deployment {
  return deployment.gate ? { ...deployment, gate: { ...deployment.gate } } : { ...deployment }
}
