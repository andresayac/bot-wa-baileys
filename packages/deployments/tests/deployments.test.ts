import { describe, expect, it } from 'vitest'

import { DeploymentRegistry } from '../src/index.js'

describe('deployments', () => {
  it('publishes immutable versions and rolls back tenant-locally', () => {
    const r = new DeploymentRegistry()
    r.publish('a', 'bot', '1.0.0', 'hash1')
    r.publish('a', 'bot', '1.1.0', 'hash2')

    expect(r.active('a', 'bot')).toMatchObject({ version: '1.1.0' })
    expect(r.rollback('a', 'bot', '1.0.0')).toMatchObject({ active: true, version: '1.0.0' })
    expect(r.list('b', 'bot')).toEqual([])
    expect(() => r.publish('a', 'bot', '1.0.0', 'hash')).toThrow(/already/)
  })

  it('keeps exactly one active version in publish order', () => {
    const r = new DeploymentRegistry()
    r.publish('a', 'bot', '1.0.0', 'hash1')
    r.publish('a', 'bot', '1.1.0', 'hash2')
    r.rollback('a', 'bot', '1.0.0')

    expect(r.list('a', 'bot').map(({ version, active }) => ({ version, active }))).toEqual([
      { version: '1.0.0', active: true },
      { version: '1.1.0', active: false },
    ])
  })

  it('has no active version before the first publish', () => {
    const r = new DeploymentRegistry()

    expect(r.active('a', 'bot')).toBeUndefined()
  })

  it('rejects empty versions or artifacts and unknown rollback targets', () => {
    const r = new DeploymentRegistry()
    r.publish('a', 'bot', '1.0.0', 'hash1')

    expect(() => r.publish('a', 'bot', '', 'hash')).toThrow('version and artifact are required')
    expect(() => r.publish('a', 'bot', '2.0.0', '')).toThrow('version and artifact are required')
    expect(() => r.rollback('a', 'bot', '9.9.9')).toThrow('deployment not found')
    expect(() => r.rollback('b', 'bot', '1.0.0')).toThrow('deployment not found')
  })

  it('returns copies that cannot mutate stored state', () => {
    const r = new DeploymentRegistry()
    const published = r.publish('a', 'bot', '1.0.0', 'hash1')

    published.active = false
    r.active('a', 'bot')!.artifact = 'tampered'

    expect(r.active('a', 'bot')).toMatchObject({ active: true, artifact: 'hash1' })
  })
})
