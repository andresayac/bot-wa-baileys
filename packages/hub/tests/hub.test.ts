import { describe, expect, it } from 'vitest'

import { PluginManifestError, PluginRegistry, validateManifest } from '../src/index.js'

const manifest = {
  id: 'crm-sync',
  version: '1.0.0',
  botwa: '^2.0.0',
  entry: 'dist/index.js',
  permissions: ['contacts:read', 'network:egress'] as const,
}

describe('plugin hub', () => {
  it('validates compatibility and requires grants per tenant', () => {
    const registry = new PluginRegistry()
    registry.install('a', manifest, '2.1.0')

    expect(() => registry.enable('a', 'crm-sync', ['contacts:read'])).toThrow(/network:egress/)
    expect(registry.enable('a', 'crm-sync', manifest.permissions)).toMatchObject({ enabled: true })
    expect(registry.list('b')).toEqual([])
  })

  it('rejects unsafe manifests', () => {
    expect(() => validateManifest({ ...manifest, entry: '../escape.js' }, '2.0.0')).toThrow(PluginManifestError)
    expect(() => validateManifest({ ...manifest, botwa: '^3.0.0' }, '2.0.0')).toThrow(/incompatible/)
  })

  it('rejects malformed ids, versions and entries', () => {
    expect(() => validateManifest({ ...manifest, id: 'CRM_Sync' }, '2.0.0')).toThrow(/kebab-case/)
    expect(() => validateManifest({ ...manifest, version: '1.0' }, '2.0.0')).toThrow(/semver/)
    expect(() => validateManifest({ ...manifest, entry: '/abs/index.js' }, '2.0.0')).toThrow(/relative path/)
    expect(() => validateManifest({ ...manifest, entry: '' }, '2.0.0')).toThrow(/relative path/)
  })

  it('returns a copy with deduplicated permissions', () => {
    const valid = validateManifest(
      { ...manifest, permissions: ['contacts:read', 'contacts:read', 'network:egress'] },
      '2.0.0',
    )

    expect(valid.permissions).toEqual(['contacts:read', 'network:egress'])
  })

  it('disables plugins and re-installing resets them to disabled', () => {
    const registry = new PluginRegistry()
    registry.install('a', manifest, '2.0.0')
    registry.enable('a', 'crm-sync', manifest.permissions)

    expect(registry.disable('a', 'crm-sync')).toMatchObject({ enabled: false })

    registry.enable('a', 'crm-sync', manifest.permissions)
    registry.install('a', manifest, '2.0.0')
    expect(registry.list('a')).toMatchObject([{ enabled: false }])
  })

  it('fails on plugins not installed in the tenant', () => {
    const registry = new PluginRegistry()
    registry.install('a', manifest, '2.0.0')

    expect(() => registry.enable('b', 'crm-sync', manifest.permissions)).toThrow('plugin not installed')
    expect(() => registry.disable('b', 'crm-sync')).toThrow(PluginManifestError)
  })
})
