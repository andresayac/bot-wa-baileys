import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { createEnvelope, EventWorker, FileEventJournal, MemoryEventJournal, StaleLeaseError } from '../src/index.js'

const context = { tenantId: 't', environmentId: 'prod', botId: 'b', providerId: 'p', connectionId: 'c', chatId: 'chat' }

/** A manual clock shared by the journal calls and both workers. */
function manualClock(start = 1_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe('journal fencing tokens', () => {
  it('hands out a strictly increasing fencing token on every claim', async () => {
    const journal = new MemoryEventJournal()
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'x', context, payload: 1, occurredAt: 0 }))
    const [first] = await journal.claim(1, { now: 10, leaseMs: 5 })
    const [second] = await journal.claim(1, { now: 20, leaseMs: 5 })
    expect(first!.fencingToken).toBe(1)
    expect(second!.fencingToken).toBe(2)
    await journal.replay('e1', 30)
    const [third] = await journal.claim(1, { now: 30, leaseMs: 5 })
    // Replay resets attempts but never reuses a token.
    expect(third!.fencingToken).toBe(3)
    expect(third!.attempts).toBe(1)
  })

  it('rejects ack/fail carrying a superseded token and keeps the new owner\'s lease', async () => {
    const journal = new MemoryEventJournal()
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'x', context, payload: 1, occurredAt: 0 }))
    const [a] = await journal.claim(1, { now: 10, leaseMs: 5 })
    const [b] = await journal.claim(1, { now: 16, leaseMs: 5 }) // A's lease expired, B re-claims

    await expect(journal.ack('e1', { now: 17, fencingToken: a!.fencingToken })).rejects.toBeInstanceOf(StaleLeaseError)
    await expect(journal.fail('e1', new Error('late'), { now: 17, fencingToken: a!.fencingToken })).rejects.toMatchObject({
      name: 'StaleLeaseError', eventId: 'e1', fencingToken: a!.fencingToken, currentToken: b!.fencingToken,
    })
    expect(await journal.get('e1')).toMatchObject({ state: 'processing', fencingToken: 2, leaseUntil: 21 })

    await journal.ack('e1', { now: 18, fencingToken: b!.fencingToken })
    expect(await journal.get('e1')).toMatchObject({ state: 'done', completedAt: 18 })
  })

  it('accepts a late ack whose lease expired when nobody re-claimed the event', async () => {
    const journal = new MemoryEventJournal()
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'x', context, payload: 1, occurredAt: 0 }))
    const [a] = await journal.claim(1, { now: 10, leaseMs: 5 })
    await journal.ack('e1', { now: 100, fencingToken: a!.fencingToken })
    expect(await journal.get('e1')).toMatchObject({ state: 'done' })
  })

  it('rejects a fenced ack once the event left processing (double ack, replay)', async () => {
    const journal = new MemoryEventJournal()
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'x', context, payload: 1, occurredAt: 0 }))
    const [a] = await journal.claim(1, { now: 10 })
    await journal.ack('e1', { now: 11, fencingToken: a!.fencingToken })
    await expect(journal.ack('e1', { now: 12, fencingToken: a!.fencingToken })).rejects.toBeInstanceOf(StaleLeaseError)

    await journal.replay('e1', 13)
    await expect(journal.fail('e1', 'x', { now: 14, fencingToken: a!.fencingToken })).rejects.toBeInstanceOf(StaleLeaseError)
    expect(await journal.get('e1')).toMatchObject({ state: 'pending' })
  })

  it('keeps unfenced ack/fail as an operator override', async () => {
    const journal = new MemoryEventJournal()
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'x', context, payload: 1, occurredAt: 0 }))
    await journal.claim(1, { now: 10 })
    await journal.ack('e1', { now: 11 })
    expect(await journal.get('e1')).toMatchObject({ state: 'done', completedAt: 11 })
  })

  it('FileEventJournal persists the token and enforces it after reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'botwa-events-fence-'))
    try {
      const path = join(dir, 'journal.json')
      const first = await FileEventJournal.open(path)
      await first.append(createEnvelope({ eventId: 'e1', eventType: 'x', context, payload: 1, occurredAt: 0 }))
      const [a] = await first.claim(1, { now: 10, leaseMs: 5 })
      const reopened = await FileEventJournal.open(path)
      const [b] = await reopened.claim(1, { now: 20, leaseMs: 5 })
      expect(b!.fencingToken).toBe(a!.fencingToken! + 1)
      await expect(reopened.ack('e1', { now: 21, fencingToken: a!.fencingToken })).rejects.toBeInstanceOf(StaleLeaseError)
      await reopened.ack('e1', { now: 21, fencingToken: b!.fencingToken })
      expect(await (await FileEventJournal.open(path)).get('e1')).toMatchObject({ state: 'done', fencingToken: 2 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('EventWorker with two workers and a clock', () => {
  it('a worker whose lease expired mid-handler cannot ack or fail the event re-claimed by another', async () => {
    const clock = manualClock()
    const journal = new MemoryEventJournal()
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'job', context, payload: 'p', occurredAt: 0 }))

    const slow = new EventWorker(journal, { clock: clock.now, leaseMs: 1_000 })
    const fast = new EventWorker(journal, { clock: clock.now, leaseMs: 1_000 })
    const done: string[] = []
    let release!: () => void
    let failSlow = false
    const slowStarted = new Promise<void>((started) => {
      slow.on('job', async () => {
        started()
        await new Promise<void>((resolve) => { release = resolve })
        if (failSlow) throw new Error('slow worker blew up')
        done.push('slow')
      })
    })
    fast.on('job', () => { done.push('fast') })

    const slowRun = slow.runBatch()
    await slowStarted
    clock.advance(1_500) // slow's lease expires while its handler is still running
    expect(await fast.runBatch()).toEqual({ processed: 1, failed: 0, stale: 0 })
    expect(await journal.get('e1')).toMatchObject({ state: 'done', fencingToken: 2 })

    failSlow = true
    release()
    // slow's fail() is fenced off: the event stays done and is not retried.
    expect(await slowRun).toEqual({ processed: 0, failed: 0, stale: 1 })
    expect(await journal.get('e1')).toMatchObject({ state: 'done', attempts: 2 })
    expect((await journal.get('e1'))!.lastError).toBeUndefined()
    expect(done).toEqual(['fast'])
  })

  it('a late successful ack after a re-claim is reported as stale and does not complete the event', async () => {
    const clock = manualClock()
    const journal = new MemoryEventJournal()
    await journal.append(createEnvelope({ eventId: 'e1', eventType: 'job', context, payload: 'p', occurredAt: 0 }))
    const a = new EventWorker(journal, { clock: clock.now, leaseMs: 1_000 })
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      a.on('job', async () => {
        resolve()
        await new Promise<void>((r) => { release = r })
      })
    })
    const run = a.runBatch()
    await started
    clock.advance(1_001)
    const [b] = await journal.claim(1, { now: clock.now(), leaseMs: 1_000 }) // a second worker holds it now
    release()
    expect(await run).toEqual({ processed: 0, failed: 0, stale: 1 })
    expect(await journal.get('e1')).toMatchObject({ state: 'processing', fencingToken: b!.fencingToken })
  })

  it('skips records whose lease already expired before their handler starts', async () => {
    const clock = manualClock()
    const journal = new MemoryEventJournal()
    for (const id of ['e1', 'e2']) {
      await journal.append(createEnvelope({ eventId: id, eventType: 'job', context, payload: id, occurredAt: 0 }))
    }
    const worker = new EventWorker(journal, { clock: clock.now, leaseMs: 1_000 })
    const seen: unknown[] = []
    worker.on('job', (e) => {
      seen.push(e.payload)
      clock.advance(2_000) // the batch's remaining leases expire during this handler
    })
    expect(await worker.runBatch()).toEqual({ processed: 1, failed: 0, stale: 1 })
    expect(seen).toEqual(['e1'])
    // e2 was never run here; it is claimable again by anyone.
    expect(await journal.claim(5, { now: clock.now() })).toMatchObject([{ envelope: { eventId: 'e2' } }])
  })
})
