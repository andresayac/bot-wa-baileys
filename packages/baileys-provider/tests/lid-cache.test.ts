import { describe, it, expect } from 'vitest'
import { putBounded } from '../src/boundedMap.js'

// BaileysProvider's `lidCache` grows unbounded — every resolved LID<->PN pair is stored under
// BOTH keys, forever. `putBounded` is the pure cap logic extracted out of the provider (which
// needs a live Baileys socket to construct meaningfully) so it can be unit-tested in isolation.
describe('putBounded', () => {
  it('stores both directions of the pair', () => {
    const map = new Map<string, string>()
    putBounded(map, 'lid1', 'pn1', 10)
    expect(map.get('lid1')).toBe('pn1')
    expect(map.get('pn1')).toBe('lid1')
  })

  it('stays within the cap when inserting more pairs than it allows', () => {
    const map = new Map<string, string>()
    const max = 10
    for (let i = 0; i < 20; i++) putBounded(map, `lid${i}`, `pn${i}`, max)
    expect(map.size).toBeLessThanOrEqual(max)
  })

  it('evicts the oldest pair first (insertion order) once over the cap', () => {
    const map = new Map<string, string>()
    const max = 4 // 2 pairs
    putBounded(map, 'lid0', 'pn0', max)
    putBounded(map, 'lid1', 'pn1', max)
    // adding a 3rd pair pushes size to 6 > 4 -> must evict the oldest pair (lid0/pn0)
    putBounded(map, 'lid2', 'pn2', max)
    expect(map.has('lid0')).toBe(false)
    expect(map.has('pn0')).toBe(false)
  })

  it('keeps the most recently inserted pairs', () => {
    const map = new Map<string, string>()
    const max = 4
    putBounded(map, 'lid0', 'pn0', max)
    putBounded(map, 'lid1', 'pn1', max)
    putBounded(map, 'lid2', 'pn2', max)
    expect(map.get('lid2')).toBe('pn2')
    expect(map.get('pn2')).toBe('lid2')
    expect(map.get('lid1')).toBe('pn1')
    expect(map.get('pn1')).toBe('lid1')
  })
})
