/** Crash-recovery matrix for the in-process backends (memory as a surviving store, file). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bot, FileDurability, MemoryDurability, MemoryStore, flow } from '../src/index.js'
import { CrashableProvider, MockProvider, crashable } from '../src/testing/index.js'
import { runCrashRecoveryMatrix, type CrashMatrixDeps } from '../../../test-utils/durability-crash.js'

const deps = { Bot, MemoryStore, MockProvider, CrashableProvider, crashable, flow } as unknown as CrashMatrixDeps

runCrashRecoveryMatrix('MemoryDurability', deps, {
  async make() { return { backend: new MemoryDurability(), teardown: async () => {} } },
})

runCrashRecoveryMatrix('FileDurability', deps, {
  async make() {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-crash-'))
    const backend = await FileDurability.open(join(dir, 'journal.json'))
    return { backend, teardown: async () => { await backend.close(); rmSync(dir, { recursive: true, force: true }) } }
  },
})

// Seeded property run: crash at random journal writes (the seed makes failures reproducible).
import { randomCrashPoints } from '../../../test-utils/durability-crash.js'
runCrashRecoveryMatrix('MemoryDurability (random points)', deps, {
  async make() { return { backend: new MemoryDurability(), teardown: async () => {} } },
}, randomCrashPoints(20261019, 12))
