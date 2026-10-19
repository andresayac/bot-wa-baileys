import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createEnvelope, EventWorker, FileEventJournal, MemoryEventJournal } from '../src/index.js'

const context = { tenantId: 't', environmentId: 'prod', botId: 'b', providerId: 'p', connectionId: 'c', chatId: 'chat' }

describe('FileEventJournal write failures', () => {
  it('keeps persisting after one failed write (the write queue is not poisoned)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'botwa-events-'))
    try {
      const blocker = join(dir, 'sub')
      const path = join(blocker, 'journal.json')
      const journal = await FileEventJournal.open(path)
      // A file where the parent directory should be: the first write fails.
      await writeFile(blocker, 'not a directory')
      await expect(journal.append(createEnvelope({ eventType: 'a', context, payload: 1 }))).rejects.toThrow()

      await rm(blocker)
      await expect(journal.append(createEnvelope({ eventType: 'b', context, payload: 2 }))).resolves.toBe(true)
      const saved = JSON.parse(await readFile(path, 'utf8')) as { records: unknown[] }
      expect(saved.records).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('EventWorker.on unsubscribe', () => {
  it('a stale unsubscribe does not remove a handler registered later for the same type', async () => {
    const journal = new MemoryEventJournal()
    const worker = new EventWorker(journal)
    const off = worker.on('x', () => {})
    off()
    const seen: unknown[] = []
    worker.on('x', (e) => { seen.push(e.payload) })
    off() // stale: must be a no-op
    await journal.append(createEnvelope({ eventType: 'x', context, payload: 42 }))
    expect(await worker.runBatch()).toEqual({ processed: 1, failed: 0, stale: 0 })
    expect(seen).toEqual([42])
  })
})
