/**
 * IProvider signature parity. `implements IProvider` alone does not catch a
 * concrete method that declares FEWER parameters than the interface (TS allows
 * it), so `provider.acknowledgeInteraction(id, opts)` on the concrete class
 * would not compile. The type-level checks run under `pnpm typecheck`; the
 * runtime calls use the interface-shaped arguments on the concrete class.
 * Hermetic: `fetch` is stubbed.
 */

import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest'
import type { IProvider, MessageRef } from '@bot-wa/core'
import { InstagramProvider } from '../src/InstagramProvider.js'

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

/** Keys of IProvider whose (non-nullable) type is a function. */
type IProviderMethod = {
  [K in keyof IProvider]-?: NonNullable<IProvider[K]> extends (...args: never[]) => unknown ? K : never
}[keyof IProvider]

/** IProvider methods the class declares with a parameter list that differs from the interface. */
type DivergentMethods<C> = {
  [K in IProviderMethod & keyof C]-?: C[K] extends (...args: infer P) => unknown
    ? Equals<P, Parameters<NonNullable<IProvider[K]>>> extends true ? never : K
    : K
}[IProviderMethod & keyof C]

interface Call { url: string; init?: RequestInit }

function mockFetch(): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ recipient_id: 'IGSID_1' }) }
  }))
  return calls
}

const cfg = { accessToken: 'TOK', verifyToken: 'vt', allowUnsignedWebhooks: true }
const ref: MessageRef = { id: 'mid.1', chatId: 'IGSID_1' }

afterEach(() => vi.unstubAllGlobals())

describe('InstagramProvider — IProvider signature parity', () => {
  it('is assignable to IProvider', () => {
    expectTypeOf<InstagramProvider>().toExtend<IProvider>()
  })

  it('declares every IProvider method with exactly the interface parameters', () => {
    expectTypeOf<DivergentMethods<InstagramProvider>>().toEqualTypeOf<never>()
  })

  it('accepts interface-shaped arguments on the concrete class', async () => {
    const calls = mockFetch()
    const p = new InstagramProvider(cfg)

    await p.markRead([ref])
    await p.typing('IGSID_1', 'typing')
    expect(calls).toHaveLength(2)

    await expect(p.acknowledgeInteraction('i-1', { text: 'ok', defer: true })).resolves.toBeUndefined()
    expect(calls).toHaveLength(2) // ack is a no-op: no request
  })
})
