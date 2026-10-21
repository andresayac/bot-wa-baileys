/**
 * Manifest validation: id, semver, entry path and runtime compatibility. Pure (no I/O),
 * shared by the registry and re-exported for hosts that validate before installing.
 */

import { parseRange, parseVersion, satisfies } from './semver.js'
import { PluginManifestError, type PluginManifest } from './types.js'

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,62}$/

/**
 * Validate a manifest against the running BotWA version and return a copy with
 * deduplicated permissions. Throws {@link PluginManifestError} on the first failing check.
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
 * `true` for a POSIX relative path that stays inside the plugin package: no
 * absolute or drive/UNC paths, URLs, backslashes, control characters, empty
 * segments or `..` segments. Names merely containing dots (`a..b.js`) are fine.
 */
export function isRelativeEntry(entry: unknown): boolean {
  if (typeof entry !== 'string' || !entry.trim()) return false
  // Backslashes, colons (drive letters, URL schemes, NTFS streams) and control characters.
  if (/[\\:\u0000-\u001f\u007f]/.test(entry)) return false
  if (entry.startsWith('/')) return false
  const segments = entry.split('/')
  if (segments.some((segment) => segment === '' || segment === '..')) return false
  return segments[segments.length - 1] !== '.'
}
