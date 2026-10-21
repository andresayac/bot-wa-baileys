/** PostgresDurability (hermetic, FakeDurablePool) against the shared durability suites. */
import { describe, expect, it } from 'vitest'
import { Bot, MemoryStore, flow } from '@botmesh/core'
import { CrashableProvider, MockProvider, crashable } from '@botmesh/core/testing'
import { PostgresDurability, PostgresDurableKv } from '../src/index.js'
import { FakeDurablePool } from './fakeDurablePool.js'
import { runDurabilityConformance, runDurableKvConformance } from '../../../test-utils/durability-conformance.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'

runDurableKvConformance('PostgresDurableKv (fake pool)', {
  async make() {
    const kv = new PostgresDurableKv({ pool: new FakeDurablePool() })
    await kv.start()
    return { kv, teardown: () => kv.stop() }
  },
})

runDurabilityConformance('PostgresDurability (fake pool)', {
  async make() {
    const backend = new PostgresDurability({ pool: new FakeDurablePool() })
    await backend.start()
    return { backend, teardown: () => backend.stop() }
  },
})

const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps
runCrashRecoveryMatrix('PostgresDurability (fake pool)', deps, {
  async make() { return { backend: new PostgresDurability({ pool: new FakeDurablePool() }), teardown: async () => {} } },
})

describe('PostgresDurability', () => {
  it('creates its table idempotently, with the prefix', async () => {
    const pool = new FakeDurablePool()
    const kv = new PostgresDurableKv({ pool, tablePrefix: 'bot1_' })
    await kv.start()
    await kv.start()
    expect(pool.statements.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS bot1_durable '))).toHaveLength(2)
    expect(kv.table).toBe('bot1_durable')
  })

  it('never ends an injected pool and rejects a bad prefix', async () => {
    const pool = new FakeDurablePool()
    const backend = new PostgresDurability({ pool })
    await backend.start()
    await backend.stop()
    expect(pool.ended).toBe(false)
    expect(() => new PostgresDurability({ tablePrefix: 'x; DROP' })).toThrow(/tablePrefix/)
  })

  it('retries a lost catalog race on CREATE … IF NOT EXISTS', async () => {
    const pool = new FakeDurablePool()
    let raced = false
    const query = pool.query.bind(pool)
    pool.query = async (text, values) => {
      if (!raced && text.startsWith('CREATE TABLE')) { raced = true; throw Object.assign(new Error('duplicate'), { code: '23505' }) }
      return query(text, values)
    }
    await new PostgresDurableKv({ pool }).start()
    expect(raced).toBe(true)
  })
})
