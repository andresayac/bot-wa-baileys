/**
 * DeploymentStore — the storage contract of `@bot-wa/deployments`. `MemoryDeploymentStore`
 * is the reference implementation and `KvDeploymentStore` persists through any
 * `DurableKv` of `@bot-wa/core`; both pass `test-utils/deployment-store-conformance.ts`.
 *
 * Per tenant and bot the store keeps immutable version records, exactly one active
 * version, short-lived reservations (a version whose gate is still running) and the
 * audit log of gate runs. Every read returns a copy.
 */

import type { Deployment, GateRecord, GateRun } from './types.js'

/** Input of {@link DeploymentStore.commit}. */
export interface CommitInput {
  tenantId: string
  botId: string
  version: string
  artifact: string
  /** Trace of the gate the version passed. */
  gate?: GateRecord
  /**
   * `true` when the caller holds the reservation of this version (a gated publish):
   * the reservation is consumed. Otherwise a live reservation by a running gate
   * refuses the commit with `DeploymentExistsError`.
   */
  reserved?: boolean
}

export interface DeploymentStore {
  /**
   * Reserve `version` for a gate that is about to run, until `until` (epoch ms).
   * `false` when the version exists or another live reservation holds it.
   */
  reserve(tenantId: string, botId: string, version: string, until: number): Promise<boolean>
  /** Drop the reservation of `version` (no-op when there is none). */
  release(tenantId: string, botId: string, version: string): Promise<void>
  /**
   * Store the version and make it the active one, in one atomic step with respect to
   * the bot's other versions.
   * @throws {DeploymentExistsError} when the version exists or is reserved by someone else.
   */
  commit(input: CommitInput): Promise<Deployment>
  /**
   * Make a stored version the active one (rollback).
   * @throws {DeploymentNotFoundError} when it does not exist in that tenant and bot.
   */
  activate(tenantId: string, botId: string, version: string): Promise<Deployment>
  /** The active version, or `undefined` before the first publish. */
  active(tenantId: string, botId: string): Promise<Deployment | undefined>
  /** One version, or `undefined`. */
  get(tenantId: string, botId: string, version: string): Promise<Deployment | undefined>
  /** Versions in publish order (at most `limit`, default 1000). */
  list(tenantId: string, botId: string, options?: { limit?: number }): Promise<Deployment[]>
  /** Persist the outcome of a gate run (pass or fail) and return it with its id. */
  recordGateRun(run: Omit<GateRun, 'id'>): Promise<GateRun>
  /** Gate runs of one version, oldest first (at most `limit`, default 100). */
  listGateRuns(tenantId: string, botId: string, version: string, options?: { limit?: number }): Promise<GateRun[]>
}
