import { describe, expect, it } from 'vitest'
import { MemoryKv } from '@bot-wa/core'

import { DeploymentExistsError, DeploymentNotFoundError, DeploymentRegistry, KvDeploymentStore, MemoryDeploymentStore } from '../src/index.js'

/** The same registry logic over the memory store and over a kv-backed store. */
const stores = [
  ['MemoryDeploymentStore', () => new DeploymentRegistry(new MemoryDeploymentStore())],
  ['KvDeploymentStore', () => new DeploymentRegistry(new KvDeploymentStore(new MemoryKv()))],
] as const

describe.each(stores)('deployments over %s', (_name, make) => {
  it('publishes immutable versions and rolls back tenant-locally', async () => {
    const r = make()
    await r.publish('a', 'bot', '1.0.0', 'hash1')
    await r.publish('a', 'bot', '1.1.0', 'hash2')

    expect(await r.active('a', 'bot')).toMatchObject({ version: '1.1.0' })
    expect(await r.rollback('a', 'bot', '1.0.0')).toMatchObject({ active: true, version: '1.0.0' })
    expect(await r.list('b', 'bot')).toEqual([])
    await expect(r.publish('a', 'bot', '1.0.0', 'hash')).rejects.toThrow(/already/)
    await expect(r.publish('a', 'bot', '1.0.0', 'hash')).rejects.toBeInstanceOf(DeploymentExistsError)
  })

  it('keeps exactly one active version in publish order', async () => {
    const r = make()
    await r.publish('a', 'bot', '1.0.0', 'hash1')
    await r.publish('a', 'bot', '1.1.0', 'hash2')
    await r.rollback('a', 'bot', '1.0.0')

    expect((await r.list('a', 'bot')).map(({ version, active }) => ({ version, active }))).toEqual([
      { version: '1.0.0', active: true },
      { version: '1.1.0', active: false },
    ])
    expect(await r.get('a', 'bot', '1.1.0')).toMatchObject({ artifact: 'hash2', active: false })
  })

  it('has no active version before the first publish', async () => {
    const r = make()

    expect(await r.active('a', 'bot')).toBeUndefined()
    expect(await r.get('a', 'bot', '1.0.0')).toBeUndefined()
  })

  it('rejects empty versions or artifacts and unknown rollback targets', async () => {
    const r = make()
    await r.publish('a', 'bot', '1.0.0', 'hash1')

    await expect(r.publish('a', 'bot', '', 'hash')).rejects.toThrow('version and artifact are required')
    await expect(r.publish('a', 'bot', '2.0.0', '')).rejects.toThrow('version and artifact are required')
    await expect(r.rollback('a', 'bot', '9.9.9')).rejects.toThrow('deployment not found')
    await expect(r.rollback('b', 'bot', '1.0.0')).rejects.toBeInstanceOf(DeploymentNotFoundError)
  })

  it('returns copies that cannot mutate stored state', async () => {
    const r = make()
    const published = await r.publish('a', 'bot', '1.0.0', 'hash1')

    published.active = false
    ;(await r.active('a', 'bot'))!.artifact = 'tampered'

    expect(await r.active('a', 'bot')).toMatchObject({ active: true, artifact: 'hash1' })
  })
})

describe('DeploymentRegistry', () => {
  it('defaults to an in-memory store and validates its options', () => {
    expect(new DeploymentRegistry()).toBeInstanceOf(DeploymentRegistry)
    expect(() => new DeploymentRegistry(undefined, { gateTimeoutMs: 0 })).toThrow(RangeError)
    expect(() => new DeploymentRegistry(undefined, { maxGateDetailsBytes: 1.5 })).toThrow(RangeError)
  })

  it('persists across registry instances sharing one kv (a restart)', async () => {
    const kv = new MemoryKv()
    const first = new DeploymentRegistry(new KvDeploymentStore(kv))
    await first.publish('acme', 'support', '1.0.0', 'sha:1')
    await first.publish('acme', 'support', '1.1.0', 'sha:2')
    await first.rollback('acme', 'support', '1.0.0')

    const second = new DeploymentRegistry(new KvDeploymentStore(kv))
    expect(await second.active('acme', 'support')).toMatchObject({ version: '1.0.0', artifact: 'sha:1' })
    expect((await second.list('acme', 'support')).map((d) => d.version)).toEqual(['1.0.0', '1.1.0'])
  })
})
