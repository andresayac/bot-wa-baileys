/**
 * The leased-journal operations (`LeasedEventJournal`) the durability adapter builds on:
 * channel isolation, owner-aware claims, single-record claims, lease extension, explicit
 * fail/release outcomes and purge. Legacy calls (no channel, no owner) behave as before.
 */
import { describe, expect, it } from 'vitest'
import {
  EventNotFoundError, EventWorker, MemoryEventJournal, StaleLeaseError, createEnvelope,
  type EventEnvelope,
} from '../src/index.js'

const context = { tenantId: 't', environmentId: 'e', botId: 'b', providerId: 'p', connectionId: 'c' }
const T0 = 1_000_000
const env = (id: string, occurredAt = T0, partitionKey = 'p1'): EventEnvelope<{ id: string }> =>
  createEnvelope({ eventId: id, eventType: 'test.event', occurredAt, context, partitionKey, payload: { id } })
const lease = (owner = 'w1', now = T0, leaseMs = 1_000) => ({ owner, now, leaseMs })

describe('LeasedEventJournal (memory)', () => {
  it('appendRecord: insert-if-absent, due at `now`, optionally already claimed', async () => {
    const j = new MemoryEventJournal()
    const a = await j.appendRecord(env('a'), { now: T0 + 50, channel: 'bot' })
    expect(a).toMatchObject({ status: 'appended', record: { state: 'pending', attempts: 0, nextAttemptAt: T0 + 50, channel: 'bot' } })
    const dup = await j.appendRecord({ ...env('a'), payload: { id: 'other' } })
    expect(dup.status).toBe('duplicate')
    expect(dup.record.envelope.payload).toEqual({ id: 'a' })
    const b = await j.appendRecord(env('b'), { channel: 'bot', lease: lease() })
    expect(b.record).toMatchObject({ state: 'processing', attempts: 1, fencingToken: 1, owner: 'w1', leaseUntil: T0 + 1_000 })
    expect(await j.claimOne('b', lease('w2', T0 + 10))).toBeNull()
    expect(await j.append(env('a'))).toBe(false) // legacy append agrees
  })

  it('claims are isolated by channel: an EventWorker never runs channelled records', async () => {
    const j = new MemoryEventJournal()
    await j.append(env('user-1'))
    await j.appendRecord(env('bot-1'), { channel: 'botwa:durable' })
    const seen: string[] = []
    const worker = new EventWorker(j, { clock: () => T0 + 10 })
    worker.on('test.event', (e) => { seen.push(e.eventId) })
    expect(await worker.runBatch()).toEqual({ processed: 1, failed: 0, stale: 0 })
    expect(seen).toEqual(['user-1'])
    expect((await j.get('bot-1'))?.state).toBe('pending')
    const bot = await j.claim(10, { now: T0 + 10, channel: 'botwa:durable', owner: 'bot' })
    expect(bot.map((r) => r.envelope.eventId)).toEqual(['bot-1'])
    expect((await j.list()).map((r) => r.envelope.eventId).sort()).toEqual(['bot-1', 'user-1']) // operators see both
    expect((await j.list({ channel: 'botwa:durable' })).map((r) => r.envelope.eventId)).toEqual(['bot-1'])
  })

  it('order occurredAt + filter + owner; reclaimOwn takes the owner\'s live leases', async () => {
    const j = new MemoryEventJournal()
    await j.appendRecord(env('late', T0 + 2, 'a'), { channel: 'c', now: T0 })
    await j.appendRecord(env('early', T0 + 1, 'z'), { channel: 'c', now: T0 })
    await j.appendRecord(env('skip', T0, 'm'), { channel: 'c', now: T0 })
    const claimed = await j.claim(10, { now: T0 + 5, channel: 'c', order: 'occurredAt', owner: 'w1', filter: (r) => r.envelope.eventId !== 'skip' })
    expect(claimed.map((r) => r.envelope.eventId)).toEqual(['early', 'late'])
    expect(claimed[0]).toMatchObject({ owner: 'w1', fencingToken: 1 })
    expect(await j.claim(10, { now: T0 + 6, channel: 'c', owner: 'w2', reclaimOwn: true, filter: (r) => r.envelope.eventId !== 'skip' })).toEqual([])
    const again = await j.claim(10, { now: T0 + 6, channel: 'c', owner: 'w1', reclaimOwn: true, filter: (r) => r.envelope.eventId !== 'skip' })
    expect(again.map((r) => r.fencingToken)).toEqual([2, 2])
  })

  it('extend / explicit fail / release toPending, all fenced', async () => {
    const j = new MemoryEventJournal()
    for (const id of ['x', 'f', 'd', 'r']) await j.appendRecord(env(id), { channel: 'c', now: T0 })
    const c = Object.fromEntries((await j.claim(10, { now: T0, channel: 'c', owner: 'w' })).map((r) => [r.envelope.eventId, r]))
    await j.extend('x', { fencingToken: c.x.fencingToken!, leaseUntil: T0 + 9_000 })
    expect((await j.get('x'))?.leaseUntil).toBe(T0 + 9_000)
    await expect(j.extend('x', { fencingToken: 99, leaseUntil: 1 })).rejects.toBeInstanceOf(StaleLeaseError)
    await j.fail('f', 'boom', { fencingToken: c.f.fencingToken, now: T0 + 1, retryAt: T0 + 100 })
    await j.fail('d', 'poison', { fencingToken: c.d.fencingToken, now: T0 + 1, dead: true })
    await j.fail('r', 'once', { fencingToken: c.r.fencingToken, now: T0 + 1, dead: false, retryAt: T0 + 1 })
    const [r2] = await j.claim(1, { now: T0 + 2, channel: 'c', owner: 'w', filter: (r) => r.envelope.eventId === 'r' })
    await j.release('r', { fencingToken: r2.fencingToken, now: T0 + 3, toPending: true })
    expect(await j.get('f')).toMatchObject({ state: 'failed', lastError: 'boom', nextAttemptAt: T0 + 100, attempts: 1 })
    expect(await j.get('d')).toMatchObject({ state: 'dead', lastError: 'poison', completedAt: T0 + 1 })
    expect(await j.get('r')).toMatchObject({ state: 'pending', nextAttemptAt: T0 + 3, attempts: 1 })
    expect((await j.get('f'))?.owner).toBeUndefined()
    await expect(j.ack('nope', { fencingToken: 1 })).rejects.toBeInstanceOf(EventNotFoundError)
    await expect(j.replay('nope')).rejects.toThrow(/does not exist/)
  })

  it('purge drops old terminal records of its channel only', async () => {
    const j = new MemoryEventJournal()
    for (const id of ['old', 'new', 'dead', 'open']) await j.appendRecord(env(id), { channel: 'c', now: T0 })
    await j.append(env('user'))
    const c = Object.fromEntries((await j.claim(10, { now: T0, channel: 'c' })).map((r) => [r.envelope.eventId, r]))
    await j.ack('old', { fencingToken: c.old.fencingToken, now: T0 + 10 })
    await j.ack('new', { fencingToken: c.new.fencingToken, now: T0 + 1_000 })
    await j.fail('dead', 'x', { fencingToken: c.dead.fencingToken, now: T0 + 10, dead: true })
    const [u] = await j.claim(1, { now: T0 })
    await j.ack('user', { fencingToken: u.fencingToken, now: T0 + 1 })
    expect(await j.purge({ doneBefore: T0 + 500, channel: 'c' })).toBe(1)
    expect(await j.purge({ doneBefore: T0 + 500, channel: 'c', includeDead: true })).toBe(1)
    expect((await j.list()).map((r) => r.envelope.eventId).sort()).toEqual(['new', 'open', 'user'])
    expect(await j.appendRecord(env('old'), { channel: 'c' })).toMatchObject({ status: 'appended' }) // its idempotency key is free again
  })
})
