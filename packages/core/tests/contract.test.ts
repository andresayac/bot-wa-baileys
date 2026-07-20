import { describe, it, expect } from 'vitest'
import {
  messageKey,
  ProviderError,
  UnsupportedContentError,
  RateLimitedError,
  RecipientUnreachableError,
  OutsideSessionWindowError,
  type IProvider,
  type InboundEvent,
  type OutboundContent,
  type ProviderCapabilities,
} from '../src/core/provider.js'

/** A minimal in-memory provider proving IProvider v2 is implementable with zero WhatsApp concept. */
function makeFakeProvider(): IProvider {
  const listeners = new Set<(e: InboundEvent) => void>()
  const capabilities: ProviderCapabilities = {
    contentKinds: ['text'],
    buttons: false, lists: false, polls: false, reactions: false, edit: false,
    typing: false, presence: false, readReceipts: false, groups: false, templates: false,
    interactionsRequireAck: false, pushIngress: false,
  }
  return {
    id: 'fake',
    capabilities,
    async start() {},
    async stop() {},
    async send(chatId, content: OutboundContent) {
      return { ref: { id: 'out-1', chatId } }
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    get connection() { return null },
  }
}

describe('IProvider v2 contract', () => {
  it('messageKey composes chatId:id', () => {
    expect(messageKey({ id: 'm1', chatId: 'c1' })).toBe('c1:m1')
  })

  it('a fake provider (no WhatsApp concept) satisfies the interface', async () => {
    const p = makeFakeProvider()
    expect(p.id).toBe('fake')
    expect(p.capabilities.contentKinds).toContain('text')
    await p.start()
    const res = await p.send('chat-1', { kind: 'text', text: 'hi' })
    expect(res.ref).toEqual({ id: 'out-1', chatId: 'chat-1' })
    const off = p.onEvent(() => {})
    expect(typeof off).toBe('function')
    off()
    await p.stop()
  })

  it('typed errors extend ProviderError', () => {
    expect(new UnsupportedContentError('buttons')).toBeInstanceOf(ProviderError)
    expect(new RateLimitedError(1000)).toBeInstanceOf(ProviderError)
    expect(new RecipientUnreachableError('c1')).toBeInstanceOf(ProviderError)
    expect(new OutsideSessionWindowError('c1')).toBeInstanceOf(ProviderError)
    expect(new UnsupportedContentError('buttons').kind).toBe('buttons')
    expect(new RateLimitedError(1500).retryAfterMs).toBe(1500)
  })
})
