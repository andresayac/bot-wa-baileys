import { describe, it, expect } from 'vitest'
import { MemoryStore } from '../src/store/MemoryStore.js'

describe('MemoryStore conversations', () => {
  it('round-trips a conversation', async () => {
    const s = new MemoryStore({})
    expect(await s.getConversation('a')).toBeUndefined()
    await s.setConversation('a', [{ role: 'user', content: 'hi' }])
    expect(await s.getConversation('a')).toEqual([{ role: 'user', content: 'hi' }])
  })
  it('clears and isolates by key', async () => {
    const s = new MemoryStore({})
    await s.setConversation('a', [{ role: 'user', content: 'x' }])
    await s.setConversation('b', [{ role: 'assistant', content: 'y' }])
    await s.clearConversation('a')
    expect(await s.getConversation('a')).toBeUndefined()
    expect(await s.getConversation('b')).toEqual([{ role: 'assistant', content: 'y' }])
  })
})
