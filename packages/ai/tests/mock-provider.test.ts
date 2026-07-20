import { describe, it, expect } from 'vitest'
import { MockAIProvider } from '../src/MockAIProvider.js'

describe('MockAIProvider', () => {
  it('returns a fixed reply and records calls', async () => {
    const p = new MockAIProvider({ reply: 'hola' })
    const r = await p.generate({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('hola')
    expect(p.calls).toHaveLength(1)
    expect(p.calls[0].messages[0].content).toBe('hi')
  })
  it('reply can be a function of input', async () => {
    const p = new MockAIProvider({ reply: (i) => `echo:${i.messages.at(-1)?.content}` })
    const r = await p.generate({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('echo:x')
  })
  it('stream yields the reply in chunks', async () => {
    const p = new MockAIProvider({ reply: 'ab' })
    const out: string[] = []
    for await (const d of p.stream({ messages: [] })) out.push(d)
    expect(out.join('')).toBe('ab')
  })
})
