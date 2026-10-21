import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createEnvelope,
  EventWorker,
  FileEventJournal,
  MemoryEventJournal,
} from '../src/index.js'

const context = {
  tenantId: 'tenant',
  environmentId: 'prod',
  botId: 'support',
  providerId: 'meta',
  connectionId: 'primary',
  chatId: 'chat-1',
}

describe('@botmesh/events', () => {
  it('recovers durable records, leases and idempotency after reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'botwa-events-'))
    try {
      const path = join(directory, 'journal.json')
      const event = createEnvelope({ eventId: 'durable', eventType: 'message.received', context, payload: { text: 'persist' } })
      const first = await FileEventJournal.open(path)
      expect(await first.append(event)).toBe(true)
      await first.claim(1, { now: event.occurredAt, leaseMs: 5 })
      const reopened = await FileEventJournal.open(path)
      expect(await reopened.append(event)).toBe(false)
      expect((await reopened.claim(1, { now: event.occurredAt + 6 }))[0]).toMatchObject({ envelope: { eventId: 'durable' }, attempts: 2 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('creates a versioned envelope with stable correlation and partition data', () => {
    const event = createEnvelope({ eventId: 'e1', eventType: 'message.received', context, payload: { text: 'hi' } })
    expect(event).toMatchObject({
      eventId: 'e1',
      eventType: 'message.received',
      schemaVersion: 1,
      correlationId: 'e1',
      idempotencyKey: 'e1',
      partitionKey: 'tenant/support/primary/chat-1',
    })
  })

  it('deduplicates by event id and idempotency key', async () => {
    const journal = new MemoryEventJournal()
    const first = createEnvelope({ eventId: 'e1', eventType: 'x', idempotencyKey: 'same', context, payload: {} })
    const second = createEnvelope({ eventId: 'e2', eventType: 'x', idempotencyKey: 'same', context, payload: {} })
    expect(await journal.append(first)).toBe(true)
    expect(await journal.append(first)).toBe(false)
    expect(await journal.append(second)).toBe(false)
  })

  it('recovers expired leases', async () => {
    const journal = new MemoryEventJournal()
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'x', occurredAt: 1, context, payload: {} }))
    expect(await journal.claim(1, { now: 10, leaseMs: 5 })).toHaveLength(1)
    expect(await journal.claim(1, { now: 14 })).toHaveLength(0)
    expect(await journal.claim(1, { now: 15 })).toHaveLength(1)
  })

  it('retries failures, moves exhausted records to DLQ and supports replay', async () => {
    const journal = new MemoryEventJournal()
    const worker = new EventWorker(journal, { maxAttempts: 2, retryDelayMs: 0 })
    const handler = vi.fn(async () => { throw new Error('down') })
    worker.on('x', handler)
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'x', occurredAt: 1, context, payload: {} }))

    await worker.runBatch()
    expect((await journal.get('e1'))?.state).toBe('failed')
    await worker.runBatch()
    expect((await journal.get('e1'))?.state).toBe('dead')

    await journal.replay('e1')
    expect((await journal.get('e1'))?.state).toBe('pending')
  })

  it('acknowledges successfully handled events', async () => {
    const journal = new MemoryEventJournal()
    const worker = new EventWorker(journal)
    const handler = vi.fn()
    worker.on('x', handler)
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'x', context, payload: { value: 1 } }))

    expect(await worker.runBatch()).toEqual({ processed: 1, failed: 0, stale: 0 })
    expect(handler).toHaveBeenCalledOnce()
    expect((await journal.get('e1'))?.state).toBe('done')
  })
})
