/**
 * Shared ScheduleStore conformance suite.
 *
 * One set of assertions run against EVERY ScheduleStore implementation (the core's
 * MemoryScheduleStore, which is the reference, plus SQLite and Redis) so the durable
 * scheduler's contract stays uniform. Import it from a store's test and pass a factory
 * that yields a fresh, started store plus a teardown. Type-only imports keep this file
 * runtime-dependency-free (it only needs `vitest`, which the runner injects).
 *
 * Every call takes an explicit `now`, so no test depends on the wall clock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ScheduleStore } from '@bot-wa/core'

export interface ScheduleStoreHarness {
  make(): Promise<{ store: ScheduleStore; teardown: () => Promise<void> }>
}

const T0 = 1_700_000_000_000

export function runScheduleStoreConformance(name: string, h: ScheduleStoreHarness): void {
  describe(`ScheduleStore conformance: ${name}`, () => {
    let store: ScheduleStore
    let teardown: () => Promise<void>

    beforeEach(async () => {
      const made = await h.make()
      store = made.store
      teardown = made.teardown
    })
    afterEach(async () => { await teardown() })

    it('registers a new task with fencing token 0 and reads it back', async () => {
      const rec = await store.register({ id: 'daily', kind: 'cron', spec: '0 9 * * *', nextRunAt: T0 + 1000 }, T0)
      expect(rec).toMatchObject({ id: 'daily', kind: 'cron', spec: '0 9 * * *', nextRunAt: T0 + 1000, fencingToken: 0 })
      expect(rec.leaseOwner).toBeUndefined()
      expect(rec.leaseUntil).toBeUndefined()
      expect(await store.get('daily')).toMatchObject({ id: 'daily', nextRunAt: T0 + 1000, fencingToken: 0 })
      expect(await store.get('missing')).toBeNull()
    })

    it('keeps the stored nextRunAt when registered again with the same spec', async () => {
      await store.register({ id: 't', kind: 'interval', spec: '60000', nextRunAt: T0 + 60_000 }, T0)
      const again = await store.register({ id: 't', kind: 'interval', spec: '60000', nextRunAt: T0 + 999_999 }, T0 + 5000)
      expect(again.nextRunAt).toBe(T0 + 60_000)
      expect((await store.get('t'))?.nextRunAt).toBe(T0 + 60_000)
    })

    it('overwrites spec, kind and nextRunAt when the spec changes, keeping the fencing token', async () => {
      await store.register({ id: 't', kind: 'interval', spec: '60000', nextRunAt: T0 + 60_000 }, T0)
      const c = await store.claimDue('t', 'a', T0 + 60_000, 1000)
      expect(c?.fencingToken).toBe(1)
      await store.complete('t', 1, { nextRunAt: T0 + 120_000, lastRunAt: T0 + 60_000, lastStatus: 'ok' }, T0 + 60_001)
      const changed = await store.register({ id: 't', kind: 'cron', spec: '*/5 * * * *', nextRunAt: T0 + 300_000 }, T0 + 70_000)
      expect(changed).toMatchObject({ kind: 'cron', spec: '*/5 * * * *', nextRunAt: T0 + 300_000, fencingToken: 1 })
      expect(changed.lastRunAt).toBe(T0 + 60_000)
    })

    it('keeps a one-shot tombstone (nextRunAt null) across registrations and never claims it', async () => {
      await store.register({ id: 'once', kind: 'once', spec: '5000', nextRunAt: T0 }, T0)
      const c = await store.claimDue('once', 'a', T0, 1000)
      expect(await store.complete('once', c!.fencingToken, { nextRunAt: null, lastRunAt: T0, lastStatus: 'ok' }, T0)).toBe(true)
      const again = await store.register({ id: 'once', kind: 'once', spec: '5000', nextRunAt: T0 + 99_000 }, T0 + 1)
      expect(again.nextRunAt).toBeNull()
      expect(await store.claimDue('once', 'a', T0 + 10_000_000, 1000)).toBeNull()
    })

    it('claims only a due record, and only once while the lease is live', async () => {
      await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: T0 + 1000 }, T0)
      expect(await store.claimDue('t', 'a', T0 + 999, 5000)).toBeNull()
      const c = await store.claimDue('t', 'a', T0 + 1000, 5000)
      expect(c).not.toBeNull()
      expect(c!.fencingToken).toBe(1)
      expect(c!.record).toMatchObject({ id: 't', nextRunAt: T0 + 1000, leaseOwner: 'a', leaseUntil: T0 + 6000, fencingToken: 1 })
      expect(await store.claimDue('t', 'b', T0 + 2000, 5000)).toBeNull()
      expect(await store.claimDue('t', 'a', T0 + 2000, 5000)).toBeNull()
    })

    it('lets another owner claim once the lease has expired, with a larger token', async () => {
      await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const a = await store.claimDue('t', 'a', T0, 5000)
      const b = await store.claimDue('t', 'b', T0 + 5000, 5000)
      expect(b).not.toBeNull()
      expect(b!.fencingToken).toBeGreaterThan(a!.fencingToken)
      expect(b!.record.leaseOwner).toBe('b')
      // The crashed owner's late commit is rejected.
      expect(await store.complete('t', a!.fencingToken, { nextRunAt: T0 + 1000, lastRunAt: T0, lastStatus: 'ok' }, T0 + 6000)).toBe(false)
      expect(await store.renew('t', a!.fencingToken, T0 + 99_000)).toBe(false)
    })

    it('returns null when claiming an unknown id', async () => {
      expect(await store.claimDue('nope', 'a', T0, 1000)).toBeNull()
    })

    it('gives exactly one of 20 concurrent claimers the occurrence', async () => {
      await store.register({ id: 'race', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.claimDue('race', `owner-${i}`, T0 + 1, 10_000)),
      )
      const winners = results.filter((r) => r !== null)
      expect(winners).toHaveLength(1)
      expect(winners[0]!.fencingToken).toBe(1)
      expect((await store.get('race'))?.leaseOwner).toBe(winners[0]!.record.leaseOwner)
    })

    it('renews only with the current token', async () => {
      await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const c = await store.claimDue('t', 'a', T0, 1000)
      expect(await store.renew('t', c!.fencingToken + 1, T0 + 9000)).toBe(false)
      expect(await store.renew('t', c!.fencingToken, T0 + 9000)).toBe(true)
      expect((await store.get('t'))?.leaseUntil).toBe(T0 + 9000)
      // The renewed lease is honoured.
      expect(await store.claimDue('t', 'b', T0 + 5000, 1000)).toBeNull()
      expect(await store.renew('nope', 1, T0)).toBe(false)
    })

    it('completes with the current token: writes the patch, clears the lease, and only once', async () => {
      await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const c = await store.claimDue('t', 'a', T0, 5000)
      expect(await store.complete('t', c!.fencingToken + 1, { nextRunAt: T0 + 1000 }, T0 + 10)).toBe(false)
      expect(await store.complete('t', c!.fencingToken, { nextRunAt: T0 + 1000, lastRunAt: T0 + 1, lastStatus: 'error' }, T0 + 10)).toBe(true)
      const rec = await store.get('t')
      expect(rec).toMatchObject({ nextRunAt: T0 + 1000, lastRunAt: T0 + 1, lastStatus: 'error', fencingToken: 1, updatedAt: T0 + 10 })
      expect(rec?.leaseOwner).toBeUndefined()
      expect(rec?.leaseUntil).toBeUndefined()
      expect(await store.complete('t', c!.fencingToken, { nextRunAt: T0 + 5000 }, T0 + 20)).toBe(false)
      expect((await store.get('t'))?.nextRunAt).toBe(T0 + 1000)
    })

    it('keeps lastRunAt/lastStatus when a complete patch omits them', async () => {
      await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const c1 = await store.claimDue('t', 'a', T0, 5000)
      await store.complete('t', c1!.fencingToken, { nextRunAt: T0 + 1000, lastRunAt: T0, lastStatus: 'ok' }, T0)
      const c2 = await store.claimDue('t', 'a', T0 + 1000, 5000)
      expect(c2!.fencingToken).toBe(2)
      await store.complete('t', c2!.fencingToken, { nextRunAt: T0 + 2000 }, T0 + 1000)
      expect(await store.get('t')).toMatchObject({ nextRunAt: T0 + 2000, lastRunAt: T0, lastStatus: 'ok', fencingToken: 2 })
    })

    it('deletes a record: get is null, a late complete is rejected and the id can be registered again', async () => {
      await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const c = await store.claimDue('t', 'a', T0, 5000)
      await store.delete('t')
      expect(await store.get('t')).toBeNull()
      expect(await store.complete('t', c!.fencingToken, { nextRunAt: T0 + 1000 }, T0)).toBe(false)
      expect(await store.get('t')).toBeNull()
      await store.delete('t') // idempotent
      const again = await store.register({ id: 't', kind: 'interval', spec: '1000', nextRunAt: T0 + 7 }, T0)
      expect(again.nextRunAt).toBe(T0 + 7)
    })

    it('lists every record', async () => {
      await store.register({ id: 'a', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      await store.register({ id: 'b', kind: 'once', spec: '1000', nextRunAt: null }, T0)
      await store.register({ id: 'c', kind: 'cron', spec: '* * * * *', nextRunAt: T0 + 60_000 }, T0)
      const ids = (await store.list()).map((r) => r.id).sort()
      expect(ids).toEqual(['a', 'b', 'c'])
      const b = (await store.list()).find((r) => r.id === 'b')
      expect(b?.nextRunAt).toBeNull()
    })

    it('round-trips ids with separators and unicode', async () => {
      const ids = ['a:b', 'x|y|z', '50%', 'with space', 'emoji-🎉', 'tenant%7Cbot|scheduler:leader']
      for (const id of ids) await store.register({ id, kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      for (const id of ids) expect((await store.get(id))?.id).toBe(id)
      expect((await store.list()).map((r) => r.id).sort()).toEqual([...ids].sort())
      const c = await store.claimDue('a:b', 'a', T0, 1000)
      expect(c?.record.id).toBe('a:b')
      expect(await store.claimDue('x|y|z', 'a', T0, 1000)).not.toBeNull()
    })
  })
}
