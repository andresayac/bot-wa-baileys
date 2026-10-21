import { describe, it, expect, vi, afterEach } from 'vitest'
import { OutsideSessionWindowError, RecipientUnreachableError } from '@botmesh/core'
import { InstagramProvider } from '../src/InstagramProvider.js'
import { toProviderError } from '../src/graphClient.js'
import { toOutbound } from '../src/toOutbound.js'
import { parseInbound } from '../src/parseInbound.js'

const baseCfg = { accessToken: 'TOK', verifyToken: 'vt', allowUnsignedWebhooks: true }

function stubGraphError(error: Record<string, unknown>, status = 400): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error }),
  })))
}

afterEach(() => vi.unstubAllGlobals())

describe('Instagram error mapping', () => {
  it('outside the messaging window (code 10 / subcode 2534022) → OutsideSessionWindowError with the chat id', async () => {
    stubGraphError({ code: 10, error_subcode: 2534022, message: '(#10) This message is sent outside of allowed window.' })
    const err = await new InstagramProvider(baseCfg).send('IGSID1', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OutsideSessionWindowError)
    expect((err as OutsideSessionWindowError).chatId).toBe('IGSID1')
  })

  it('unknown / unavailable recipients → RecipientUnreachableError with the chat id', async () => {
    stubGraphError({ code: 551, message: "This person isn't available right now." })
    const err = await new InstagramProvider(baseCfg).send('IGSID2', { kind: 'text', text: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecipientUnreachableError)
    expect((err as RecipientUnreachableError).chatId).toBe('IGSID2')
    expect(toProviderError({ code: 100, error_subcode: 2018001, message: 'No matching user found' }, undefined, 'X')).toBeInstanceOf(RecipientUnreachableError)
  })
})

describe('Instagram outbound hardening', () => {
  it('quick replies cap at 13 and fall back to the title when a button id is empty', () => {
    const buttons = Array.from({ length: 15 }, (_, i) => ({ id: i === 0 ? '' : `b${i}`, title: `T${i}` }))
    const msg = toOutbound({ kind: 'buttons', text: 'x', buttons }) as { quick_replies: Array<{ payload: string }> }
    expect(msg.quick_replies).toHaveLength(13)
    expect(msg.quick_replies[0].payload).toBe('T0')
  })

  it('a card keeps its buttons as quick replies', () => {
    const msg = toOutbound({ kind: 'card', title: 'T', body: 'B', buttons: [{ id: 'GO', title: 'Ir' }] })
    expect(msg).toEqual({ text: 'T\nB', quick_replies: [{ content_type: 'text', title: 'Ir', payload: 'GO' }] })
  })
})

describe('Instagram inbound hardening', () => {
  it('an unsent message (is_deleted) is not surfaced as a new message', () => {
    const events = parseInbound({
      object: 'instagram',
      entry: [{ messaging: [{ sender: { id: 'U' }, timestamp: 1, message: { mid: 'm1', is_deleted: true } }] }],
    })
    expect(events).toEqual([])
  })
})

describe('Instagram ingest — malformed bodies', () => {
  it('answers 400 (never throws) for a raw body that is not a JSON object', () => {
    const p = new InstagramProvider(baseCfg)
    expect(p.ingest('{not json')).toBe(400)
    expect(p.ingest(Buffer.from('<html>'))).toBe(400)
    expect(p.ingest('"str"')).toBe(400)
  })

  it('answers 400 for a correctly signed body that is not JSON', async () => {
    const { createHmac } = await import('node:crypto')
    const p = new InstagramProvider({ ...baseCfg, appSecret: 'shh' })
    const raw = '{oops'
    const sig = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex')
    expect(p.ingest(raw, { 'x-hub-signature-256': sig })).toBe(400)
  })
})

describe('Instagram send errors carry the content kind', () => {
  it('an unsupported-content code reports the kind that was sent', async () => {
    stubGraphError({ code: 131051, message: 'unsupported' })
    const err = await new InstagramProvider(baseCfg).send('IGSID', { kind: 'video', media: 'https://x.dev/a.mp4' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'UnsupportedContentError', kind: 'video' })
  })
})
