/** RedisDurability (hermetic, FakeRedisClient) against the shared durability suites. */
import { describe, expect, it } from 'vitest'
import { Bot, MemoryStore, flow } from '@botmesh/core'
import { CrashableProvider, MockProvider, crashable } from '@botmesh/core/testing'
import { RedisDurability, RedisDurableKv } from '../src/index.js'
import { FakeRedisClient } from './fakeRedis.js'
import { runDurabilityConformance, runDurableKvConformance } from '../../../test-utils/durability-conformance.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'

runDurableKvConformance('RedisDurableKv (fake)', {
  async make() { return { kv: new RedisDurableKv({ client: new FakeRedisClient() }), teardown: async () => {} } },
})

runDurabilityConformance('RedisDurability (fake)', {
  async make() {
    const backend = new RedisDurability({ client: new FakeRedisClient() })
    await backend.start()
    return { backend, teardown: () => backend.stop() }
  },
})

const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps
runCrashRecoveryMatrix('RedisDurability (fake)', deps, {
  async make() { return { backend: new RedisDurability({ client: new FakeRedisClient() }), teardown: async () => {} } },
})

describe('RedisDurability keys', () => {
  it('lives under the prefix, one hash tag per journal, apart from RedisStore keys', async () => {
    const client = new FakeRedisClient()
    const backend = new RedisDurability({ client, prefix: 'mybot' })
    await backend.inbox.append({ id: 'e1', partitionKey: 'p', kind: 'message', payload: {}, receivedAt: 1 }, 1)
    await backend.outbox.put({ key: 'k1', chatId: 'c', content: 'x', createdAt: 1 }, 1)
    expect((await client.keys('*')).sort()).toEqual([
      'mybot:{durable:inbox}:doc:e1', 'mybot:{durable:inbox}:due',
      'mybot:{durable:outbox}:doc:k1', 'mybot:{durable:outbox}:due',
    ])
  })

  it('never closes an injected client', async () => {
    const client = new FakeRedisClient()
    let quit = false
    client.quit = async () => { quit = true; return 'OK' }
    const backend = new RedisDurability({ client })
    await backend.start()
    await backend.stop()
    expect(quit).toBe(false)
  })
})
