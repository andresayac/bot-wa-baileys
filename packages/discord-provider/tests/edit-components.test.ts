/**
 * Editing a message: Discord's PATCH keeps every field it is not sent, so an edit
 * into content without buttons must clear the old components explicitly
 * (`components: []`), or the stale buttons stay visible. Hermetic (fetch stubbed).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { MessageRef } from '@bot-wa/core'
import { DiscordProvider } from '../src/DiscordProvider.js'
import { fakeSocketFactory } from './_fakeSocket.js'

interface Call { url: string; method?: string; body: Record<string, unknown> }

function mockFetch(): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {} })
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'M1' }) }
  }))
  return calls
}

const provider = () => new DiscordProvider({ token: 'TOK', socketFactory: fakeSocketFactory().factory, reconnectDelayMs: 0 })
const ref: MessageRef = { id: 'M1', chatId: 'C1' }

afterEach(() => vi.unstubAllGlobals())

describe('DiscordProvider.editMessage — components', () => {
  it('editing into plain text removes the old buttons (components: [])', async () => {
    const calls = mockFetch()
    await provider().editMessage(ref, { kind: 'text', text: 'Confirm? → Yes' })
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toBe('https://discord.com/api/v10/channels/C1/messages/M1')
    expect(patch.body).toEqual({ content: 'Confirm? → Yes', components: [] })
  })

  it('editing into new buttons sends those buttons', async () => {
    const calls = mockFetch()
    await provider().editMessage(ref, { kind: 'buttons', text: 'Pick', buttons: [{ id: 'a', title: 'A' }] })
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body.components).toEqual([{ type: 1, components: [{ type: 2, style: 1, label: 'A', custom_id: 'a' }] }])
  })

  it('a native payload is sent untouched', async () => {
    const calls = mockFetch()
    await provider().editMessage(ref, { kind: 'native', provider: 'discord', payload: { content: 'raw' } })
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ content: 'raw' })
  })
})
