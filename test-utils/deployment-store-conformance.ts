/**
 * Shared conformance suite for `@bot-wa/deployments`' `DeploymentStore`: commit /
 * activate / list semantics, tenant isolation, reservations (gated publishes) with
 * expiry, gate-run audit records and concurrency. `MemoryDeploymentStore` is the
 * reference; `KvDeploymentStore` must behave identically on every backend.
 *
 * Type-only imports keep this file runtime-dependency-free (vitest is injected by the runner).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeploymentStore } from '../packages/deployments/src/store.js'

export interface DeploymentStoreHarness {
  /** A fresh store using `clock` as its time source, and its teardown. */
  make(options: { clock: () => number }): Promise<{ store: DeploymentStore; teardown: () => Promise<void> }>
}

const T0 = 1_700_000_000_000

export function runDeploymentStoreConformance(name: string, harness: DeploymentStoreHarness): void {
  describe(`${name} — DeploymentStore conformance`, () => {
    let store: DeploymentStore
    let teardown: () => Promise<void>
    let now = T0
    beforeEach(async () => {
      now = T0
      ;({ store, teardown } = await harness.make({ clock: () => now }))
    })
    afterEach(async () => { await teardown() })

    const run = (version: string, ok: boolean, extra: Record<string, unknown> = {}) => ({
      tenantId: 'a', botId: 'bot', version, artifact: 'h', startedAt: now - 5, finishedAt: now, ok, ...extra,
    })

    it('commit stores immutable versions in publish order with exactly one active', async () => {
      const first = await store.commit({ tenantId: 'a', botId: 'bot', version: '1.0.0', artifact: 'h1' })
      expect(first).toEqual({ tenantId: 'a', botId: 'bot', version: '1.0.0', artifact: 'h1', createdAt: T0, active: true })
      now += 10
      await store.commit({ tenantId: 'a', botId: 'bot', version: '1.1.0', artifact: 'h2', gate: { passed: true, checkedAt: now, summary: 'ok', runId: 'r1' } })
      expect(await store.active('a', 'bot')).toMatchObject({ version: '1.1.0', gate: { passed: true, summary: 'ok', runId: 'r1' } })
      expect((await store.list('a', 'bot')).map(({ version, active, createdAt }) => ({ version, active, createdAt }))).toEqual([
        { version: '1.0.0', active: false, createdAt: T0 },
        { version: '1.1.0', active: true, createdAt: T0 + 10 },
      ])
      expect(await store.get('a', 'bot', '1.0.0')).toMatchObject({ artifact: 'h1', active: false })
      expect(await store.get('a', 'bot', '9.9.9')).toBeUndefined()
      await expect(store.commit({ tenantId: 'a', botId: 'bot', version: '1.0.0', artifact: 'other' })).rejects.toMatchObject({ name: 'DeploymentExistsError' })
      expect((await store.list('a', 'bot', { limit: 1 })).map((d) => d.version)).toEqual(['1.0.0'])
    })

    it('isolates tenants and bots', async () => {
      await store.commit({ tenantId: 'a', botId: 'bot', version: '1.0.0', artifact: 'h1' })
      await store.commit({ tenantId: 'b', botId: 'bot', version: '1.0.0', artifact: 'h2' })
      await store.commit({ tenantId: 'a', botId: 'other', version: '1.0.0', artifact: 'h3' })
      expect((await store.active('a', 'bot'))?.artifact).toBe('h1')
      expect((await store.active('b', 'bot'))?.artifact).toBe('h2')
      expect((await store.active('a', 'other'))?.artifact).toBe('h3')
      expect(await store.list('c', 'bot')).toEqual([])
      expect(await store.active('c', 'bot')).toBeUndefined()
      await expect(store.activate('b', 'bot', '2.0.0')).rejects.toMatchObject({ name: 'DeploymentNotFoundError' })
      await expect(store.activate('c', 'bot', '1.0.0')).rejects.toMatchObject({ name: 'DeploymentNotFoundError' })
    })

    it('activate rolls back to a stored version (publish order unchanged)', async () => {
      await store.commit({ tenantId: 'a', botId: 'bot', version: '1.0.0', artifact: 'h1' })
      await store.commit({ tenantId: 'a', botId: 'bot', version: '1.1.0', artifact: 'h2' })
      expect(await store.activate('a', 'bot', '1.0.0')).toMatchObject({ version: '1.0.0', active: true })
      expect((await store.list('a', 'bot')).map(({ version, active }) => ({ version, active }))).toEqual([
        { version: '1.0.0', active: true },
        { version: '1.1.0', active: false },
      ])
      expect(await store.activate('a', 'bot', '1.1.0')).toMatchObject({ version: '1.1.0', active: true })
      expect((await store.get('a', 'bot', '1.0.0'))?.active).toBe(false)
    })

    it('reservations block duplicate publishes until released, consumed or expired', async () => {
      expect(await store.reserve('a', 'bot', '2.0.0', now + 1000)).toBe(true)
      expect(await store.reserve('a', 'bot', '2.0.0', now + 1000)).toBe(false)
      await expect(store.commit({ tenantId: 'a', botId: 'bot', version: '2.0.0', artifact: 'h' })).rejects.toMatchObject({ name: 'DeploymentExistsError' })
      // Other versions, bots and tenants are unaffected.
      expect(await store.reserve('a', 'bot', '2.1.0', now + 1000)).toBe(true)
      expect(await store.reserve('b', 'bot', '2.0.0', now + 1000)).toBe(true)
      await store.commit({ tenantId: 'a', botId: 'bot', version: '0.9.0', artifact: 'h' })
      // Released: free again.
      await store.release('a', 'bot', '2.0.0')
      await store.release('a', 'bot', 'never-reserved')
      expect(await store.reserve('a', 'bot', '2.0.0', now + 1000)).toBe(true)
      // Expired: free again.
      now += 1001
      expect(await store.reserve('a', 'bot', '2.0.0', now + 1000)).toBe(true)
      // Consumed by the holder's commit: the version now exists.
      expect(await store.commit({ tenantId: 'a', botId: 'bot', version: '2.0.0', artifact: 'h', reserved: true })).toMatchObject({ version: '2.0.0', active: true })
      expect(await store.reserve('a', 'bot', '2.0.0', now + 1000)).toBe(false)
      await expect(store.commit({ tenantId: 'a', botId: 'bot', version: '2.0.0', artifact: 'h', reserved: true })).rejects.toMatchObject({ name: 'DeploymentExistsError' })
      expect((await store.list('a', 'bot')).map((d) => d.version)).toEqual(['0.9.0', '2.0.0'])
    })

    it('concurrent reservations of one version: exactly one wins', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => store.reserve('a', 'bot', '3.0.0', now + 1000)))
      expect(results.filter(Boolean)).toHaveLength(1)
      const commits = await Promise.all(Array.from({ length: 10 }, () => store.commit({ tenantId: 'a', botId: 'bot', version: '4.0.0', artifact: 'h' }).then(() => true, () => false)))
      expect(commits.filter(Boolean)).toHaveLength(1)
      expect((await store.list('a', 'bot')).map((d) => d.version)).toEqual(['4.0.0'])
    })

    it('records gate runs for passes and failures, per version and tenant, oldest first', async () => {
      const failedInput = run('1.0.0', false, { reason: 'diff', details: { results: [{ name: 'x', ok: false }] } })
      const failed = await store.recordGateRun(failedInput)
      expect(failed).toEqual({ ...failedInput, id: expect.any(String) })
      now += 1
      const passedInput = run('1.0.0', true, { summary: '1/1 passed', details: 'cut', truncated: true })
      const passed = await store.recordGateRun(passedInput)
      await store.recordGateRun(run('2.0.0', true))
      await store.recordGateRun({ ...run('1.0.0', true), tenantId: 'b' })
      expect(passed.id).not.toBe(failed.id)
      expect(await store.listGateRuns('a', 'bot', '1.0.0')).toEqual([
        { ...failedInput, id: failed.id },
        { ...passedInput, id: passed.id },
      ])
      expect((await store.listGateRuns('a', 'bot', '2.0.0')).map((r) => r.version)).toEqual(['2.0.0'])
      expect(await store.listGateRuns('a', 'bot', '3.0.0')).toEqual([])
      expect(await store.listGateRuns('c', 'bot', '1.0.0')).toEqual([])
      expect((await store.listGateRuns('a', 'bot', '1.0.0', { limit: 1 })).map((r) => r.id)).toEqual([failed.id])
      // A run can be recorded for a version that was never stored (a failed gate).
      expect(await store.get('a', 'bot', '1.0.0')).toBeUndefined()
    })

    it('returns copies that cannot mutate stored state', async () => {
      const published = await store.commit({ tenantId: 'a', botId: 'bot', version: '1.0.0', artifact: 'h1', gate: { passed: true, checkedAt: now } })
      published.active = false
      published.artifact = 'tampered'
      published.gate!.summary = 'tampered'
      ;(await store.active('a', 'bot'))!.artifact = 'tampered'
      expect(await store.active('a', 'bot')).toMatchObject({ active: true, artifact: 'h1', gate: { passed: true } })
      expect((await store.active('a', 'bot'))?.gate?.summary).toBeUndefined()
      const recorded = await store.recordGateRun(run('1.0.0', true, { details: { a: [1] } }))
      ;(recorded.details as { a: number[] }).a.push(2)
      expect((await store.listGateRuns('a', 'bot', '1.0.0'))[0]?.details).toEqual({ a: [1] })
    })

    it('rejects empty tenant, bot and version ids', async () => {
      await expect(store.commit({ tenantId: '', botId: 'bot', version: '1', artifact: 'h' })).rejects.toThrow(TypeError)
      await expect(store.commit({ tenantId: 'a', botId: '', version: '1', artifact: 'h' })).rejects.toThrow(TypeError)
      await expect(store.reserve('a', 'bot', '', 1)).rejects.toThrow(TypeError)
      await expect(store.list('a', 'bot', { limit: -1 })).rejects.toThrow(RangeError)
    })
  })
}
