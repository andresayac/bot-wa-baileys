/** SQLiteDurableKv / SQLiteDurability against the shared durability suites, plus a two-connection CAS race on one file. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Bot, MemoryStore, flow } from '@botmesh/core'
import { CrashableProvider, MockProvider, crashable } from '@botmesh/core/testing'
import { SQLiteDurability, SQLiteDurableKv, SQLiteStore } from '../src/index.js'
import { runDurabilityConformance, runDurableKvConformance } from '../../../test-utils/durability-conformance.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'botwa-sqlite-dur-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}

runDurableKvConformance('SQLiteDurableKv', {
  async make() {
    const { dir, cleanup } = tempDir()
    const store = new SQLiteStore({ file: join(dir, 'store.db') })
    return { kv: store.durability().kv, teardown: async () => { await store.stop(); cleanup() } }
  },
})

runDurabilityConformance('SQLiteDurability', {
  async make() {
    const { dir, cleanup } = tempDir()
    const store = new SQLiteStore({ file: join(dir, 'store.db') })
    return { backend: store.durability(), teardown: async () => { await store.stop(); cleanup() } }
  },
})

const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps
runCrashRecoveryMatrix('SQLiteDurability', deps, {
  async make() {
    const { dir, cleanup } = tempDir()
    const store = new SQLiteStore({ file: join(dir, 'store.db') })
    return { backend: store.durability(), teardown: async () => { await store.stop(); cleanup() } }
  },
})

describe('SQLiteDurability', () => {
  it('is one instance per store, shares its connection and survives reopening the file', async () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'bot.db')
      const first = new SQLiteStore({ file })
      expect(first.durability()).toBe(first.durability())
      expect(first.durability()).toBeInstanceOf(SQLiteDurability)
      expect(first.durability().kv).toBeInstanceOf(SQLiteDurableKv)
      const v1 = await first.durability().kv.insert('product/x/t', 'a', '{"n":1}', { due: -5, done: null })
      expect(v1).toBe('1')
      await first.stop()

      const second = new SQLiteStore({ file })
      expect(await second.durability().kv.get('product/x/t', 'a')).toEqual({ value: '{"n":1}', version: '1' })
      expect(await second.durability().kv.range('product/x/t', 'due', Number.POSITIVE_INFINITY, 10)).toEqual(['a'])
      await second.stop()
    } finally {
      cleanup()
    }
  })

  it('two connections on one file: exactly one compare-and-set wins', async () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = join(dir, 'bot.db')
      const a = new SQLiteStore({ file })
      const b = new SQLiteStore({ file })
      const v1 = (await a.durability().kv.insert('t', 'x', '0', { due: 1, done: null }))!
      const results = await Promise.all([
        ...Array.from({ length: 5 }, (_, i) => a.durability().kv.replace('t', 'x', v1, `a${i}`, { due: 1, done: null })),
        ...Array.from({ length: 5 }, (_, i) => b.durability().kv.replace('t', 'x', v1, `b${i}`, { due: 1, done: null })),
      ])
      expect(results.filter((r) => r !== undefined)).toHaveLength(1)
      expect((await b.durability().kv.get('t', 'x'))?.version).toBe('2')
      await a.stop()
      await b.stop()
    } finally {
      cleanup()
    }
  })

  it('clamps infinite and fractional scores and rejects garbage versions', async () => {
    const { dir, cleanup } = tempDir()
    const store = new SQLiteStore({ file: join(dir, 'bot.db') })
    try {
      const kv = store.durability().kv
      await kv.insert('t', 'inf', '0', { due: Number.POSITIVE_INFINITY, done: Number.NEGATIVE_INFINITY })
      await kv.insert('t', 'frac', '0', { due: 1.9, done: null })
      expect(await kv.range('t', 'due', 1, 10)).toEqual(['frac'])
      expect(await kv.range('t', 'due', Number.POSITIVE_INFINITY, 10)).toEqual(['frac', 'inf'])
      expect(await kv.range('t', 'done', 0, 10)).toEqual(['inf'])
      expect(await kv.replace('t', 'inf', 'not-a-version', '1', { due: 1, done: null })).toBeUndefined()
      expect(await kv.remove('t', 'inf', 'garbage')).toBe(false)
    } finally {
      await store.stop()
      cleanup()
    }
  })
})
