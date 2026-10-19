/**
 * Shared LeaseProvider conformance suite (fenced, expiring leases).
 *
 * Run against every LeaseProvider (the core's MemoryLeaseProvider, which is the
 * reference, and RedisLeaseProvider). It is the contract the multi-replica Coordinator
 * must keep when it unifies with `LeaseProvider`. Leases expire on the wall clock, so
 * the expiry tests use short real TTLs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { LeaseProvider } from '@bot-wa/core'

export interface LeaseHarness {
  make(): Promise<{ lease: LeaseProvider; teardown: () => Promise<void> }>
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function runLeaseConformance(name: string, h: LeaseHarness): void {
  describe(`LeaseProvider conformance: ${name}`, () => {
    let lease: LeaseProvider
    let teardown: () => Promise<void>

    beforeEach(async () => {
      const made = await h.make()
      lease = made.lease
      teardown = made.teardown
    })
    afterEach(async () => { await teardown() })

    it('grants a free key and refuses it to another owner while live', async () => {
      const a = await lease.acquire('k', 'a', 10_000)
      expect(a?.token).toBeGreaterThan(0)
      expect(await lease.acquire('k', 'b', 10_000)).toBeNull()
    })

    it('re-acquiring by the holder extends it with the same token', async () => {
      const a = await lease.acquire('k', 'a', 10_000)
      const again = await lease.acquire('k', 'a', 10_000)
      expect(again?.token).toBe(a?.token)
    })

    it('renews only for the holder with its token', async () => {
      const a = await lease.acquire('k', 'a', 10_000)
      expect(await lease.renew('k', 'a', a!.token, 10_000)).toBe(true)
      expect(await lease.renew('k', 'b', a!.token, 10_000)).toBe(false)
      expect(await lease.renew('k', 'a', a!.token + 1, 10_000)).toBe(false)
      expect(await lease.renew('missing', 'a', 1, 10_000)).toBe(false)
    })

    it('release frees the key; the next grant has a larger token', async () => {
      const a = await lease.acquire('k', 'a', 10_000)
      await lease.release('k', 'b', a!.token)          // not the holder: no-op
      expect(await lease.acquire('k', 'b', 10_000)).toBeNull()
      await lease.release('k', 'a', a!.token)
      const b = await lease.acquire('k', 'b', 10_000)
      expect(b?.token).toBeGreaterThan(a!.token)
      expect(await lease.renew('k', 'a', a!.token, 10_000)).toBe(false)
    })

    it('expires: another owner gets a larger token and the old holder cannot renew', async () => {
      const a = await lease.acquire('k', 'a', 60)
      await wait(120)
      const b = await lease.acquire('k', 'b', 10_000)
      expect(b?.token).toBeGreaterThan(a!.token)
      expect(await lease.renew('k', 'a', a!.token, 10_000)).toBe(false)
    })

    it('keys are independent', async () => {
      expect(await lease.acquire('k1', 'a', 10_000)).not.toBeNull()
      expect(await lease.acquire('k2', 'b', 10_000)).not.toBeNull()
    })

    it('gives exactly one of 10 concurrent acquirers the lease', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => lease.acquire('race', `o${i}`, 10_000)))
      expect(results.filter((r) => r !== null)).toHaveLength(1)
    })
  })
}
