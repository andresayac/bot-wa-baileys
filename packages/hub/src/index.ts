/**
 * @bot-wa/hub — tenant-scoped plugin registry: validated manifests, per-tenant installs
 * and permission-gated enabling.
 *
 * - {@link validateManifest} — checks id, semver, entry path and that the runtime
 *   version satisfies the manifest's `botwa` semver range.
 * - {@link PluginRegistry} — installs validated manifests per tenant and only enables a
 *   plugin once every declared permission has been granted.
 * - {@link MemoryPluginStore} — the in-RAM reference store (default).
 * - {@link KvPluginStore} — persisted through any `DurableKv` of `@bot-wa/core`
 *   (SQLite, PostgreSQL, Redis, file) via `@bot-wa/tenant-kv`.
 *
 * The registry never downloads or executes plugin code; signing, sandboxing and a
 * remote marketplace belong to a later infrastructure layer.
 *
 * Private package: not published to npm.
 *
 * @example
 * ```ts
 * const registry = new PluginRegistry(new KvPluginStore(new PostgresDurableKv({ pool })))
 * await registry.install('acme', manifest, '2.0.0')
 * await registry.enable('acme', manifest.id, manifest.permissions)
 * ```
 */

export { PluginRegistry } from './registry.js'
export type { PluginRegistryOptions } from './registry.js'
export { validateManifest, isRelativeEntry } from './manifest.js'
export { MemoryPluginStore } from './memory.js'
export { KvPluginStore } from './kv.js'
export type { KvPluginStoreOptions } from './kv.js'
export type { PluginStore } from './store.js'
export { PluginManifestError } from './types.js'
export type { PluginPermission, PluginManifest, InstalledPlugin } from './types.js'
