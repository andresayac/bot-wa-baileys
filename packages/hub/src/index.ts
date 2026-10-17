/**
 * @bot-wa/hub — in-memory prototype of a tenant-scoped plugin registry.
 *
 * - {@link validateManifest} — checks id, semver, entry path and that the
 *   runtime version satisfies the manifest's `botwa` semver range.
 * - {@link PluginRegistry} — installs validated manifests per tenant and only
 *   enables a plugin once every declared permission has been granted.
 *
 * The registry never downloads or executes plugin code; signing, sandboxing
 * and a remote marketplace belong to a later infrastructure layer.
 *
 * Private prototype: state lives in RAM and is not published to npm.
 *
 * @example
 * ```ts
 * const registry = new PluginRegistry()
 * registry.install('acme', manifest, '2.0.0')
 * registry.enable('acme', manifest.id, manifest.permissions)
 * ```
 */

import { parseRange, parseVersion, satisfies } from './semver.js'

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

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,62}$/

/**
 * Validate a manifest against the running BotWA version and return a copy
 * with deduplicated permissions. Throws {@link PluginManifestError} on the
 * first failing check.
 */
export function validateManifest(manifest: PluginManifest, runtimeVersion: string): PluginManifest {
  if (!PLUGIN_ID.test(manifest.id)) {
    throw new PluginManifestError('plugin id must be lowercase kebab-case')
  }
  if (typeof manifest.version !== 'string' || !parseVersion(manifest.version)) {
    throw new PluginManifestError('plugin version must be semver')
  }
  if (!isRelativeEntry(manifest.entry)) {
    throw new PluginManifestError('plugin entry must be a relative path')
  }
  const runtime = typeof runtimeVersion === 'string' ? parseVersion(runtimeVersion) : undefined
  if (!runtime) {
    throw new PluginManifestError('runtime version must be semver')
  }
  const range = parseRange(manifest.botwa)
  if (!range) {
    throw new PluginManifestError('invalid botwa range')
  }
  if (!satisfies(runtime, range)) {
    throw new PluginManifestError('plugin is incompatible with this BotWA runtime')
  }
  return { ...manifest, permissions: [...new Set(manifest.permissions)] }
}

/**
 * In-memory, tenant-scoped plugin registry. Every read returns a copy, so
 * callers cannot mutate stored state.
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, InstalledPlugin>()

  /**
   * Validate and install a plugin for a tenant, disabled. Re-installing the
   * same id replaces the previous record (and disables it again).
   */
  install(tenantId: string, manifest: PluginManifest, runtimeVersion: string): InstalledPlugin {
    const valid = validateManifest(manifest, runtimeVersion)
    const record = { tenantId, manifest: valid, enabled: false, installedAt: Date.now() }
    this.plugins.set(pluginKey(tenantId, valid.id), record)
    return clone(record)
  }

  /**
   * Enable an installed plugin. Throws {@link PluginManifestError} listing
   * the declared permissions missing from `granted`.
   */
  enable(tenantId: string, id: string, granted: readonly PluginPermission[]): InstalledPlugin {
    const record = this.require(tenantId, id)
    const missing = record.manifest.permissions.filter((permission) => !granted.includes(permission))
    if (missing.length) {
      throw new PluginManifestError(`missing granted permissions: ${missing.join(', ')}`)
    }
    record.enabled = true
    return clone(record)
  }

  /** Disable an installed plugin. */
  disable(tenantId: string, id: string): InstalledPlugin {
    const record = this.require(tenantId, id)
    record.enabled = false
    return clone(record)
  }

  /** Plugins installed for a tenant. */
  list(tenantId: string): InstalledPlugin[] {
    return [...this.plugins.values()]
      .filter((record) => record.tenantId === tenantId)
      .map(clone)
  }

  private require(tenantId: string, id: string): InstalledPlugin {
    const record = this.plugins.get(pluginKey(tenantId, id))
    if (!record) throw new PluginManifestError('plugin not installed')
    return record
  }
}

/**
 * `true` for a POSIX relative path that stays inside the plugin package: no
 * absolute or drive/UNC paths, URLs, backslashes, control characters, empty
 * segments or `..` segments. Names merely containing dots (`a..b.js`) are fine.
 */
function isRelativeEntry(entry: unknown): boolean {
  if (typeof entry !== 'string' || !entry.trim()) return false
  // Backslashes, colons (drive letters, URL schemes, NTFS streams) and control characters.
  if (/[\\:\u0000-\u001f\u007f]/.test(entry)) return false
  if (entry.startsWith('/')) return false
  const segments = entry.split('/')
  if (segments.some((segment) => segment === '' || segment === '..')) return false
  return segments[segments.length - 1] !== '.'
}

/** Tenant-scoped map key (NUL-separated, so equal ids in different tenants never collide). */
function pluginKey(tenantId: string, id: string): string {
  return `${tenantId}\u0000${id}`
}

function clone(record: InstalledPlugin): InstalledPlugin {
  return {
    ...record,
    manifest: { ...record.manifest, permissions: [...record.manifest.permissions] },
  }
}
