/** The cluster fake meets the same behaviour probes a real Redis Cluster is verified against. */
import { describe, expect, it } from 'vitest'
import { CLUSTER_PROBES, probeMeets, probeOutcome } from './cluster-probes.js'
import { ClusterFakeRedisClient } from './fakeClusterRedis.js'
import { RedisStore } from '../src/index.js'

describe('ClusterFakeRedisClient probes', () => {
  for (const probe of CLUSTER_PROBES) {
    it(probe.name, async () => {
      const actual = await probeOutcome(probe, new ClusterFakeRedisClient(), 'ns')
      expect(probeMeets(actual, probe.expected), JSON.stringify(actual)).toBe(true)
    })
  }

  it('is detected as a cluster client and refuses whole-keyspace KEYS', async () => {
    const c = new ClusterFakeRedisClient()
    expect(new RedisStore({ client: c }).layout).toBe('cluster')
    await expect(c.keys('*')).rejects.toThrow(/not routable/)
    expect(await c.nodeClient().keys('*')).toEqual([])
  })
})
