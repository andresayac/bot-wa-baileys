import { describe, it, expect } from 'vitest'
import { MemoryStore } from '@bot-wa/bot-wa-baileys'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { ContextManager } from '../src/ContextManager.js'
import { AIClient } from '../src/AIClient.js'

function make(reply?: any, opts?: any) {
  const provider = new MockAIProvider({ reply })
  const cm = new ContextManager(new MemoryStore({}))
  return { provider, cm, client: new AIClient(provider, cm, opts) }
}

describe('AIClient', () => {
  it('ask does not touch chat history', async () => {
    const { client, cm } = make('respuesta')
    expect(await client.ask('hola')).toBe('respuesta')
    expect(await cm.history('anychat')).toEqual([])
  })
  it('ask passes persona as system', async () => {
    const { client, provider } = make('ok', { persona: 'Eres ACME' })
    await client.ask('hola')
    expect(provider.calls[0].system).toBe('Eres ACME')
  })
  it('replyInChat persists user + assistant and includes history next turn', async () => {
    const { client, cm, provider } = make((i: any) => `r:${i.messages.length}`)
    const r1 = await client.replyInChat('k', 'primero')
    expect(r1).toBe('r:1')                             // solo el user en messages
    const r2 = await client.replyInChat('k', 'segundo')
    expect(r2).toBe('r:3')                             // user1, assistant1, user2
    expect((await cm.history('k')).map((m) => m.content)).toEqual(['primero', 'r:1', 'segundo', 'r:3'])
    expect(provider.calls[1].messages).toHaveLength(3)
  })
  it('replyInChat maps refusal to refusalMessage and does NOT persist', async () => {
    const provider = new MockAIProvider({ reply: '' })
    // forzar refusal:
    provider.generate = async (i) => { provider.calls.push(i); return { text: '', model: 'mock', stopReason: 'refusal' } }
    const cm = new ContextManager(new MemoryStore({}))
    const client = new AIClient(provider, cm, { refusalMessage: 'No puedo.' })
    expect(await client.replyInChat('k', 'x')).toBe('No puedo.')
    expect(await cm.history('k')).toEqual([])
  })
})
