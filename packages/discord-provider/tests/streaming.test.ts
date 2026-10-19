/**
 * Discord streaming: `capabilities.streaming === 'edit'` — ctx.stream() sends once
 * and then PATCHes the same message. Hermetic (fetch stubbed, fake socket).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { streamText } from '@bot-wa/core'
import { DiscordProvider } from '../src/DiscordProvider.js'
import { fakeSocketFactory } from './_fakeSocket.js'

interface Call { url: string; method: string; body: Record<string, unknown> }

function mockFetch(): Call[] {
  const calls: Call[] = []
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body })
    const result = method === 'POST' ? { id: `M${++n}`, channel_id: 'C1' } : { id: 'M1', channel_id: 'C1' }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => result, arrayBuffer: async () => new ArrayBuffer(0) }
  }))
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('DiscordProvider streaming', () => {
  it("declares streaming: 'edit' with the 2000-char limit", () => {
    const p = new DiscordProvider({ token: 'TOK', socketFactory: fakeSocketFactory().factory } as never)
    expect(p.capabilities.streaming).toBe('edit')
    expect(p.capabilities.maxTextLength).toBe(2000)
    expect(p.capabilities.exclusiveSession).toBe(true)   // one gateway connection: one replica connects
  })

  it('streamText → one POST, then PATCH edits of that message, final text intact; long text split ≤ 2000', async () => {
    const calls = mockFetch()
    const p = new DiscordProvider({ token: 'TOK', socketFactory: fakeSocketFactory().factory } as never)
    const long = 'palabra '.repeat(400) // 3200 chars → must be split
    async function* src() {
      for (let i = 0; i < long.length; i += 400) { await new Promise((r) => setTimeout(r, 2)); yield long.slice(i, i + 400) }
    }
    const res = await streamText({
      capabilities: p.capabilities,
      isPrivate: false,
      send: async (c) => { const r = await p.send('C1', c); return { ...r, id: r.ref.id, chatId: r.ref.chatId } },
      edit: (ref, c) => p.editMessage(ref, c),
    }, src(), { throttleMs: 0 })
    expect(res.strategy).toBe('edit')
    const posts = calls.filter((c) => c.method === 'POST')
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(posts.length).toBe(2)
    expect(patches.length).toBeGreaterThan(0)
    for (const c of [...posts, ...patches]) expect(String(c.body.content).length).toBeLessThanOrEqual(2000)
    expect(res.messages.map((m) => m.id)).toEqual(['M1', 'M2'])
  })
})
