import { describe, it, expect } from 'vitest'
import { MemoryStore } from '@bot-wa/core'
import { MockAIProvider } from '../src/MockAIProvider.js'
import { ContextManager } from '../src/ContextManager.js'
import { TimeoutError } from '@bot-wa/core'
import { AIClient, AITimeoutError } from '../src/AIClient.js'
import type { AIProvider, GenerateInput, GenerateResult } from '../src/types.js'

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

  it('propagates an AbortSignal into the provider on ask/generate/replyInChat', async () => {
    const { client, provider } = make('ok')
    await client.ask('hi')
    expect(provider.calls[0].signal).toBeInstanceOf(AbortSignal)
    await client.generate({ messages: [{ role: 'user', content: 'x' }] })
    expect(provider.calls[1].signal).toBeInstanceOf(AbortSignal)
    await client.replyInChat('k', 'hey')
    expect(provider.calls[2].signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects with AITimeoutError and aborts the request when the provider hangs', async () => {
    let abortedByClient = false
    const hanging: AIProvider = {
      name: 'hang',
      async generate(input: GenerateInput): Promise<GenerateResult> {
        return new Promise<GenerateResult>((_, reject) => {
          input.signal?.addEventListener('abort', () => { abortedByClient = true; reject(new Error('aborted')) })
        })
      },
      async *stream() { /* unused */ },
    }
    const client = new AIClient(hanging, new ContextManager(new MemoryStore({})), { timeoutMs: 20 })
    await expect(client.ask('hola')).rejects.toBeInstanceOf(AITimeoutError)
    // Coherent with core: one `instanceof TimeoutError` check catches AI timeouts too.
    await expect(client.ask('hola')).rejects.toBeInstanceOf(TimeoutError)
    expect(abortedByClient).toBe(true) // the internal controller fired so a hung socket is cancelled
  })

  it('generate() aborts the provider socket on timeout even when the caller passes its own signal', async () => {
    let abortedByClient = false
    const outer = new AbortController() // caller-supplied, never aborted here
    const hanging: AIProvider = {
      name: 'hang',
      generate: (input: GenerateInput) => new Promise<GenerateResult>((_, reject) => {
        input.signal?.addEventListener('abort', () => { abortedByClient = true; reject(new Error('aborted')) })
      }),
      async *stream() {},
    }
    const client = new AIClient(hanging, new ContextManager(new MemoryStore({})), { timeoutMs: 20 })
    await expect(client.generate({ messages: [{ role: 'user', content: 'x' }], signal: outer.signal }))
      .rejects.toBeInstanceOf(AITimeoutError)
    expect(abortedByClient).toBe(true) // internal controller (not the untouched caller signal) cancelled the socket
  })

  it('a hung autoreply does not block forever — replyInChat rejects on timeout', async () => {
    const hanging: AIProvider = {
      name: 'hang',
      generate: () => new Promise<GenerateResult>(() => {}), // never resolves, ignores signal
      async *stream() {},
    }
    const client = new AIClient(hanging, new ContextManager(new MemoryStore({})), { timeoutMs: 20 })
    await expect(client.replyInChat('k', 'x')).rejects.toBeInstanceOf(AITimeoutError)
  })

  it('honors a caller-provided signal (aborting before timeout)', async () => {
    const ctrl = new AbortController()
    const hanging: AIProvider = {
      name: 'hang',
      generate: (input: GenerateInput) => new Promise<GenerateResult>((_, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('user aborted')))
      }),
      async *stream() {},
    }
    const client = new AIClient(hanging, new ContextManager(new MemoryStore({})), { timeoutMs: 10_000 })
    const p = client.ask('hola', { signal: ctrl.signal })
    ctrl.abort()
    await expect(p).rejects.toThrow('user aborted')
  })
})
