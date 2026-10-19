/**
 * Shared ScheduleStore conformance suite.
 *
 * One set of assertions run against EVERY ScheduleStore implementation (the core's
 * MemoryScheduleStore, which is the reference, plus SQLite, Redis, PostgreSQL, MySQL and
 * MongoDB) so the durable
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

    it('never reuses a fencing token for an id, even after delete and a new register', async () => {
      await store.register({ id: 'f', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const c1 = await store.claimDue('f', 'a', T0, 1000)
      await store.complete('f', c1!.fencingToken, { nextRunAt: T0 + 1000 }, T0)
      const c2 = await store.claimDue('f', 'a', T0 + 1000, 1000)
      expect(c2!.fencingToken).toBe(2)
      await store.delete('f')
      const again = await store.register({ id: 'f', kind: 'interval', spec: '1000', nextRunAt: T0 + 5000 }, T0 + 2000)
      expect(again.fencingToken).toBe(2)
      // The deleted generation's late commit is still rejected (the new record holds no lease).
      expect(await store.complete('f', 2, { nextRunAt: T0 + 9000 }, T0 + 2000)).toBe(false)
      const c3 = await store.claimDue('f', 'b', T0 + 5000, 1000)
      expect(c3!.fencingToken).toBe(3)
      // A deleted id stays invisible to every other call.
      await store.delete('f')
      expect(await store.get('f')).toBeNull()
      expect((await store.list()).map((r) => r.id)).toEqual([])
      expect(await store.claimDue('f', 'a', T0 + 99_000, 1000)).toBeNull()
      expect(await store.renew('f', 3, T0 + 99_000)).toBe(false)
      expect(await store.complete('f', 3, { nextRunAt: null }, T0 + 99_000)).toBe(false)
      await store.delete('f')
      expect((await store.register({ id: 'f', kind: 'once', spec: '5', nextRunAt: T0 }, T0)).fencingToken).toBe(3)
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

    it('gives 20 concurrent registrations of a new id the same record, with token 0', async () => {
      const recs = await Promise.all(
        Array.from({ length: 20 }, () => store.register({ id: 'new', kind: 'interval', spec: '1000', nextRunAt: T0 + 1000 }, T0)),
      )
      for (const r of recs) expect(r).toMatchObject({ id: 'new', kind: 'interval', spec: '1000', nextRunAt: T0 + 1000, fencingToken: 0 })
      expect((await store.list()).map((r) => r.id)).toEqual(['new'])
    })

    it('starts a fresh record when an id is registered again after delete (the token is kept)', async () => {
      await store.register({ id: 'r', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const c1 = await store.claimDue('r', 'a', T0, 5000)
      await store.complete('r', c1!.fencingToken, { nextRunAt: T0 + 1000, lastRunAt: T0, lastStatus: 'error' }, T0)
      await store.claimDue('r', 'a', T0 + 1000, 5000) // leased when deleted
      await store.delete('r')
      const again = await store.register({ id: 'r', kind: 'interval', spec: '1000', nextRunAt: T0 + 9000 }, T0 + 2000)
      expect(again).toMatchObject({ id: 'r', kind: 'interval', spec: '1000', nextRunAt: T0 + 9000, fencingToken: 2 })
      expect(again.lastRunAt).toBeUndefined()
      expect(again.lastStatus).toBeUndefined()
      expect(again.leaseOwner).toBeUndefined()
      expect(again.leaseUntil).toBeUndefined()
      const stored = await store.get('r')
      expect(stored?.lastRunAt).toBeUndefined()
      expect(stored?.leaseOwner).toBeUndefined()
      // Free to claim at once (no lease carried over).
      expect((await store.claimDue('r', 'b', T0 + 9000, 1000))?.fencingToken).toBe(3)
    })

    it('keeps the lease and the token when the spec changes while leased', async () => {
      await store.register({ id: 'l', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const c = await store.claimDue('l', 'a', T0, 5000)
      const changed = await store.register({ id: 'l', kind: 'interval', spec: '2000', nextRunAt: T0 + 2000 }, T0 + 10)
      expect(changed).toMatchObject({ spec: '2000', nextRunAt: T0 + 2000, fencingToken: 1, leaseOwner: 'a', leaseUntil: T0 + 5000 })
      expect(await store.complete('l', c!.fencingToken, { nextRunAt: T0 + 4000 }, T0 + 20)).toBe(true)
    })

    it('treats nextRunAt === now and leaseUntil === now as claimable', async () => {
      await store.register({ id: 'b', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      expect(await store.claimDue('b', 'a', T0, 1000)).not.toBeNull()
      const next = await store.claimDue('b', 'b', T0 + 1000, 1000)
      expect(next?.fencingToken).toBe(2)
      expect(next?.record.leaseOwner).toBe('b')
    })

    it('renews with the identical leaseUntil (a no-op write still succeeds)', async () => {
      await store.register({ id: 'n', kind: 'interval', spec: '1000', nextRunAt: T0 }, T0)
      const c = await store.claimDue('n', 'a', T0, 5000)
      expect(await store.renew('n', c!.fencingToken, T0 + 5000)).toBe(true)
      expect(await store.renew('n', c!.fencingToken, T0 + 5000)).toBe(true)
    })

    it('returns numbers for large epochs (year 2100)', async () => {
      const Y2100 = 4_102_444_800_000
      await store.register({ id: 'big', kind: 'interval', spec: '1000', nextRunAt: Y2100 }, Y2100 - 1)
      const c = await store.claimDue('big', 'a', Y2100, 60_000)
      expect(c?.record.leaseUntil).toBe(Y2100 + 60_000)
      await store.complete('big', c!.fencingToken, { nextRunAt: Y2100 + 1000, lastRunAt: Y2100 + 1, lastStatus: 'ok' }, Y2100 + 2)
      const rec = (await store.get('big'))!
      for (const v of [rec.nextRunAt, rec.lastRunAt, rec.fencingToken, rec.updatedAt]) expect(typeof v).toBe('number')
      expect(rec).toMatchObject({ nextRunAt: Y2100 + 1000, lastRunAt: Y2100 + 1, updatedAt: Y2100 + 2, fencingToken: 1 })
      const listed = (await store.list()).find((r) => r.id === 'big')!
      expect(typeof listed.nextRunAt).toBe('number')
      expect(typeof listed.fencingToken).toBe('number')
    })

    it('keeps ids that differ only by case or a trailing space apart', async () => {
      const ids = ['Task', 'task', 'task ', ' task']
      for (const [i, id] of ids.entries()) await store.register({ id, kind: 'interval', spec: String(1000 + i), nextRunAt: T0 + i }, T0)
      for (const [i, id] of ids.entries()) expect(await store.get(id)).toMatchObject({ id, spec: String(1000 + i), nextRunAt: T0 + i })
      expect((await store.list()).map((r) => r.id).sort()).toEqual([...ids].sort())
      expect((await store.claimDue('task ', 'a', T0 + 10, 1000))?.record.id).toBe('task ')
      expect((await store.get('task'))?.leaseOwner).toBeUndefined()
    })

    it('round-trips a 500-byte id and a long time-zone spec', async () => {
      const id = 'x'.repeat(250) + 'é'.repeat(125) // 250 + 250 bytes
      const spec = `TZ=America/New_York ${'0,1,2,3,4,5,6,7,8,9,'.repeat(14)}10 9 * * *`
      expect(new TextEncoder().encode(id).length).toBe(500)
      expect(spec.length).toBeGreaterThan(300)
      await store.register({ id, kind: 'cron', spec, nextRunAt: T0 }, T0)
      expect(await store.get(id)).toMatchObject({ id, kind: 'cron', spec })
      // Same spec: kept as is.
      const again = await store.register({ id, kind: 'cron', spec, nextRunAt: T0 + 99 }, T0 + 1)
      expect(again.nextRunAt).toBe(T0)
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
