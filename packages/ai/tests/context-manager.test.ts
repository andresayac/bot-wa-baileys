import { describe, it, expect } from 'vitest'
import { MemoryStore } from '@bot-wa/core'
import { ContextManager } from '../src/ContextManager.js'
import { chatKeyOf } from '../src/chatKey.js'

describe('chatKeyOf', () => {
  it('DM = from; group = from:sender', () => {
    expect(chatKeyOf({ from: 'a@s.whatsapp.net', sender: 'a@s.whatsapp.net', isGroup: false })).toBe('a@s.whatsapp.net')
    expect(chatKeyOf({ from: 'g@g.us', sender: 'u1@s.whatsapp.net', isGroup: true })).toBe('g@g.us:u1@s.whatsapp.net')
  })
})

describe('ContextManager', () => {
  it('append accumulates and history returns in order', async () => {
    const cm = new ContextManager(new MemoryStore({}))
    await cm.append('k', { role: 'user', content: '1' })
    await cm.append('k', { role: 'assistant', content: '2' })
    expect(await cm.history('k')).toEqual([{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }])
  })
  it('bounds the window to maxMessages (oldest dropped)', async () => {
    const cm = new ContextManager(new MemoryStore({}), { maxMessages: 2 })
    for (const c of ['1', '2', '3']) await cm.append('k', { role: 'user', content: c })
    const h = await cm.history('k')
    expect(h.map((m) => m.content)).toEqual(['2', '3'])
  })
  it('clear empties the chat, isolated by key', async () => {
    const cm = new ContextManager(new MemoryStore({}))
    await cm.append('a', { role: 'user', content: 'x' })
    await cm.append('b', { role: 'user', content: 'y' })
    await cm.clear('a')
    expect(await cm.history('a')).toEqual([])
    expect(await cm.history('b')).toHaveLength(1)
  })
})
