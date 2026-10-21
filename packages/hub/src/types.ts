/**
 * Records of `@botmesh/hub`: plugin permissions and manifests, installed plugins, the
 * manifest error and the store inputs.
 */

/** Capability a plugin must declare in its manifest and a tenant must grant. */
export type PluginPermission =
  | 'messages:read'
  | 'messages:send'
  | 'contacts:read'
  | 'contacts:write'
  | 'network:egress'
  | 'secrets:read'

/** Static description of a plugin package. */
export interface PluginManifest {
  /** Lowercase kebab-case id, 2–63 characters. */
  id: string
  /** Plugin version; a full semver version (`MAJOR.MINOR.PATCH[-pre][+build]`). */
  version: string
  /**
   * Required BotWA runtime semver range (e.g. `^2.0.0`, `~2.1.0`, `>=2.0.0 <3.0.0`,
   * `2.x`, `^1.0.0 || ^2.0.0`). Hyphen ranges and the `v` prefix are not supported.
   */
  botwa: string
  /**
   * POSIX relative path to the entry module: `/`-separated, no `..` or empty
   * segments, no leading `/`, no backslashes, colons (drive letters, URL
   * schemes) or control characters.
   */
  entry: string
  /** Permissions the plugin needs; all must be granted before it can be enabled. */
  permissions: readonly PluginPermission[]
  name?: string
  description?: string
}

/** A plugin installed for one tenant. */
export interface InstalledPlugin {
  tenantId: string
  /** Validated manifest with deduplicated permissions. */
  manifest: PluginManifest
  enabled: boolean
  /** Epoch ms of the (last) install. */
  installedAt: number
}

/** Thrown for invalid manifests, missing grants and unknown plugins. */
export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginManifestError'
  }
}
