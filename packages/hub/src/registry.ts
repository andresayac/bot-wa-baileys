/**
 * PluginRegistry — tenant-scoped registry over a {@link PluginStore}. A manifest is
 * validated once (id, semver, entry path and runtime compatibility) and a plugin is only
 * enabled once every declared permission has been granted. The registry never downloads
 * or executes plugin code; signing, sandboxing and a remote marketplace belong to a later
 * infrastructure layer.
 */

import { validateManifest } from './manifest.js'
import { MemoryPluginStore, clonePlugin } from './memory.js'
import type { PluginStore } from './store.js'
import { PluginManifestError, type InstalledPlugin, type PluginManifest, type PluginPermission } from './types.js'

export interface PluginRegistryOptions {
  /** Time source (epoch ms). Default `Date.now`. */
  clock?: () => number
}

export class PluginRegistry {
  private readonly clock: () => number

  constructor(readonly store: PluginStore = new MemoryPluginStore(), options: PluginRegistryOptions = {}) {
    this.clock = options.clock ?? Date.now
  }

  /**
   * Validate and install a plugin for a tenant, disabled. Re-installing the same id
   * replaces the previous record (and disables it again).
   */
  async install(tenantId: string, manifest: PluginManifest, runtimeVersion: string): Promise<InstalledPlugin> {
    const valid = validateManifest(manifest, runtimeVersion)
    return this.store.install({ tenantId, manifest: valid, enabled: false, installedAt: this.clock() })
  }

  /**
   * Enable an installed plugin. Rejects with {@link PluginManifestError} listing the
   * declared permissions missing from `granted`.
   */
  async enable(tenantId: string, id: string, granted: readonly PluginPermission[]): Promise<InstalledPlugin> {
    const record = await this.store.get(tenantId, id)
    if (!record) throw new PluginManifestError('plugin not installed')
    const missing = record.manifest.permissions.filter((permission) => !granted.includes(permission))
    if (missing.length) {
      throw new PluginManifestError(`missing granted permissions: ${missing.join(', ')}`)
    }
    return this.store.setEnabled(tenantId, id, true)
  }

  /** Disable an installed plugin. */
  disable(tenantId: string, id: string): Promise<InstalledPlugin> {
    return this.store.setEnabled(tenantId, id, false)
  }

  /** Plugins installed for a tenant, most recently installed first. */
  async list(tenantId: string, options?: { limit?: number }): Promise<InstalledPlugin[]> {
    return this.store.list(tenantId, options)
  }

  /** Copy of an installed plugin, or `undefined`. */
  async get(tenantId: string, id: string): Promise<InstalledPlugin | undefined> {
    const record = await this.store.get(tenantId, id)
    return record && clonePlugin(record)
  }
}
