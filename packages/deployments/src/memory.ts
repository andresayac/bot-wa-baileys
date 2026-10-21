/**
 * MemoryDeploymentStore — the in-RAM reference implementation of {@link DeploymentStore}.
 * Every read returns a copy; state is lost on restart (use `KvDeploymentStore` to persist).
 */

import { randomUUID } from 'node:crypto'
import { assertTenantId } from '@bot-wa/tenant-kv'
import type { CommitInput, DeploymentStore } from './store.js'
import { DeploymentExistsError, DeploymentNotFoundError, gateRunId, type Deployment, type GateRun } from './types.js'

/** Per-bot state: the active version, the publish order and the live reservations. */
interface BotState {
  activeVersion: string | null
  versions: string[]
  pending: Record<string, number>
}

interface VersionRecord {
  artifact: string
  createdAt: number
  gate?: Deployment['gate']
}

export interface MemoryDeploymentStoreOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
}

const DEFAULT_LIST_LIMIT = 1000
const DEFAULT_RUNS_LIMIT = 100

/** NUL-separated key, so equal ids in different tenants never collide. */
const botKey = (tenantId: string, botId: string) => `${tenantId}\u0000${botId}`
const versionKey = (tenantId: string, botId: string, version: string) => `${botKey(tenantId, botId)}\u0000${version}`

export function assertDeploymentIds(tenantId: string, botId: string, version?: string): void {
  assertTenantId(tenantId)
  assertTenantId(botId, 'botId')
  if (version !== undefined) assertTenantId(version, 'version')
}

export function assertListLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback
  if (!(Number.isInteger(limit) || limit === Number.POSITIVE_INFINITY) || limit < 0) throw new RangeError('limit must be a non-negative integer')
  return limit
}

export class MemoryDeploymentStore implements DeploymentStore {
  private readonly bots = new Map<string, BotState>()
  private readonly versions = new Map<string, VersionRecord>()
  private readonly runs = new Map<string, GateRun[]>()
  private readonly clock: () => number

  constructor(options: MemoryDeploymentStoreOptions = {}) {
    this.clock = options.clock ?? Date.now
  }

  private state(tenantId: string, botId: string): BotState {
    let state = this.bots.get(botKey(tenantId, botId))
    if (!state) {
      state = { activeVersion: null, versions: [], pending: {} }
      this.bots.set(botKey(tenantId, botId), state)
    }
    return state
  }

  private deployment(tenantId: string, botId: string, version: string, state: BotState): Deployment {
    const record = this.versions.get(versionKey(tenantId, botId, version))!
    return {
      tenantId,
      botId,
      version,
      artifact: record.artifact,
      createdAt: record.createdAt,
      active: state.activeVersion === version,
      ...(record.gate ? { gate: { ...record.gate } } : {}),
    }
  }

  async reserve(tenantId: string, botId: string, version: string, until: number): Promise<boolean> {
    assertDeploymentIds(tenantId, botId, version)
    const state = this.state(tenantId, botId)
    if (state.versions.includes(version)) return false
    const live = state.pending[version]
    if (live !== undefined && live > this.clock()) return false
    state.pending[version] = until
    return true
  }

  async release(tenantId: string, botId: string, version: string): Promise<void> {
    assertDeploymentIds(tenantId, botId, version)
    delete this.state(tenantId, botId).pending[version]
  }

  async commit(input: CommitInput): Promise<Deployment> {
    const { tenantId, botId, version } = input
    assertDeploymentIds(tenantId, botId, version)
    const state = this.state(tenantId, botId)
    if (state.versions.includes(version)) throw new DeploymentExistsError()
    const live = state.pending[version]
    if (!input.reserved && live !== undefined && live > this.clock()) throw new DeploymentExistsError()
    this.versions.set(versionKey(tenantId, botId, version), {
      artifact: input.artifact,
      createdAt: this.clock(),
      ...(input.gate ? { gate: { ...input.gate } } : {}),
    })
    delete state.pending[version]
    state.versions.push(version)
    state.activeVersion = version
    return this.deployment(tenantId, botId, version, state)
  }

  async activate(tenantId: string, botId: string, version: string): Promise<Deployment> {
    assertDeploymentIds(tenantId, botId, version)
    const state = this.state(tenantId, botId)
    if (!state.versions.includes(version)) throw new DeploymentNotFoundError()
    state.activeVersion = version
    return this.deployment(tenantId, botId, version, state)
  }

  async active(tenantId: string, botId: string): Promise<Deployment | undefined> {
    assertDeploymentIds(tenantId, botId)
    const state = this.state(tenantId, botId)
    return state.activeVersion === null ? undefined : this.deployment(tenantId, botId, state.activeVersion, state)
  }

  async get(tenantId: string, botId: string, version: string): Promise<Deployment | undefined> {
    assertDeploymentIds(tenantId, botId, version)
    const state = this.state(tenantId, botId)
    return state.versions.includes(version) ? this.deployment(tenantId, botId, version, state) : undefined
  }

  async list(tenantId: string, botId: string, options: { limit?: number } = {}): Promise<Deployment[]> {
    assertDeploymentIds(tenantId, botId)
    const limit = assertListLimit(options.limit, DEFAULT_LIST_LIMIT)
    const state = this.state(tenantId, botId)
    return state.versions.slice(0, limit).map((version) => this.deployment(tenantId, botId, version, state))
  }

  async recordGateRun(run: Omit<GateRun, 'id'>): Promise<GateRun> {
    assertDeploymentIds(run.tenantId, run.botId, run.version)
    const record: GateRun = { ...run, id: gateRunId(run.finishedAt, randomUUID().slice(0, 8)) }
    const key = versionKey(run.tenantId, run.botId, run.version)
    const all = [...(this.runs.get(key) ?? []), record]
    all.sort((a, b) => a.finishedAt - b.finishedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    this.runs.set(key, all)
    return structuredClone(record)
  }

  async listGateRuns(tenantId: string, botId: string, version: string, options: { limit?: number } = {}): Promise<GateRun[]> {
    assertDeploymentIds(tenantId, botId, version)
    const limit = assertListLimit(options.limit, DEFAULT_RUNS_LIMIT)
    return (this.runs.get(versionKey(tenantId, botId, version)) ?? []).slice(0, limit).map((run) => structuredClone(run))
  }
}
