/**
 * Multi-tenant persistence of bot configurations (feature #26).
 *
 * A {@link BotConfigRecord} is the serializable recipe of a managed bot: who
 * owns it (`tenantId`), how to build its transport (`provider`, interpreted
 * only by your {@link BotFactory}), its JSON flows, and whether it should be
 * running. `BotManager.restore()` rebuilds every stored bot after a restart.
 *
 * Stores are pluggable through {@link BotConfigStore}; {@link FileBotConfigStore}
 * (one JSON file per bot under `<dir>/<tenantId>/<botId>.json`, atomic writes,
 * mode 0600) is the default, {@link MemoryBotConfigStore} is for tests.
 *
 * Do not put raw secrets in `provider.options`: they are written to disk as is.
 * Store a reference (an env var name, a `SecretVault` ref) and resolve it in the factory.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FlowDocument } from './flows/compile.js'
import type { ManageableBot } from './BotManager.js'
import { ManagerError } from './errors.js'

/** Desired lifecycle state persisted with a bot. */
export type BotDesiredRunState = 'running' | 'stopped'

/** Transport recipe. Opaque to the manager; your {@link BotFactory} interprets it. */
export interface BotProviderConfig {
  /** e.g. `'baileys'`, `'telegram'`, `'meta'`. */
  type: string
  options?: Record<string, unknown>
}

/** Persisted configuration of one managed bot. */
export interface BotConfigRecord {
  id: string
  tenantId: string
  name?: string
  provider?: BotProviderConfig
  /** JSON flows registered on the bot after the factory builds it. */
  flows?: FlowDocument[]
  meta?: Record<string, unknown>
  desiredState: BotDesiredRunState
  /** Incremented on every write. */
  version: number
  createdAt: number
  updatedAt: number
}

/** Builds a live bot from its persisted recipe (used by create/update/restore). */
export type BotFactory = (config: Readonly<BotConfigRecord>) => ManageableBot | Promise<ManageableBot>

/** Pluggable storage of {@link BotConfigRecord}s. Implementations must be safe for concurrent calls. */
export interface BotConfigStore {
  list(): Promise<BotConfigRecord[]>
  get(id: string): Promise<BotConfigRecord | undefined>
  put(record: BotConfigRecord): Promise<void>
  /** Returns `false` when the id was unknown. */
  delete(id: string): Promise<boolean>
}

/** Ids and tenant ids are used as file names: keep them to a safe charset. */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Throws unless `value` matches {@link SAFE_ID_PATTERN} (and is not `.`/`..`-like). */
export function assertSafeId(value: unknown, what = 'id'): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value) || value.includes('..')) {
    throw new ManagerError(`${what} must match ${SAFE_ID_PATTERN.source}`, 'INVALID')
  }
}

/** In-memory store (tests, ephemeral deployments). Returns deep copies. */
export class MemoryBotConfigStore implements BotConfigStore {
  private readonly records = new Map<string, BotConfigRecord>()
  async list(): Promise<BotConfigRecord[]> { return [...this.records.values()].map((r) => structuredClone(r)) }
  async get(id: string): Promise<BotConfigRecord | undefined> {
    const r = this.records.get(id)
    return r ? structuredClone(r) : undefined
  }
  async put(record: BotConfigRecord): Promise<void> { this.records.set(record.id, structuredClone(record)) }
  async delete(id: string): Promise<boolean> { return this.records.delete(id) }
}

/** Options of {@link FileBotConfigStore}. */
export interface FileBotConfigStoreOptions {
  /** Root directory; bots live in `<dir>/<tenantId>/<botId>.json`. */
  dir: string
  /** Receives files that could not be parsed (they are skipped, never deleted). */
  onCorrupt?: (file: string, error: unknown) => void
}

/** File-based default store: one JSON document per bot, grouped by tenant directory. */
export class FileBotConfigStore implements BotConfigStore {
  private readonly dir: string
  private readonly onCorrupt?: (file: string, error: unknown) => void
  /** botId → tenantId of the file currently holding it. */
  private index?: Map<string, string>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: FileBotConfigStoreOptions) {
    if (!opts?.dir) throw new TypeError('FileBotConfigStore needs { dir }')
    this.dir = opts.dir
    this.onCorrupt = opts.onCorrupt
  }

  async list(): Promise<BotConfigRecord[]> {
    return this.serial(async () => {
      const records = await this.scan()
      return records
    })
  }

  async get(id: string): Promise<BotConfigRecord | undefined> {
    if (!SAFE_ID_PATTERN.test(id)) return undefined
    return this.serial(async () => {
      const index = await this.ensureIndex()
      const tenant = index.get(id)
      if (!tenant) return undefined
      return this.readRecord(this.fileOf(tenant, id))
    })
  }

  async put(record: BotConfigRecord): Promise<void> {
    assertSafeId(record.id, 'bot id')
    assertSafeId(record.tenantId, 'tenantId')
    await this.serial(async () => {
      const index = await this.ensureIndex()
      const tenantDir = join(this.dir, record.tenantId)
      await mkdir(tenantDir, { recursive: true, mode: 0o700 })
      const file = this.fileOf(record.tenantId, record.id)
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
      const previous = index.get(record.id)
      if (previous && previous !== record.tenantId) await rm(this.fileOf(previous, record.id), { force: true })
      index.set(record.id, record.tenantId)
    })
  }

  async delete(id: string): Promise<boolean> {
    if (!SAFE_ID_PATTERN.test(id)) return false
    return this.serial(async () => {
      const index = await this.ensureIndex()
      const tenant = index.get(id)
      if (!tenant) return false
      await rm(this.fileOf(tenant, id), { force: true })
      index.delete(id)
      return true
    })
  }

  private fileOf(tenantId: string, id: string): string { return join(this.dir, tenantId, `${id}.json`) }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async ensureIndex(): Promise<Map<string, string>> {
    if (!this.index) await this.scan()
    return this.index!
  }

  private async scan(): Promise<BotConfigRecord[]> {
    const index = new Map<string, string>()
    const records: BotConfigRecord[] = []
    for (const tenant of await safeReaddir(this.dir)) {
      if (!tenant.isDirectory() || !SAFE_ID_PATTERN.test(tenant.name)) continue
      for (const entry of await safeReaddir(join(this.dir, tenant.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const id = entry.name.slice(0, -'.json'.length)
        if (!SAFE_ID_PATTERN.test(id)) continue
        const record = await this.readRecord(this.fileOf(tenant.name, id))
        if (!record || record.id !== id || record.tenantId !== tenant.name) continue
        index.set(id, tenant.name)
        records.push(record)
      }
    }
    this.index = index
    return records
  }

  private async readRecord(file: string): Promise<BotConfigRecord | undefined> {
    let raw: string
    try { raw = await readFile(file, 'utf8') } catch { return undefined }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed)) throw new Error('not a bot config record')
      return parsed
    } catch (error) {
      this.onCorrupt?.(file, error)
      return undefined
    }
  }
}

async function safeReaddir(dir: string) {
  try { return await readdir(dir, { withFileTypes: true }) } catch { return [] }
}

function isRecord(v: unknown): v is BotConfigRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<BotConfigRecord>
  return typeof r.id === 'string' && typeof r.tenantId === 'string' && (r.desiredState === 'running' || r.desiredState === 'stopped') && typeof r.version === 'number'
}
