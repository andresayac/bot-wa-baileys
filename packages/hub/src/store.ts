/**
 * PluginStore — the storage contract of `@botmesh/hub`. `MemoryPluginStore` is the
 * reference implementation and `KvPluginStore` persists through any `DurableKv` of
 * `@botmesh/core`; both pass `test-utils/plugin-store-conformance.ts`.
 *
 * `install` replaces the record (and disables it again), `setEnabled` is a
 * compare-and-set loop, and every read returns a copy.
 */

import type { InstalledPlugin } from './types.js'

export interface PluginStore {
  /** Store a validated record, replacing the previous one for that id. */
  install(record: InstalledPlugin): Promise<InstalledPlugin>
  /** Copy of an installed plugin, or `undefined` when it does not exist in that tenant. */
  get(tenantId: string, id: string): Promise<InstalledPlugin | undefined>
  /** Plugins installed for a tenant, most recently installed first. */
  list(tenantId: string, options?: { limit?: number }): Promise<InstalledPlugin[]>
  /**
   * Enable or disable an installed plugin.
   * @throws {PluginManifestError} (`plugin not installed`) when it does not exist in that tenant.
   */
  setEnabled(tenantId: string, id: string, enabled: boolean): Promise<InstalledPlugin>
}
