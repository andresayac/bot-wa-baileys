/**
 * MemoryPluginStore — the in-RAM reference implementation of {@link PluginStore}, plus
 * the shared helpers (limits, clones, keys). Every read returns a copy; state is lost on
 * restart (use `KvPluginStore` to persist).
 */

import { assertTenantId } from '@botmesh/tenant-kv'
import type { PluginStore } from './store.js'
import { PluginManifestError, type InstalledPlugin, type PluginManifest } from './types.js'

export const DEFAULT_LIST_LIMIT = 100

export function assertLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!(Number.isInteger(value) || value === Number.POSITIVE_INFINITY) || value < 0) throw new RangeError('limit must be a non-negative integer')
  return value
}

export function assertPluginIds(tenantId: string, id?: string): void {
  assertTenantId(tenantId)
  if (id !== undefined) assertTenantId(id, 'id')
}

/** Deep copy of an installed plugin (manifest permissions included). */
export function clonePlugin(record: InstalledPlugin): InstalledPlugin {
  return { ...record, manifest: { ...record.manifest, permissions: [...record.manifest.permissions] } }
}

/** Most recently installed first, ties by id. */
export function byInstallDate(a: InstalledPlugin, b: InstalledPlugin): number {
  return b.installedAt - a.installedAt || (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0)
}

/** NUL-separated key, so equal ids in different tenants never collide. */
export const pluginKey = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`

export class MemoryPluginStore implements PluginStore {
  private readonly plugins = new Map<string, InstalledPlugin>()

  async install(record: InstalledPlugin): Promise<InstalledPlugin> {
    assertPluginIds(record.tenantId, record.manifest.id)
    const stored = clonePlugin(record)
    this.plugins.set(pluginKey(record.tenantId, record.manifest.id), stored)
    return clonePlugin(stored)
  }

  async get(tenantId: string, id: string): Promise<InstalledPlugin | undefined> {
    assertPluginIds(tenantId, id)
    const record = this.plugins.get(pluginKey(tenantId, id))
    return record && clonePlugin(record)
  }

  async list(tenantId: string, options: { limit?: number } = {}): Promise<InstalledPlugin[]> {
    assertPluginIds(tenantId)
    const limit = assertLimit(options.limit, DEFAULT_LIST_LIMIT)
    return [...this.plugins.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort(byInstallDate)
      .slice(0, limit)
      .map(clonePlugin)
  }

  async setEnabled(tenantId: string, id: string, enabled: boolean): Promise<InstalledPlugin> {
    assertPluginIds(tenantId, id)
    const key = pluginKey(tenantId, id)
    const record = this.plugins.get(key)
    if (!record) throw new PluginManifestError('plugin not installed')
    const next: InstalledPlugin = { ...record, enabled: enabled === true }
    this.plugins.set(key, next)
    return clonePlugin(next)
  }
}

/** Structural validation of a manifest read from storage (compatibility is checked on install). */
export function parseManifest(value: unknown): PluginManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('manifest is not an object')
  const manifest = value as Record<string, unknown>
  if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || typeof manifest.botwa !== 'string' || typeof manifest.entry !== 'string') {
    throw new TypeError('bad manifest fields')
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.every((permission) => typeof permission === 'string')) {
    throw new TypeError('bad manifest permissions')
  }
  return {
    id: manifest.id,
    version: manifest.version,
    botwa: manifest.botwa,
    entry: manifest.entry,
    permissions: [...manifest.permissions] as PluginManifest['permissions'],
    ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
    ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
  }
}
