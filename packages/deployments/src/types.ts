/**
 * Records of `@botmesh/deployments`: published versions, the gate trace kept on a
 * version that passed its gate, the audit record of every gate run, and the errors
 * the registry and stores reject with.
 */

import type { JsonValue } from '@botmesh/core'

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
  /** Present when the version went through a publish gate (it always passed: failing gates store no version). */
  gate?: GateRecord
}

/** Gate trace stored on a deployment that passed a gate. */
export interface GateRecord {
  passed: true
  /** Epoch ms when the gate passed. */
  checkedAt: number
  summary?: string
  /** Id of the persisted {@link GateRun} (see `DeploymentRegistry.gateRuns`). */
  runId?: string
}

/** Audit record of one gate execution, persisted whether the gate passed or failed. */
export interface GateRun {
  id: string
  tenantId: string
  botId: string
  version: string
  artifact: string
  /** Epoch ms when the gate started. */
  startedAt: number
  /** Epoch ms when the gate finished (the listing order). */
  finishedAt: number
  ok: boolean
  /** Why the gate failed (or the thrown error's message). */
  reason?: string
  summary?: string
  /** The gate's `details` as JSON (e.g. golden-transcript results); a string when truncated. */
  details?: JsonValue
  /** `true` when `details` exceeded the registry's `maxGateDetailsBytes` and was cut. */
  truncated?: boolean
}

let runSeq = 0

/**
 * Id of a gate run: zero-padded `finishedAt`, an in-process sequence (so runs of the same
 * millisecond list in insertion order) and a random suffix (unique across processes).
 */
export function gateRunId(finishedAt: number, random: string): string {
  runSeq = (runSeq + 1) % 1_000_000
  return `${String(Math.max(0, Math.floor(finishedAt))).padStart(15, '0')}-${String(runSeq).padStart(6, '0')}-${random}`
}

/** The version already exists (or is reserved by a running gate) for that tenant and bot. */
export class DeploymentExistsError extends Error {
  constructor() {
    super('deployment version already exists')
    this.name = 'DeploymentExistsError'
  }
}

/** No such version for that tenant and bot. */
export class DeploymentNotFoundError extends Error {
  constructor() {
    super('deployment not found')
    this.name = 'DeploymentNotFoundError'
  }
}
