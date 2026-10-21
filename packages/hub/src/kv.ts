/**
 * KvPluginStore — {@link PluginStore} persisted through any `DurableKv` of
 * `@botmesh/core` (SQLite, PostgreSQL, Redis, file or memory) via `@botmesh/tenant-kv`.
 *
 * One table per tenant, `product/hub/plugin/<tenant>`: id = plugin id, `all` index =
 * most recently installed first. `install` replaces the document and `setEnabled` is a
 * compare-and-set loop, so a concurrent writer is retried instead of overwritten.
 */

import type { DurableKv } from '@botmesh/core'
import { TenantDocs } from '@botmesh/tenant-kv'
import {
  DEFAULT_LIST_LIMIT,
  assertLimit,
  assertPluginIds,
  clonePlugin,
  parseManifest,
} from './memory.js'
import type { PluginStore } from './store.js'
import { PluginManifestError, type InstalledPlugin } from './types.js'

export interface KvPluginStoreOptions {
  /** Compare-and-set retries of `setEnabled` (default 32). */
  attempts?: number
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parsePlugin(value: unknown): InstalledPlugin {
  if (!isRecord(value)) throw new TypeError('installed plugin is not an object')
  if (typeof value.tenantId !== 'string' || typeof value.enabled !== 'boolean' || typeof value.installedAt !== 'number') {
    throw new TypeError('bad installed plugin')
  }
  return {
    tenantId: value.tenantId,
    manifest: parseManifest(value.manifest),
    enabled: value.enabled,
    installedAt: value.installedAt,
  }
}

const backoff = (attempt: number): Promise<void> => {
  if (attempt === 0) return Promise.resolve()
  const ms = Math.random() * Math.min(64, 2 ** attempt)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class KvPluginStore implements PluginStore {
  private readonly plugins: TenantDocs<InstalledPlugin>
  private readonly attempts: number

  constructor(kv: DurableKv, options: KvPluginStoreOptions = {}) {
    this.attempts = options.attempts ?? 32
    if (!Number.isInteger(this.attempts) || this.attempts < 1) throw new RangeError('attempts must be a positive integer')
    this.plugins = new TenantDocs<InstalledPlugin>(kv, {
      family: ['hub', 'plugin'],
      parse: parsePlugin,
      order: (record) => -record.installedAt,
    })
  }

  async install(record: InstalledPlugin): Promise<InstalledPlugin> {
    assertPluginIds(record.tenantId, record.manifest.id)
    const table = this.plugins.in(record.tenantId)
    const stored = clonePlugin(record)
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await backoff(attempt)
      const current = await table.get(stored.manifest.id)
      const written = current
        ? await table.replace(stored.manifest.id, current.version, stored)
        : await table.insert(stored.manifest.id, stored)
      if (written) return clonePlugin(written.doc)
    }
    throw new Error(`too much contention installing ${JSON.stringify(stored.manifest.id)} after ${this.attempts} attempts`)
  }

  async get(tenantId: string, id: string): Promise<InstalledPlugin | undefined> {
    assertPluginIds(tenantId, id)
    const entry = await this.plugins.in(tenantId).get(id)
    return entry && clonePlugin(entry.doc)
  }

  async list(tenantId: string, options: { limit?: number } = {}): Promise<InstalledPlugin[]> {
    assertPluginIds(tenantId)
    const limit = assertLimit(options.limit, DEFAULT_LIST_LIMIT)
    return (await this.plugins.in(tenantId).list({ limit })).map(clonePlugin)
  }

  async setEnabled(tenantId: string, id: string, enabled: boolean): Promise<InstalledPlugin> {
    assertPluginIds(tenantId, id)
    const table = this.plugins.in(tenantId)
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await backoff(attempt)
      const current = await table.get(id)
      if (!current) throw new PluginManifestError('plugin not installed')
      const next: InstalledPlugin = { ...current.doc, enabled: enabled === true }
      const written = await table.replace(id, current.version, next)
      if (written) return clonePlugin(written.doc)
    }
    throw new Error(`too much contention updating ${JSON.stringify(id)} after ${this.attempts} attempts`)
  }
}
