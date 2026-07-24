import { describe, expect, it } from 'vitest'

import { MemoryStore } from '../src/store/MemoryStore.js'
import { NamespacedStore, type StoreNamespace } from '../src/store/NamespacedStore.js'

const namespace = (botId: string): StoreNamespace => ({
  tenantId: 'tenant',
  environmentId: 'prod',
  botId,
  providerId: 'mock',
  connectionId: 'primary',
})

describe('NamespacedStore', () => {
  it('isolates identical chat, message and contact ids between bots', async () => {
    const inner = new MemoryStore()
    const a = new NamespacedStore(inner, namespace('a'))
    const b = new NamespacedStore(inner, namespace('b'))
    const ref = { id: 'same-message', chatId: 'same-chat' }

    await a.saveMessage({ ref, chatId: 'same-chat', senderId: 'same-user', timestamp: 1, type: 'text', body: 'A' })
    await b.saveMessage({ ref, chatId: 'same-chat', senderId: 'same-user', timestamp: 1, type: 'text', body: 'B' })
    await a.upsertChat({ id: 'same-chat', name: 'Chat A' })
    await b.upsertChat({ id: 'same-chat', name: 'Chat B' })
    await a.upsertContact({ id: 'same-user', name: 'User A' })
    await b.upsertContact({ id: 'same-user', name: 'User B' })

    expect((await a.getMessage(ref))?.body).toBe('A')
    expect((await b.getMessage(ref))?.body).toBe('B')
    expect((await a.getChat('same-chat'))?.name).toBe('Chat A')
    expect((await b.getChat('same-chat'))?.name).toBe('Chat B')
    expect((await a.getContact('same-user'))?.name).toBe('User A')
    expect((await b.getContact('same-user'))?.name).toBe('User B')
    expect(await a.listChats()).toHaveLength(1)
    expect(await b.listContacts()).toHaveLength(1)
  })

  it('isolates conversations, checkpoints and cursors', async () => {
    const inner = new MemoryStore()
    const a = new NamespacedStore(inner, namespace('a'))
    const b = new NamespacedStore(inner, namespace('b'))

    await a.setConversation('chat', [{ role: 'user', content: 'A' }])
    await b.setConversation('chat', [{ role: 'user', content: 'B' }])
    await a.setCheckpoint('chat', { flowId: 'a', step: 1, state: {}, updatedAt: 1 })
    await b.setCheckpoint('chat', { flowId: 'b', step: 2, state: {}, updatedAt: 1 })
    await a.setCursor('updates', '10')
    await b.setCursor('updates', '20')

    expect((await a.getConversation('chat'))?.[0]?.content).toBe('A')
    expect((await b.getConversation('chat'))?.[0]?.content).toBe('B')
    expect((await a.getCheckpoint('chat'))?.flowId).toBe('a')
    expect((await b.listCheckpoints())[0]?.[0]).toBe('chat')
    expect(await a.getCursor('updates')).toBe('10')
    expect(await b.getCursor('updates')).toBe('20')
  })
})
