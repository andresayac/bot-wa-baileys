/** Memory + file durability backends against the shared durability conformance suites. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileDurability, MemoryDurability, MemoryKv } from '../src/index.js'
import { runDurabilityConformance, runDurableKvConformance } from '../../../test-utils/durability-conformance.js'

runDurableKvConformance('MemoryKv', {
  async make() { return { kv: new MemoryKv(), teardown: async () => {} } },
})

runDurabilityConformance('MemoryDurability', {
  async make() {
    const backend = new MemoryDurability()
    await backend.start()
    return { backend, teardown: () => backend.stop() }
  },
})

runDurabilityConformance('FileDurability', {
  async make() {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-dur-'))
    const backend = await FileDurability.open(join(dir, 'journal.json'))
    await backend.start()
    return {
      backend,
      teardown: async () => { await backend.stop(); await backend.close(); rmSync(dir, { recursive: true, force: true }) },
    }
  },
})

describe('FileDurability persistence', () => {
  it('a reopened journal sees every committed record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-dur-'))
    try {
      const file = join(dir, 'j.json')
      const a = await FileDurability.open(file)
      await a.inbox.append({ id: 'e1', partitionKey: 'p', kind: 'message', payload: { b: 1 }, receivedAt: 1 }, 1)
      await a.outbox.put({ key: 'k1', chatId: 'c', content: { kind: 'text', text: 'hi' }, createdAt: 1 }, 1, { owner: 'o', leaseMs: 10, now: 1 })
      // Same process: a second open is refused until the first journal is closed.
      await expect(FileDurability.open(file)).rejects.toThrow(/already open in this process/)
      await a.close()
      const b = await FileDurability.open(file)
      expect(await b.inbox.get('e1')).toMatchObject({ state: 'pending', payload: { b: 1 } })
      expect(await b.outbox.get('k1')).toMatchObject({ state: 'sending', fencingToken: 1 })
      await b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a journal locked by another live process and takes over a dead one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botwa-dur-'))
    try {
      const file = join(dir, 'j.json')
      const { writeFileSync } = await import('node:fs')
      // The parent of this test runner is alive and is not us.
      writeFileSync(`${file}.lock`, String(process.ppid))
      await expect(FileDurability.open(file)).rejects.toThrow(/locked by live process/)
      writeFileSync(`${file}.lock`, '999999999') // no such pid
      const j = await FileDurability.open(file)
      await j.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
