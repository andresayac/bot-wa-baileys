/**
 * @bot-wa/hub — in-memory prototype of a tenant-scoped plugin registry.
 *
 * - {@link validateManifest} — checks id, semver, entry path and runtime
 *   major-version compatibility of a {@link PluginManifest}.
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
  /** Plugin version; must start with `MAJOR.MINOR.PATCH`. */
  version: string
  /** Required BotWA runtime range; only its major version is checked (e.g. `^2.0.0`). */
  botwa: string
  /** Relative path to the entry module (no `..` segments, no leading `/`). */
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
const SEMVER_PREFIX = /^\d+\.\d+\.\d+/

/**
 * Validate a manifest against the running BotWA version and return a copy
 * with deduplicated permissions. Throws {@link PluginManifestError} on the
 * first failing check.
 */
export function validateManifest(manifest: PluginManifest, runtimeVersion: string): PluginManifest {
  if (!PLUGIN_ID.test(manifest.id)) {
    throw new PluginManifestError('plugin id must be lowercase kebab-case')
  }
  if (!SEMVER_PREFIX.test(manifest.version)) {
    throw new PluginManifestError('plugin version must be semver')
  }
  if (!isRelativeEntry(manifest.entry)) {
    throw new PluginManifestError('plugin entry must be a relative path')
  }
  if (!satisfiesMajor(runtimeVersion, manifest.botwa)) {
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

function isRelativeEntry(entry: string): boolean {
  return !!entry && !entry.includes('..') && !entry.startsWith('/')
}

/** `true` when the runtime's leading major equals the first number found in `range`. */
function satisfiesMajor(runtime: string, range: string): boolean {
  const runtimeMajor = runtime.match(/^(\d+)/)?.[1]
  const required = range.match(/\^?(\d+)/)?.[1]
  return !!runtimeMajor && !!required && runtimeMajor === required
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
