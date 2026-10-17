/**
 * The in-memory fake must behave like real Redis for every command the store
 * sends, or the hermetic suites prove nothing. The same probes run against a
 * live server in integration.test.ts, which keeps these expectations honest.
 */
import { describe, expect, it } from 'vitest'
import { FakeRedisClient } from './fakeRedis.js'
import { PROBES, meets, outcome } from './redis-probes.js'

describe('FakeRedisClient matches real Redis', () => {
  for (const probe of PROBES) {
    it(probe.name, async () => {
      const fake = new FakeRedisClient()
      const actual = await outcome(probe, fake, { k: (name) => `p:${name}`, ns: 'p:' })
      expect(meets(actual, probe.expected), `got ${JSON.stringify(actual)}`).toBe(true)
    })
  }

  it('rejects any script the store does not send', async () => {
    const fake = new FakeRedisClient()
    await expect(fake.eval('return 1', { keys: [], arguments: [] })).rejects.toThrow(/unknown script/i)
  })

  it('EVAL runs atomically: no other command interleaves with a script', async () => {
    const fake = new FakeRedisClient()
    await fake.set('k', 'v1')
    const { MERGE_CAS_SCRIPT } = await import('../src/scripts.js')
    // Fired together, exactly one of two CAS writes from the same base wins.
    const results = await Promise.all([
      fake.eval(MERGE_CAS_SCRIPT, { keys: ['k'], arguments: ['1', 'v1', 'a'] }),
      fake.eval(MERGE_CAS_SCRIPT, { keys: ['k'], arguments: ['1', 'v1', 'b'] }),
    ])
    expect(results.sort()).toEqual([0, 1])
  })
})
