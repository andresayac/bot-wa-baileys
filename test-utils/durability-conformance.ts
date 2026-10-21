/**
 * Shared conformance suites for durability backends (`BotConfig.durability`).
 *
 *  - {@link runDurableKvConformance}: the storage seam (`DurableKv`) — versioned
 *    compare-and-set and the two sorted indexes. Every KV-backed backend
 *    (memory, file, postgres, redis) must pass it.
 *  - {@link runDurabilityConformance}: the inbox/outbox journal contract — idempotent
 *    append/put, claim ordering, leases + fencing, release/backoff/dead transitions,
 *    ambiguous sends, operator replay/retry, purge, and concurrent claimers.
 *
 * Type-only imports keep this file runtime-dependency-free (vitest is injected by the runner).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DurabilityBackend, DurableKv, InboxAppend } from '@botmesh/core'

export interface DurableKvHarness {
  make(): Promise<{ kv: DurableKv; teardown: () => Promise<void> }>
}

export interface DurabilityHarness {
  /** A fresh, started backend (isolated from every other test) and its teardown. */
  make(): Promise<{ backend: DurabilityBackend; teardown: () => Promise<void> }>
}

const idx = (due: number | null, done: number | null = null) => ({ due, done })

export function runDurableKvConformance(name: string, harness: DurableKvHarness): void {
  describe(`${name} — DurableKv conformance`, () => {
    let kv: DurableKv
    let teardown: () => Promise<void>
    beforeEach(async () => { ({ kv, teardown } = await harness.make()) })
    afterEach(async () => { await teardown() })

    it('insert writes only when absent', async () => {
      const v1 = await kv.insert('inbox', 'a', '{"n":1}', idx(10))
      expect(typeof v1).toBe('string')
      expect(await kv.insert('inbox', 'a', '{"n":2}', idx(10))).toBeUndefined()
      expect(await kv.get('inbox', 'a')).toEqual({ value: '{"n":1}', version: v1 })
      expect(await kv.get('outbox', 'a')).toBeUndefined() // tables are separate
    })

    it('any table name is a separate table (scoped journals)', async () => {
      await kv.insert('inbox', 'a', '"plain"', idx(1))
      await kv.insert('inbox:s1', 'a', '"s1"', idx(2))
      await kv.insert('inbox:s2', 'b', '"s2"', idx(3))
      expect((await kv.get('inbox:s1', 'a'))?.value).toBe('"s1"')
      expect(await kv.get('inbox:s2', 'a')).toBeUndefined()
      expect(await kv.range('inbox:s1', 'due', Number.POSITIVE_INFINITY, 10)).toEqual(['a'])
      expect(await kv.range('inbox:s2', 'due', Number.POSITIVE_INFINITY, 10)).toEqual(['b'])
      expect(await kv.range('inbox', 'due', Number.POSITIVE_INFINITY, 10)).toEqual(['a'])
    })

    it('replace is a compare-and-set on the version', async () => {
      const v1 = (await kv.insert('outbox', 'k', '"one"', idx(1)))!
      const v2 = await kv.replace('outbox', 'k', v1, '"two"', idx(2))
      expect(v2).toBeDefined()
      expect(v2).not.toBe(v1)
      expect(await kv.replace('outbox', 'k', v1, '"stale"', idx(3))).toBeUndefined()
      expect((await kv.get('outbox', 'k'))?.value).toBe('"two"')
      expect(await kv.replace('outbox', 'missing', '1', '"x"', idx(1))).toBeUndefined()
    })

    it('concurrent replaces on one version: exactly one wins', async () => {
      const v1 = (await kv.insert('inbox', 'r', '0', idx(1)))!
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => kv.replace('inbox', 'r', v1, String(i + 1), idx(1))))
      expect(results.filter((r) => r !== undefined)).toHaveLength(1)
    })

    it('remove is conditional on the version', async () => {
      const v1 = (await kv.insert('inbox', 'd', '1', idx(1)))!
      const v2 = (await kv.replace('inbox', 'd', v1, '2', idx(1)))!
      expect(await kv.remove('inbox', 'd', v1)).toBe(false)
      expect(await kv.remove('inbox', 'd', v2)).toBe(true)
      expect(await kv.get('inbox', 'd')).toBeUndefined()
      expect(await kv.range('inbox', 'due', Number.POSITIVE_INFINITY, 10)).not.toContain('d')
    })

    it('range: ids with score <= max, ascending, limited; indexes follow replaces', async () => {
      await kv.insert('inbox', 'c', '0', idx(30))
      await kv.insert('inbox', 'a', '0', idx(10))
      const vb = (await kv.insert('inbox', 'b', '0', idx(20)))!
      await kv.insert('inbox', 'x', '0', idx(null, 5))
      expect(await kv.range('inbox', 'due', 25, 10)).toEqual(['a', 'b'])
      expect(await kv.range('inbox', 'due', Number.POSITIVE_INFINITY, 2)).toEqual(['a', 'b'])
      expect(await kv.range('inbox', 'done', 100, 10)).toEqual(['x'])
      await kv.replace('inbox', 'b', vb, '1', idx(null, 7))
      expect(await kv.range('inbox', 'due', 100, 10)).toEqual(['a', 'c'])
      expect(await kv.range('inbox', 'done', 100, 10)).toEqual(['x', 'b'])
    })
  })
}

const T0 = 1_000_000
const LEASE = { owner: 'w1', leaseMs: 1_000 }

function msg(id: string, partitionKey = 'p1', receivedAt = T0): InboxAppend {
  return { id, partitionKey, kind: 'message', payload: { body: id }, receivedAt }
}

export function runDurabilityConformance(name: string, harness: DurabilityHarness): void {
  describe(`${name} — inbox conformance`, () => {
    let backend: DurabilityBackend
    let teardown: () => Promise<void>
    beforeEach(async () => { ({ backend, teardown } = await harness.make()) })
    afterEach(async () => { await teardown() })

    it('append is idempotent by id', async () => {
      const a = await backend.inbox.append({ ...msg('e1'), idempotencyKey: 'm:1' }, T0)
      expect(a.status).toBe('appended')
      expect(a.record).toMatchObject({ id: 'e1', state: 'pending', attempts: 0, fencingToken: 0, nextAttemptAt: T0, idempotencyKey: 'm:1' })
      const b = await backend.inbox.append({ ...msg('e1'), payload: { body: 'other' } }, T0 + 5)
      expect(b.status).toBe('duplicate')
      expect(b.record.payload).toEqual({ body: 'e1' })
    })

    it('append with a lease creates the record already claimed', async () => {
      const a = await backend.inbox.append(msg('e1'), T0, { ...LEASE, now: T0 })
      expect(a.record).toMatchObject({ state: 'processing', fencingToken: 1, attempts: 1, owner: 'w1', leaseUntil: T0 + 1_000 })
      expect(await backend.inbox.claimOne('e1', { owner: 'w2', leaseMs: 1_000, now: T0 + 10 })).toBeNull()
    })

    it('claim takes due records oldest first, with fresh tokens', async () => {
      await backend.inbox.append(msg('late', 'p1', T0 + 2), T0 + 2)
      await backend.inbox.append(msg('early', 'p2', T0 + 1), T0 + 1)
      await backend.inbox.append(msg('future', 'p1', T0 + 3), T0 + 10_000)
      const claimed = await backend.inbox.claim({ ...LEASE, now: T0 + 5, limit: 10 })
      expect(claimed.map((r) => r.id)).toEqual(['early', 'late'])
      for (const r of claimed) expect(r).toMatchObject({ state: 'processing', fencingToken: 1, attempts: 1, owner: 'w1', leaseUntil: T0 + 1_005 })
      expect(await backend.inbox.claim({ ...LEASE, now: T0 + 6, limit: 10 })).toEqual([])
    })

    it('claim honours limit and the partition filter', async () => {
      for (let i = 0; i < 5; i++) await backend.inbox.append(msg(`e${i}`, i % 2 ? 'odd' : 'even', T0 + i), T0)
      const evens = await backend.inbox.claim({ ...LEASE, now: T0 + 10, limit: 10, partitions: (p) => p === 'even' })
      expect(evens.map((r) => r.id)).toEqual(['e0', 'e2', 'e4'])
      const one = await backend.inbox.claim({ ...LEASE, now: T0 + 10, limit: 1 })
      expect(one.map((r) => r.id)).toEqual(['e1'])
    })

    it('an expired lease is reclaimable and fences out the old holder', async () => {
      await backend.inbox.append(msg('e1'), T0)
      const [first] = await backend.inbox.claim({ ...LEASE, now: T0, limit: 1 })
      expect(await backend.inbox.claim({ owner: 'w2', leaseMs: 1_000, now: T0 + 500, limit: 1 })).toEqual([])
      const [second] = await backend.inbox.claim({ owner: 'w2', leaseMs: 1_000, now: T0 + 1_000, limit: 1 })
      expect(second).toMatchObject({ owner: 'w2', fencingToken: first.fencingToken + 1, attempts: 2 })
      await expect(backend.inbox.ack('e1', first.fencingToken, T0 + 1_001)).rejects.toMatchObject({ name: 'StaleLeaseError' })
      await expect(backend.inbox.fail('e1', first.fencingToken, 'x', { now: T0 + 1_001 })).rejects.toMatchObject({ name: 'StaleLeaseError' })
      await expect(backend.inbox.extend('e1', first.fencingToken, T0 + 9_999)).rejects.toMatchObject({ name: 'StaleLeaseError' })
      await backend.inbox.ack('e1', second.fencingToken, T0 + 1_002)
      expect(await backend.inbox.get('e1')).toMatchObject({ state: 'done', completedAt: T0 + 1_002 })
    })

    it('reclaimOwn takes the owner’s unexpired leases (restart of the same instance)', async () => {
      await backend.inbox.append(msg('e1'), T0, { ...LEASE, now: T0 })
      expect(await backend.inbox.claim({ owner: 'w2', leaseMs: 1_000, now: T0 + 1, limit: 5, reclaimOwn: true })).toEqual([])
      const [r] = await backend.inbox.claim({ ...LEASE, now: T0 + 1, limit: 5, reclaimOwn: true })
      expect(r).toMatchObject({ id: 'e1', fencingToken: 2 })
    })

    it('ack / fail / release / extend transitions', async () => {
      for (const id of ['a', 'f', 'd', 'r']) await backend.inbox.append(msg(id), T0)
      const claimed = Object.fromEntries((await backend.inbox.claim({ ...LEASE, now: T0, limit: 10 })).map((r) => [r.id, r]))
      await backend.inbox.extend('a', claimed.a.fencingToken, T0 + 50_000)
      expect((await backend.inbox.get('a'))?.leaseUntil).toBe(T0 + 50_000)
      await backend.inbox.ack('a', claimed.a.fencingToken, T0 + 1)
      await backend.inbox.fail('f', claimed.f.fencingToken, 'boom', { now: T0 + 1, retryAt: T0 + 100 })
      await backend.inbox.fail('d', claimed.d.fencingToken, 'poison', { now: T0 + 1, dead: true })
      await backend.inbox.release('r', claimed.r.fencingToken, T0 + 1)
      expect(await backend.inbox.get('f')).toMatchObject({ state: 'failed', lastError: 'boom', nextAttemptAt: T0 + 100, attempts: 1 })
      expect(await backend.inbox.get('d')).toMatchObject({ state: 'dead', lastError: 'poison', completedAt: T0 + 1 })
      expect(await backend.inbox.get('r')).toMatchObject({ state: 'pending', attempts: 0, nextAttemptAt: T0 + 1 })
      expect((await backend.inbox.get('f'))?.owner).toBeUndefined()
      // f is not due before retryAt; r is due at once
      expect((await backend.inbox.claim({ ...LEASE, now: T0 + 50, limit: 10 })).map((r) => r.id)).toEqual(['r'])
      expect((await backend.inbox.claim({ ...LEASE, now: T0 + 100, limit: 10 })).map((r) => r.id)).toEqual(['f'])
      await expect(backend.inbox.ack('a', claimed.a.fencingToken, T0 + 2)).rejects.toMatchObject({ name: 'StaleLeaseError' })
      await expect(backend.inbox.ack('nope', 1, T0)).rejects.toMatchObject({ name: 'StaleLeaseError' })
    })

    it('replay re-queues a dead record without ever reusing a token', async () => {
      await backend.inbox.append(msg('e1'), T0)
      const [c1] = await backend.inbox.claim({ ...LEASE, now: T0, limit: 1 })
      await backend.inbox.fail('e1', c1.fencingToken, 'x', { now: T0, dead: true })
      await backend.inbox.replay('e1', T0 + 5)
      expect(await backend.inbox.get('e1')).toMatchObject({ state: 'pending', attempts: 0, nextAttemptAt: T0 + 5 })
      const [c2] = await backend.inbox.claim({ ...LEASE, now: T0 + 5, limit: 1 })
      expect(c2.fencingToken).toBeGreaterThan(c1.fencingToken)
      await backend.inbox.replay('unknown', T0) // no-op
    })

    it('list filters by state; purge drops old done records only', async () => {
      for (const id of ['old', 'new', 'dead', 'open']) await backend.inbox.append(msg(id), T0)
      const c = Object.fromEntries((await backend.inbox.claim({ ...LEASE, now: T0, limit: 10, partitions: () => true })).map((r) => [r.id, r]))
      await backend.inbox.ack('old', c.old.fencingToken, T0 + 10)
      await backend.inbox.ack('new', c.new.fencingToken, T0 + 1_000)
      await backend.inbox.fail('dead', c.dead.fencingToken, 'x', { now: T0 + 10, dead: true })
      expect((await backend.inbox.list({ state: 'done' })).map((r) => r.id).sort()).toEqual(['new', 'old'])
      expect(await backend.inbox.list()).toHaveLength(4)
      expect(await backend.inbox.purge({ doneBefore: T0 + 500 })).toBe(1)
      expect(await backend.inbox.get('old')).toBeUndefined()
      expect(await backend.inbox.get('dead')).toBeDefined()
      expect(await backend.inbox.purge({ doneBefore: T0 + 500, includeDead: true })).toBe(1)
      expect((await backend.inbox.list()).map((r) => r.id).sort()).toEqual(['new', 'open'])
    })

    it('concurrent claimers never get the same record', async () => {
      for (let i = 0; i < 20; i++) await backend.inbox.append(msg(`e${i}`, 'p', T0 + i), T0)
      const batches = await Promise.all(Array.from({ length: 4 }, (_, w) => backend.inbox.claim({ owner: `w${w}`, leaseMs: 1_000, now: T0 + 100, limit: 20 })))
      const ids = batches.flat().map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toHaveLength(20)
      const one = await Promise.all(Array.from({ length: 5 }, (_, w) => backend.inbox.claimOne('e0', { owner: `x${w}`, leaseMs: 1_000, now: T0 + 5_000 })))
      expect(one.filter(Boolean)).toHaveLength(1)
    })
  })

  describe(`${name} — outbox conformance`, () => {
    let backend: DurabilityBackend
    let teardown: () => Promise<void>
    beforeEach(async () => { ({ backend, teardown } = await harness.make()) })
    afterEach(async () => { await teardown() })

    const put = (key: string, chatId = 'c1', createdAt = T0) => ({ key, chatId, content: { kind: 'text', text: key }, createdAt })

    it('put is idempotent by key; with a lease it is created already sending', async () => {
      const a = await backend.outbox.put({ ...put('k1'), causationId: 'e1', options: { quoted: null } }, T0)
      expect(a.status).toBe('created')
      expect(a.record).toMatchObject({ key: 'k1', state: 'pending', attempts: 0, fencingToken: 0, causationId: 'e1', options: { quoted: null } })
      expect((await backend.outbox.put({ ...put('k1'), content: 'other' }, T0)).status).toBe('exists')
      const b = await backend.outbox.put(put('k2'), T0, { ...LEASE, now: T0 })
      expect(b.record).toMatchObject({ state: 'sending', fencingToken: 1, attempts: 1, leaseUntil: T0 + 1_000 })
    })

    it('begin → markSent records the provider ref; a sent key is never begun again', async () => {
      await backend.outbox.put(put('k1'), T0)
      const r = await backend.outbox.begin('k1', { ...LEASE, now: T0 })
      expect(r).toMatchObject({ state: 'sending', fencingToken: 1, attempts: 1 })
      await backend.outbox.markSent('k1', r!.fencingToken, { ref: { id: 'wamid.1', chatId: 'c1' } }, T0 + 1)
      expect(await backend.outbox.get('k1')).toMatchObject({ state: 'sent', result: { ref: { id: 'wamid.1', chatId: 'c1' } }, sentAt: T0 + 1 })
      expect(await backend.outbox.begin('k1', { ...LEASE, now: T0 + 2 })).toBeNull()
      await expect(backend.outbox.markSent('k1', r!.fencingToken, { ref: { id: 'x', chatId: 'c1' } }, T0 + 3)).rejects.toMatchObject({ name: 'StaleLeaseError' })
      expect(await backend.outbox.begin('missing', { ...LEASE, now: T0 })).toBeNull()
    })

    it('markFailed: retry later or dead', async () => {
      await backend.outbox.put(put('k1'), T0)
      await backend.outbox.put(put('k2'), T0)
      const r1 = (await backend.outbox.begin('k1', { ...LEASE, now: T0 }))!
      const r2 = (await backend.outbox.begin('k2', { ...LEASE, now: T0 }))!
      await backend.outbox.markFailed('k1', r1.fencingToken, { name: 'RateLimitedError', message: 'slow down' }, { now: T0, retryAt: T0 + 500 })
      await backend.outbox.markFailed('k2', r2.fencingToken, { message: 'nope' }, { now: T0, dead: true })
      expect(await backend.outbox.get('k1')).toMatchObject({ state: 'failed', nextAttemptAt: T0 + 500, lastError: { name: 'RateLimitedError', message: 'slow down' } })
      expect(await backend.outbox.get('k2')).toMatchObject({ state: 'dead', completedAt: T0 })
      expect(await backend.outbox.claimDue({ ...LEASE, now: T0 + 499, limit: 10 })).toEqual([])
      const due = await backend.outbox.claimDue({ ...LEASE, now: T0 + 500, limit: 10 })
      expect(due).toHaveLength(1)
      expect(due[0]).toMatchObject({ ambiguous: false, record: { key: 'k1', state: 'sending', attempts: 2, fencingToken: 2 } })
    })

    it('claimDue: FIFO, and an expired `sending` lease comes back ambiguous', async () => {
      await backend.outbox.put(put('b', 'c1', T0 + 2), T0)
      await backend.outbox.put(put('a', 'c1', T0 + 1), T0)
      const crashed = (await backend.outbox.put(put('s', 'c2', T0), T0, { ...LEASE, now: T0 })).record
      const early = await backend.outbox.claimDue({ owner: 'w2', leaseMs: 1_000, now: T0 + 10, limit: 10 })
      expect(early.map((c) => c.record.key)).toEqual(['a', 'b'])
      const late = await backend.outbox.claimDue({ owner: 'w2', leaseMs: 1_000, now: T0 + 1_000, limit: 10 })
      expect(late).toHaveLength(1)
      expect(late[0]).toMatchObject({ ambiguous: true, record: { key: 's', fencingToken: crashed.fencingToken + 1, owner: 'w2' } })
      await backend.outbox.resolveAmbiguous('s', late[0].record.fencingToken, 'unknown', T0 + 1_001)
      expect(await backend.outbox.get('s')).toMatchObject({ state: 'unknown', completedAt: T0 + 1_001 })
      await expect(backend.outbox.markSent('s', crashed.fencingToken, { ref: { id: 'x', chatId: 'c2' } }, T0)).rejects.toMatchObject({ name: 'StaleLeaseError' })
    })

    it('resolveAmbiguous → pending re-queues the send; reclaimOwn takes own live leases', async () => {
      await backend.outbox.put(put('s'), T0, { ...LEASE, now: T0 })
      const [own] = await backend.outbox.claimDue({ ...LEASE, now: T0 + 1, limit: 5, reclaimOwn: true })
      expect(own).toMatchObject({ ambiguous: true, record: { key: 's' } })
      await backend.outbox.resolveAmbiguous('s', own.record.fencingToken, 'pending', T0 + 2)
      expect(await backend.outbox.get('s')).toMatchObject({ state: 'pending', nextAttemptAt: T0 + 2 })
    })

    it('list / retry / discard / purge', async () => {
      await backend.outbox.put(put('sent', 'c1'), T0)
      await backend.outbox.put(put('dead', 'c2'), T0)
      await backend.outbox.put(put('open', 'c2'), T0)
      const s = (await backend.outbox.begin('sent', { ...LEASE, now: T0 }))!
      await backend.outbox.markSent('sent', s.fencingToken, { ref: { id: 'm1', chatId: 'c1' } }, T0 + 10)
      const d = (await backend.outbox.begin('dead', { ...LEASE, now: T0 }))!
      await backend.outbox.markFailed('dead', d.fencingToken, { message: 'x' }, { now: T0 + 10, dead: true })
      expect((await backend.outbox.list({ chatId: 'c2' })).map((r) => r.key).sort()).toEqual(['dead', 'open'])
      expect((await backend.outbox.list({ state: 'sent' })).map((r) => r.key)).toEqual(['sent'])
      await backend.outbox.retry('dead', T0 + 20)
      expect(await backend.outbox.get('dead')).toMatchObject({ state: 'pending', nextAttemptAt: T0 + 20 })
      await backend.outbox.retry('sent', T0 + 20) // a sent record is never re-queued
      expect((await backend.outbox.get('sent'))?.state).toBe('sent')
      await backend.outbox.discard('open')
      expect(await backend.outbox.get('open')).toBeUndefined()
      expect(await backend.outbox.purge({ before: T0 + 5 })).toBe(0)
      expect(await backend.outbox.purge({ before: T0 + 11 })).toBe(1)
      expect(await backend.outbox.get('sent')).toBeUndefined()
    })

    it('concurrent claimers never get the same send', async () => {
      for (let i = 0; i < 20; i++) await backend.outbox.put(put(`k${i}`, `c${i % 3}`, T0 + i), T0)
      const batches = await Promise.all(Array.from({ length: 4 }, (_, w) => backend.outbox.claimDue({ owner: `w${w}`, leaseMs: 1_000, now: T0 + 100, limit: 20 })))
      const keys = batches.flat().map((c) => c.record.key)
      expect(new Set(keys).size).toBe(20)
      const begins = await Promise.all(Array.from({ length: 5 }, (_, w) => backend.outbox.begin('k0', { owner: `x${w}`, leaseMs: 1_000, now: T0 })))
      expect(begins.filter(Boolean)).toHaveLength(0) // all already sending
    })

    it('extend moves the lease of a `sending` record, under its current token only', async () => {
      const r = (await backend.outbox.put(put('k1'), T0, { ...LEASE, now: T0 })).record
      await backend.outbox.extend('k1', r.fencingToken, T0 + 5_000)
      expect((await backend.outbox.get('k1'))?.leaseUntil).toBe(T0 + 5_000)
      // still leased past the original expiry: not ambiguous for another claimer
      expect(await backend.outbox.claimDue({ owner: 'w2', leaseMs: 1_000, now: T0 + 2_000, limit: 10 })).toEqual([])
      await expect(backend.outbox.extend('k1', r.fencingToken + 1, T0 + 9_000)).rejects.toMatchObject({ name: 'StaleLeaseError' })
      await backend.outbox.markSent('k1', r.fencingToken, { ref: { id: 'm1', chatId: 'c1' } }, T0 + 1)
      await expect(backend.outbox.extend('k1', r.fencingToken, T0 + 9_000)).rejects.toMatchObject({ name: 'StaleLeaseError' })
    })

    it('put keeps the fingerprint', async () => {
      const a = await backend.outbox.put({ ...put('k1'), fingerprint: 'abc' }, T0)
      expect(a.record.fingerprint).toBe('abc')
      expect((await backend.outbox.get('k1'))?.fingerprint).toBe('abc')
    })
  })

  describe(`${name} — scoped views`, () => {
    let backend: DurabilityBackend
    let teardown: () => Promise<void>
    beforeEach(async () => { ({ backend, teardown } = await harness.make()) })
    afterEach(async () => { await teardown() })

    const put = (key: string, content: string) => ({ key, chatId: 'c1', content, createdAt: T0 })

    it('share the storage but never each other’s records, claims or keys', async () => {
      expect(typeof backend.scope).toBe('function')
      const a = backend.scope!('bot-a')
      const b = backend.scope!('bot-b')
      await a.inbox.append(msg('e1'), T0)
      expect((await a.outbox.put(put('reminder:1', 'a'), T0)).status).toBe('created')
      expect((await b.outbox.put(put('reminder:1', 'b'), T0)).status).toBe('created') // keys are per scope
      expect(await b.inbox.get('e1')).toBeUndefined()
      expect(await b.inbox.claim({ ...LEASE, now: T0 + 10, limit: 10, reclaimOwn: true })).toEqual([])
      expect((await b.outbox.claimDue({ ...LEASE, now: T0 + 10, limit: 10 })).map((c) => c.record.content)).toEqual(['b'])
      expect(await backend.inbox.list()).toEqual([]) // the unscoped tables are separate too
      expect(await backend.outbox.list()).toEqual([])
      // the same scope name opens the same records (another process of the same bot)
      expect(await backend.scope!('bot-a').inbox.get('e1')).toMatchObject({ id: 'e1', state: 'pending' })
      expect((await backend.scope!('bot-a').outbox.get('reminder:1'))?.content).toBe('a')
    })
  })
}
