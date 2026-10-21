/**
 * KvDeploymentStore — {@link DeploymentStore} persisted through any `DurableKv` of
 * `@botmesh/core` (SQLite, PostgreSQL, Redis, file or memory) via `@botmesh/tenant-kv`.
 *
 * Tables (one per tenant, bot ids percent-encoded):
 *  - `product/deployments/bot/<tenant>`                  id = bot id: `{ activeVersion, versions, pending }`.
 *    "Exactly one active version" and "a version is published once" are properties of
 *    this single document, so every publish, rollback and reservation is one atomic
 *    compare-and-set.
 *  - `product/deployments/version/<tenant>/<bot>`        id = version: immutable artifact, createdAt, gate.
 *  - `product/deployments/gate/<tenant>/<bot>/<version>` id = `<finishedAt>-<seq>-<random>`: gate runs, pass or fail.
 *
 * A version document whose bot document never listed it (a crash between the two
 * writes of a commit) is overwritten by the next commit of that version.
 */

import { randomUUID } from 'node:crypto'
import type { DurableKv, JsonValue } from '@botmesh/core'
import { TenantDocs } from '@botmesh/tenant-kv'
import { assertDeploymentIds, assertListLimit } from './memory.js'
import type { CommitInput, DeploymentStore } from './store.js'
import { DeploymentExistsError, DeploymentNotFoundError, gateRunId, type Deployment, type GateRecord, type GateRun } from './types.js'

interface BotDoc {
  activeVersion: string | null
  /** Publish order. */
  versions: string[]
  /** Live reservations: version → expiry (epoch ms). */
  pending: Record<string, number>
  updatedAt: number
}

interface VersionDoc {
  artifact: string
  createdAt: number
  gate?: GateRecord
}

export interface KvDeploymentStoreOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
  /** Compare-and-set retries per write (see `@botmesh/tenant-kv`). */
  attempts?: number
}

const DEFAULT_LIST_LIMIT = 1000
const DEFAULT_RUNS_LIMIT = 100

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseBot(value: unknown): BotDoc {
  if (!isRecord(value)) throw new TypeError('bot document is not an object')
  const { activeVersion, versions, pending, updatedAt } = value
  if (activeVersion !== null && !isString(activeVersion)) throw new TypeError('bad activeVersion')
  if (!Array.isArray(versions) || !versions.every(isString)) throw new TypeError('bad versions')
  if (!isRecord(pending) || !Object.values(pending).every(isNumber)) throw new TypeError('bad pending')
  if (!isNumber(updatedAt)) throw new TypeError('bad updatedAt')
  return { activeVersion, versions: [...versions], pending: { ...pending } as Record<string, number>, updatedAt }
}

function parseGateRecord(value: unknown): GateRecord {
  if (!isRecord(value) || value.passed !== true || !isNumber(value.checkedAt)) throw new TypeError('bad gate record')
  const gate: GateRecord = { passed: true, checkedAt: value.checkedAt }
  if (isString(value.summary)) gate.summary = value.summary
  if (isString(value.runId)) gate.runId = value.runId
  return gate
}

function parseVersion(value: unknown): VersionDoc {
  if (!isRecord(value) || !isString(value.artifact) || !isNumber(value.createdAt)) throw new TypeError('bad version document')
  const doc: VersionDoc = { artifact: value.artifact, createdAt: value.createdAt }
  if (value.gate !== undefined) doc.gate = parseGateRecord(value.gate)
  return doc
}

function parseRun(value: unknown): GateRun {
  if (!isRecord(value)) throw new TypeError('gate run is not an object')
  const { id, tenantId, botId, version, artifact, startedAt, finishedAt, ok } = value
  if (![id, tenantId, botId, version, artifact].every(isString) || !isNumber(startedAt) || !isNumber(finishedAt) || typeof ok !== 'boolean') {
    throw new TypeError('bad gate run')
  }
  const run: GateRun = {
    id: id as string, tenantId: tenantId as string, botId: botId as string, version: version as string, artifact: artifact as string,
    startedAt, finishedAt, ok,
  }
  if (isString(value.reason)) run.reason = value.reason
  if (isString(value.summary)) run.summary = value.summary
  if (value.details !== undefined) run.details = value.details as JsonValue
  if (value.truncated === true) run.truncated = true
  return run
}

export class KvDeploymentStore implements DeploymentStore {
  private readonly bots: TenantDocs<BotDoc>
  private readonly versions: TenantDocs<VersionDoc>
  private readonly runs: TenantDocs<GateRun>
  private readonly clock: () => number

  constructor(kv: DurableKv, options: KvDeploymentStoreOptions = {}) {
    this.clock = options.clock ?? Date.now
    const attempts = options.attempts !== undefined ? { attempts: options.attempts } : {}
    this.bots = new TenantDocs<BotDoc>(kv, { family: ['deployments', 'bot'], parse: parseBot, order: (d) => -d.updatedAt, ...attempts })
    this.versions = new TenantDocs<VersionDoc>(kv, { family: ['deployments', 'version'], parse: parseVersion, order: (d) => d.createdAt, ...attempts })
    this.runs = new TenantDocs<GateRun>(kv, { family: ['deployments', 'gate'], parse: parseRun, order: (d) => d.finishedAt, ...attempts })
  }

  private async bot(tenantId: string, botId: string): Promise<BotDoc | undefined> {
    return (await this.bots.in(tenantId).get(botId))?.doc
  }

  private async deployment(tenantId: string, botId: string, version: string, bot: BotDoc): Promise<Deployment | undefined> {
    const record = (await this.versions.in(tenantId, botId).get(version))?.doc
    if (!record) return undefined
    return {
      tenantId,
      botId,
      version,
      artifact: record.artifact,
      createdAt: record.createdAt,
      active: bot.activeVersion === version,
      ...(record.gate ? { gate: { ...record.gate } } : {}),
    }
  }

  private isLive(bot: BotDoc, version: string): boolean {
    const until = bot.pending[version]
    return until !== undefined && until > this.clock()
  }

  async reserve(tenantId: string, botId: string, version: string, until: number): Promise<boolean> {
    assertDeploymentIds(tenantId, botId, version)
    let reserved = false
    await this.bots.in(tenantId).update(botId, (cur) => {
      reserved = false
      const bot = cur ?? { activeVersion: null, versions: [], pending: {}, updatedAt: 0 }
      if (bot.versions.includes(version) || this.isLive(bot, version)) return undefined
      reserved = true
      return { ...bot, pending: { ...bot.pending, [version]: until }, updatedAt: this.clock() }
    })
    return reserved
  }

  async release(tenantId: string, botId: string, version: string): Promise<void> {
    assertDeploymentIds(tenantId, botId, version)
    await this.bots.in(tenantId).update(botId, (cur) => {
      if (!cur || !(version in cur.pending)) return undefined
      const pending = { ...cur.pending }
      delete pending[version]
      return { ...cur, pending, updatedAt: this.clock() }
    })
  }

  async commit(input: CommitInput): Promise<Deployment> {
    const { tenantId, botId, version } = input
    assertDeploymentIds(tenantId, botId, version)
    const before = await this.bot(tenantId, botId)
    if (before?.versions.includes(version)) throw new DeploymentExistsError()
    if (before && !input.reserved && this.isLive(before, version)) throw new DeploymentExistsError()
    // The version document first (overwriting an orphan of a crashed commit), then the
    // bot document, which is the single place that says the version exists and is active.
    const record: VersionDoc = { artifact: input.artifact, createdAt: this.clock(), ...(input.gate ? { gate: { ...input.gate } } : {}) }
    await this.versions.in(tenantId, botId).update(version, () => record)
    let exists = false
    const written = await this.bots.in(tenantId).update(botId, (cur) => {
      exists = false
      const bot = cur ?? { activeVersion: null, versions: [], pending: {}, updatedAt: 0 }
      if (bot.versions.includes(version) || (!input.reserved && this.isLive(bot, version))) {
        exists = true
        return undefined
      }
      const pending = { ...bot.pending }
      delete pending[version]
      return { activeVersion: version, versions: [...bot.versions, version], pending, updatedAt: this.clock() }
    })
    if (exists || !written) throw new DeploymentExistsError()
    return (await this.deployment(tenantId, botId, version, written.doc))!
  }

  async activate(tenantId: string, botId: string, version: string): Promise<Deployment> {
    assertDeploymentIds(tenantId, botId, version)
    let found = false
    const written = await this.bots.in(tenantId).update(botId, (cur) => {
      found = false
      if (!cur || !cur.versions.includes(version)) return undefined
      found = true
      return { ...cur, activeVersion: version, updatedAt: this.clock() }
    })
    if (!found || !written) throw new DeploymentNotFoundError()
    const deployment = await this.deployment(tenantId, botId, version, written.doc)
    if (!deployment) throw new DeploymentNotFoundError()
    return deployment
  }

  async active(tenantId: string, botId: string): Promise<Deployment | undefined> {
    assertDeploymentIds(tenantId, botId)
    const bot = await this.bot(tenantId, botId)
    return bot?.activeVersion === null || bot === undefined ? undefined : this.deployment(tenantId, botId, bot.activeVersion, bot)
  }

  async get(tenantId: string, botId: string, version: string): Promise<Deployment | undefined> {
    assertDeploymentIds(tenantId, botId, version)
    const bot = await this.bot(tenantId, botId)
    return bot?.versions.includes(version) ? this.deployment(tenantId, botId, version, bot) : undefined
  }

  async list(tenantId: string, botId: string, options: { limit?: number } = {}): Promise<Deployment[]> {
    assertDeploymentIds(tenantId, botId)
    const limit = assertListLimit(options.limit, DEFAULT_LIST_LIMIT)
    const bot = await this.bot(tenantId, botId)
    if (!bot) return []
    const out: Deployment[] = []
    for (const version of bot.versions.slice(0, limit)) {
      const deployment = await this.deployment(tenantId, botId, version, bot)
      if (deployment) out.push(deployment)
    }
    return out
  }

  async recordGateRun(run: Omit<GateRun, 'id'>): Promise<GateRun> {
    assertDeploymentIds(run.tenantId, run.botId, run.version)
    const record: GateRun = { ...run, id: gateRunId(run.finishedAt, randomUUID().slice(0, 8)) }
    const table = this.runs.in(run.tenantId, run.botId, run.version)
    if (!(await table.insert(record.id, record))) throw new Error('gate run id collision')
    return structuredClone(record)
  }

  async listGateRuns(tenantId: string, botId: string, version: string, options: { limit?: number } = {}): Promise<GateRun[]> {
    assertDeploymentIds(tenantId, botId, version)
    const limit = assertListLimit(options.limit, DEFAULT_RUNS_LIMIT)
    return this.runs.in(tenantId, botId, version).list({ limit })
  }
}
