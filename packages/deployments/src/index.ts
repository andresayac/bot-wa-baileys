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
 * ```
 */

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
}

/**
 * In-memory registry of bot deployments, isolated per tenant and bot. Every
 * read returns a copy, so callers cannot mutate stored state.
 */
export class DeploymentRegistry {
  private readonly records = new Map<string, Deployment[]>()

  /**
   * Publish a new version and make it the active one. Throws when `version`
   * or `artifact` is empty, or when the version already exists.
   */
  publish(tenantId: string, botId: string, version: string, artifact: string): Deployment {
    if (!version || !artifact) throw new Error('version and artifact are required')

    const key = botKey(tenantId, botId)
    const current = this.records.get(key) ?? []
    if (current.some((deployment) => deployment.version === version)) {
      throw new Error('deployment version already exists')
    }

    const deployment = { tenantId, botId, version, artifact, createdAt: Date.now(), active: true }
    this.records.set(key, [...current.map((existing) => ({ ...existing, active: false })), deployment])
    return { ...deployment }
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

  /** All versions of a bot in publish order. */
  list(tenantId: string, botId: string): Deployment[] {
    return (this.records.get(botKey(tenantId, botId)) ?? []).map(clone)
  }
}

/** Tenant-scoped map key (NUL-separated, so equal bot ids in different tenants never collide). */
function botKey(tenantId: string, botId: string): string {
  return `${tenantId}\u0000${botId}`
}

function clone(deployment: Deployment): Deployment {
  return { ...deployment }
}
