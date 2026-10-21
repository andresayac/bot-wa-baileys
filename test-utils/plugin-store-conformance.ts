/**
 * Shared conformance suite for `@botmesh/hub`'s `PluginStore`: tenant isolation, install
 * replacement, enable/disable persistence, bounded listings and copies.
 * `MemoryPluginStore` is the reference; `KvPluginStore` must behave identically on every
 * backend.
 *
 * Type-only imports keep this file runtime-dependency-free (vitest is injected by the runner).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PluginStore } from '../packages/hub/src/store.js'
import type { InstalledPlugin, PluginManifest, PluginPermission } from '../packages/hub/src/types.js'

export interface PluginStoreHarness {
  /** A fresh store, and its teardown. */
  make(): Promise<{ store: PluginStore; teardown: () => Promise<void> }>
}

const manifest = (overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'crm-sync',
  version: '1.0.0',
  botwa: '^2.0.0',
  entry: 'dist/index.js',
  permissions: ['contacts:read', 'network:egress'],
  ...overrides,
})

const record = (overrides: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  tenantId: 'a',
  manifest: manifest(),
  enabled: false,
  installedAt: 1_700_000_000_000,
  ...overrides,
})

export function runPluginStoreConformance(name: string, harness: PluginStoreHarness): void {
  describe(`${name} — PluginStore conformance`, () => {
    let store: PluginStore
    let teardown: () => Promise<void>
    beforeEach(async () => { ({ store, teardown } = await harness.make()) })
    afterEach(async () => { await teardown() })

    it('isolates tenants: the same plugin id in two tenants are two records', async () => {
      await store.install(record())
      await store.install(record({ tenantId: 'b', enabled: true }))
      expect(await store.get('a', 'crm-sync')).toMatchObject({ tenantId: 'a', enabled: false })
      expect(await store.get('b', 'crm-sync')).toMatchObject({ tenantId: 'b', enabled: true })
      expect(await store.get('c', 'crm-sync')).toBeUndefined()
      expect((await store.list('a')).map((r) => r.tenantId)).toEqual(['a'])
      await expect(store.setEnabled('c', 'crm-sync', true)).rejects.toMatchObject({ name: 'PluginManifestError' })
    })

    it('install replaces the record, disabling it again', async () => {
      await store.install(record())
      await store.setEnabled('a', 'crm-sync', true)
      expect(await store.get('a', 'crm-sync')).toMatchObject({ enabled: true })
      const replaced = await store.install(record({ installedAt: 2_000, manifest: manifest({ version: '2.0.0' }) }))
      expect(replaced).toMatchObject({ enabled: false, installedAt: 2_000, manifest: { version: '2.0.0' } })
      expect(await store.get('a', 'crm-sync')).toMatchObject({ enabled: false, manifest: { version: '2.0.0' } })
    })

    it('enables and disables an installed plugin', async () => {
      await store.install(record())
      expect(await store.setEnabled('a', 'crm-sync', true)).toMatchObject({ enabled: true })
      expect(await store.setEnabled('a', 'crm-sync', false)).toMatchObject({ enabled: false })
      await expect(store.setEnabled('a', 'missing', true)).rejects.toMatchObject({ name: 'PluginManifestError' })
    })

    it('lists most recently installed first and bounds the result', async () => {
      await store.install(record({ manifest: manifest({ id: 'one' }), installedAt: 1 }))
      await store.install(record({ manifest: manifest({ id: 'two' }), installedAt: 3 }))
      await store.install(record({ manifest: manifest({ id: 'three' }), installedAt: 2 }))
      expect((await store.list('a')).map((r) => r.manifest.id)).toEqual(['two', 'three', 'one'])
      expect((await store.list('a', { limit: 2 })).map((r) => r.manifest.id)).toEqual(['two', 'three'])
      expect(await store.list('a', { limit: 0 })).toEqual([])
      await expect(store.list('a', { limit: -1 })).rejects.toThrow(RangeError)
    })

    it('returns copies that cannot mutate stored state', async () => {
      const installed = await store.install(record())
      installed.enabled = true
      ;(installed.manifest.permissions as PluginPermission[]).push('secrets:read')
      const read = (await store.get('a', 'crm-sync'))!
      ;(read.manifest.permissions as PluginPermission[]).push('secrets:read')
      expect(await store.get('a', 'crm-sync')).toMatchObject({ enabled: false })
      expect((await store.get('a', 'crm-sync'))!.manifest.permissions).toEqual(['contacts:read', 'network:egress'])
    })

    it('rejects empty tenant and plugin ids', async () => {
      await expect(store.install(record({ tenantId: '' }))).rejects.toThrow(TypeError)
      await expect(store.install(record({ manifest: manifest({ id: '' }) }))).rejects.toThrow(TypeError)
      await expect(store.get('', 'x')).rejects.toThrow(TypeError)
      await expect(store.list('')).rejects.toThrow(TypeError)
    })
  })
}
