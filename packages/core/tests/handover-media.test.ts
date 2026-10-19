/**
 * Integration of hand-over answers (coordination.handover) with durable media references
 * (durability.inbox.mediaRefs): an answer recorded by inbox id is rebuilt from the journaled
 * record, whose media token is a serialized marker — the bridge must rehydrate it through the
 * provider hooks, like a durable replay does, instead of handing the marker to the handler.
 */
import { describe, expect, it } from 'vitest'
import type { InboundMessage, MediaRef, SerializedMediaRef } from '../src/index.js'
import { createHandoverBridge } from '../src/core/bot/handover.js'
import type { InboundPipeline } from '../src/core/bot/inbound.js'
import type { BotKernel } from '../src/core/bot/kernel.js'
import { encodeInboundWithMedia, providerMediaCodec } from '../src/durability/media.js'
import type { IProvider } from '../src/core/provider.js'

const silent = { debug() {}, warn() {}, info() {}, error() {}, child() { return silent } }

function message(token: unknown): InboundMessage {
  return {
    ref: { id: 'm1', chatId: 'u1' },
    chat: { id: 'u1', kind: 'dm', isGroup: false, isBroadcast: false },
    senderInfo: { id: 'u1', displayName: 'U' },
    from: 'u1', sender: 'u1', chatId: 'u1', senderId: 'u1',
    isGroup: false, isBroadcast: false, fromMe: false,
    type: 'image', body: '', timestamp: 1, mentions: [],
    media: { kind: 'image', mimetype: 'image/png', token },
    raw: {},
  }
}

function provider(hooks: boolean): IProvider {
  const p = { id: 'mediaprov' } as Record<string, unknown>
  if (hooks) {
    p.serializeMediaRef = (ref: MediaRef): SerializedMediaRef => ({ v: 1, data: { handle: (ref.token as { handle: string }).handle } })
    p.rehydrateMediaRef = (stored: SerializedMediaRef, ref: Omit<MediaRef, 'token'>): MediaRef =>
      ({ ...ref, token: { handle: (stored.data as { handle: string }).handle, live: true } })
  }
  return p as unknown as IProvider
}

function bridgeFor(p: IProvider, payload: unknown) {
  const k = {
    provider: p,
    logger: silent,
    durable: { inbox: { get: async (id: string) => (id === 'in-1' ? { id, payload } : undefined) } },
  } as unknown as Pick<BotKernel, 'durable' | 'provider' | 'logger'>
  const inbound = { contextOf: (m: InboundMessage) => ({ ...m }) } as unknown as InboundPipeline
  return createHandoverBridge(k, {}, () => inbound)
}

describe('hand-over answer + durable media references', () => {
  it('rehydrates the media token of an answer recorded by inbox id', async () => {
    const p = provider(true)
    const payload = encodeInboundWithMedia({ kind: 'message', message: message({ handle: 'h-42' }) }, providerMediaCodec(p), silent)
    expect(JSON.stringify(payload)).toContain('$botwaMedia')
    const ctx = await bridgeFor(p, payload).answers.rehydrate({ inboundId: 'in-1', at: 1 }) as unknown as InboundMessage
    expect(ctx.media?.token).toEqual({ handle: 'h-42', live: true })
  })

  it('leaves a plain (pre-media-refs) journaled token untouched', async () => {
    const p = provider(false)
    const payload = encodeInboundWithMedia({ kind: 'message', message: message('plain-token') }, providerMediaCodec(p), silent)
    const ctx = await bridgeFor(p, payload).answers.rehydrate({ inboundId: 'in-1', at: 1 }) as unknown as InboundMessage
    expect(ctx.media?.token).toBe('plain-token')
  })
})
