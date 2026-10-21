import { describe, expect, it } from 'vitest'
import { MemoryKv } from '@bot-wa/core'

import { KvPluginStore, MemoryPluginStore, PluginManifestError, PluginRegistry, validateManifest } from '../src/index.js'

const manifest = {
  id: 'crm-sync',
  version: '1.0.0',
  botwa: '^2.0.0',
  entry: 'dist/index.js',
  permissions: ['contacts:read', 'network:egress'] as const,
}

const stores = [
  ['MemoryPluginStore', () => new PluginRegistry(new MemoryPluginStore(), { clock: () => 1_000 })],
  ['KvPluginStore', () => new PluginRegistry(new KvPluginStore(new MemoryKv()), { clock: () => 1_000 })],
] as const

describe.each(stores)('plugin hub over %s', (_name, make) => {
  it('validates compatibility and requires grants per tenant', async () => {
    const registry = make()
    await registry.install('a', manifest, '2.1.0')

    await expect(registry.enable('a', 'crm-sync', ['contacts:read'])).rejects.toThrow(/network:egress/)
    expect(await registry.enable('a', 'crm-sync', manifest.permissions)).toMatchObject({ enabled: true })
    expect(await registry.list('b')).toEqual([])
  })

  it('disables plugins and re-installing resets them to disabled', async () => {
    const registry = make()
    await registry.install('a', manifest, '2.0.0')
    await registry.enable('a', 'crm-sync', manifest.permissions)

    expect(await registry.disable('a', 'crm-sync')).toMatchObject({ enabled: false })

    await registry.enable('a', 'crm-sync', manifest.permissions)
    await registry.install('a', manifest, '2.0.0')
    expect(await registry.list('a')).toMatchObject([{ enabled: false }])
  })

  it('fails on plugins not installed in the tenant', async () => {
    const registry = make()
    await registry.install('a', manifest, '2.0.0')

    await expect(registry.enable('b', 'crm-sync', manifest.permissions)).rejects.toThrow('plugin not installed')
    await expect(registry.disable('b', 'crm-sync')).rejects.toBeInstanceOf(PluginManifestError)
  })
})

describe('manifest validation', () => {
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
})

describe('entry path validation', () => {
  const entry = (value: string) => () => validateManifest({ ...manifest, entry: value }, '2.0.0')

  it.each([
    'C:/x.js',
    'c:\\x.js',
    'C:x.js',
    '\\\\server\\share\\x.js',
    '\\x.js',
    'dist\\index.js',
    'file:///x.js',
    'https://evil.example/x.js',
    'data:text/javascript,1',
    '//server/x.js',
    '/abs.js',
    '..',
    '../x.js',
    'dist/../../x.js',
    'dist/..',
    'dist//x.js',
    'dist/',
    'dist/\u0000.js',
    ' ',
  ])('rejects %j', (value) => {
    expect(entry(value)).toThrow(/relative path/)
  })

  it.each(['index.js', 'dist/index.js', './dist/index.js', 'a..b.js', 'dist/..hidden/x.js', 'v1.2/x.mjs'])(
    'accepts %j',
    (value) => {
      expect(validateManifest({ ...manifest, entry: value }, '2.0.0').entry).toBe(value)
    },
  )

  it('rejects non-string entries', () => {
    expect(() => validateManifest({ ...manifest, entry: 42 as unknown as string }, '2.0.0')).toThrow(/relative path/)
  })
})

describe('botwa range compatibility', () => {
  const compatible = (range: string, runtime: string) => {
    try {
      validateManifest({ ...manifest, botwa: range }, runtime)
      return true
    } catch (error) {
      if (error instanceof PluginManifestError && /incompatible/.test(error.message)) return false
      throw error
    }
  }

  it.each([
    ['^2.0.0', '2.0.0', true],
    ['^2.0.0', '2.9.3', true],
    ['^2.1.0', '2.0.9', false],
    ['^2.0.0', '3.0.0', false],
    ['^2.0.0', '1.9.9', false],
    ['^0.2.3', '0.2.9', true],
    ['^0.2.3', '0.3.0', false],
    ['^0.0.3', '0.0.4', false],
    ['^2.x', '2.5.0', true],
    ['~2.1.0', '2.1.7', true],
    ['~2.1.0', '2.2.0', false],
    ['~2', '2.9.0', true],
    ['>=2.1.0', '2.1.0', true],
    ['>=2.1.0', '12.0.0', true],
    ['>=2.1.0', '2.0.9', false],
    ['<3.0.0', '2.99.0', true],
    ['<3.0.0', '3.0.0', false],
    ['>=2.0.0 <2.5.0', '2.4.9', true],
    ['>=2.0.0 <2.5.0', '2.5.0', false],
    ['>2.0.0', '2.0.0', false],
    ['<=2.0.0', '2.0.0', true],
    ['2.3.4', '2.3.4', true],
    ['=2.3.4', '2.3.5', false],
    ['2.x', '2.7.1', true],
    ['2.x', '3.0.0', false],
    ['2.1.*', '2.1.5', true],
    ['2.1.X', '2.2.0', false],
    ['2', '2.0.1', true],
    ['*', '7.0.0', true],
    ['^1.0.0 || ^2.0.0', '2.3.0', true],
    ['^1.0.0 || ^3.0.0', '2.3.0', false],
    // The old unanchored regex read these as "major 2".
    ['x2', '2.0.0', null],
    ['12.0.0', '2.0.0', false],
    ['^12.0.0', '2.0.0', false],
    // Prerelease ordering.
    ['^2.0.0', '2.0.0-alpha.1', false],
    ['^2.0.0-alpha.1', '2.0.0-alpha.2', true],
    ['>=2.0.0-alpha.10', '2.0.0-alpha.9', false],
    ['^2.0.0', '3.0.0-alpha.1', false],
    ['^2.0.0', '2.1.0+build.5', true],
  ] as const)('%s with runtime %s -> %s', (range, runtime, expected) => {
    if (expected === null) {
      expect(() => compatible(range, runtime)).toThrow(/invalid botwa range/)
    } else {
      expect(compatible(range, runtime)).toBe(expected)
    }
  })

  it.each(['', '^', '>=2.0.0 ||', '^2.0.0 garbage', '~>2.0.0', '2.0.0.0', '^02.0.0'])(
    'rejects the malformed range %j',
    (range) => {
      expect(() => validateManifest({ ...manifest, botwa: range }, '2.0.0')).toThrow(/invalid botwa range/)
    },
  )

  it('rejects an invalid runtime version and a non-semver plugin version', () => {
    expect(() => validateManifest(manifest, 'v2')).toThrow(/runtime version/)
    expect(() => validateManifest({ ...manifest, version: '1.0.0garbage' }, '2.0.0')).toThrow(/semver/)
    expect(validateManifest({ ...manifest, version: '1.0.0-beta.1+sha.1' }, '2.0.0').version).toBe('1.0.0-beta.1+sha.1')
  })
})
