/**
 * IProvider signature parity. `implements IProvider` alone does not catch a
 * concrete method that declares FEWER parameters than the interface (TS allows
 * it), so `provider.markRead([ref])` on the concrete class would not compile.
 * The type-level checks run under `pnpm typecheck`; the runtime calls use the
 * interface-shaped arguments on the concrete class. Hermetic: `fetch` is stubbed.
 */

import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest'
import type { IProvider, MessageRef } from '@bot-wa/core'
import { DiscordProvider } from '../src/DiscordProvider.js'
import { fakeSocketFactory } from './_fakeSocket.js'

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
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'M1' }) }
  }))
  return calls
}

function provider(): DiscordProvider {
  return new DiscordProvider({ token: 'TOK', socketFactory: fakeSocketFactory().factory, reconnectDelayMs: 0 })
}

const ref: MessageRef = { id: 'M1', chatId: 'C1' }

afterEach(() => vi.unstubAllGlobals())

describe('DiscordProvider — IProvider signature parity', () => {
  it('is assignable to IProvider', () => {
    expectTypeOf<DiscordProvider>().toExtend<IProvider>()
  })

  it('declares every IProvider method with exactly the interface parameters', () => {
    expectTypeOf<DivergentMethods<DiscordProvider>>().toEqualTypeOf<never>()
  })

  it('accepts interface-shaped arguments on the concrete class', async () => {
    const calls = mockFetch()
    const p = provider()

    await p.markRead([ref])
    expect(calls).toHaveLength(0) // no read-receipt primitive on Discord

    await p.typing('C1', 'typing')
    await p.typing('C1', 'recording')
    expect(calls.map((c) => c.url)).toEqual([
      'https://discord.com/api/v10/channels/C1/typing',
      'https://discord.com/api/v10/channels/C1/typing',
    ])

    await p.deleteMessage(ref)
    await p.editMessage(ref, { kind: 'text', text: 'edited' })
    await p.acknowledgeInteraction('IID:TT', { text: 'ok', defer: true })
    expect(JSON.parse(calls.at(-1)!.init!.body as string)).toEqual({ type: 6 })
  })

  it("typing 'paused' is a no-op (Discord has no stop-typing primitive)", async () => {
    const calls = mockFetch()
    await provider().typing('C1', 'paused')
    expect(calls).toHaveLength(0)
  })
})
