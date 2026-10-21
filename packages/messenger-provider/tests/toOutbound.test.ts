import { describe, it, expect } from 'vitest'
import { UnsupportedContentError } from '@botmesh/core'
import { toOutbound } from '../src/toOutbound.js'

describe('toOutbound', () => {
  it('maps text', () => {
    expect(toOutbound({ kind: 'text', text: 'hola' })).toEqual({ text: 'hola' })
  })

  it('maps image/video/audio/document to reusable attachments', () => {
    expect(toOutbound({ kind: 'image', media: 'https://x/i.png' }, 'https://x/i.png')).toEqual({
      attachment: { type: 'image', payload: { url: 'https://x/i.png', is_reusable: true } },
    })
    const vid = toOutbound({ kind: 'video', media: 'u' }, 'https://x/v.mp4') as { attachment: { type: string } }
    expect(vid.attachment.type).toBe('video')
    const aud = toOutbound({ kind: 'voice', media: 'u' }, 'https://x/a.mp3') as { attachment: { type: string } }
    expect(aud.attachment.type).toBe('audio')
    const doc = toOutbound({ kind: 'document', media: 'u' }, 'https://x/f.pdf') as { attachment: { type: string } }
    expect(doc.attachment.type).toBe('file')
  })

  it('throws when media has no resolved URL', () => {
    expect(() => toOutbound({ kind: 'image', media: Buffer.from('x') })).toThrow(UnsupportedContentError)
  })

  it('maps buttons to a button template (max 3, title ≤20, payload=id)', () => {
    const msg = toOutbound({
      kind: 'buttons',
      text: 'Choose',
      buttons: [
        { id: 'A', title: 'Option A' },
        { id: 'B', title: 'A very long button title that exceeds the limit' },
        { id: 'C', title: 'Option C' },
        { id: 'D', title: 'Fourth (dropped)' },
      ],
    })
    expect(msg).toMatchObject({
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: 'Choose',
          buttons: [
            { type: 'postback', title: 'Option A', payload: 'A' },
            { type: 'postback', title: 'A very long button t', payload: 'B' },
            { type: 'postback', title: 'Option C', payload: 'C' },
          ],
        },
      },
    })
    const payload = (msg as { attachment: { payload: { buttons: unknown[] } } }).attachment.payload
    expect(payload.buttons).toHaveLength(3)
  })

  it('maps lists to a generic template with one element per row', () => {
    const msg = toOutbound({
      kind: 'list',
      text: 'Menu',
      buttonText: 'Open',
      sections: [{
        title: 'Drinks',
        rows: [
          { id: 'COFFEE', title: 'Coffee', description: 'Hot' },
          { id: 'WATER', title: 'Water' },
        ],
      }],
    })
    const payload = (msg as { attachment: { type: string; payload: Record<string, unknown> } }).attachment.payload
    expect(payload.template_type).toBe('generic')
    expect(payload.elements).toEqual([
      { title: 'Coffee', subtitle: 'Hot', buttons: [{ type: 'postback', title: 'Coffee', payload: 'COFFEE' }] },
      { title: 'Water', buttons: [{ type: 'postback', title: 'Water', payload: 'WATER' }] },
    ])
  })

  it('maps card to plain text (title + body)', () => {
    expect(toOutbound({ kind: 'card', title: 'T', body: 'B' })).toEqual({ text: 'T\nB' })
  })

  it('passes native payloads through as the message object', () => {
    expect(toOutbound({ kind: 'native', provider: 'messenger', payload: { text: 'raw' } })).toEqual({ text: 'raw' })
  })

  it.each(['poll', 'reaction', 'location', 'contact', 'template', 'sticker'] as const)(
    'rejects unsupported kind: %s',
    (kind) => {
      const content =
        kind === 'poll' ? { kind, question: 'q', options: ['a'] }
        : kind === 'reaction' ? { kind, emoji: '❤️', target: { id: 'm', chatId: 'c' } }
        : kind === 'location' ? { kind, lat: 1, lng: 2 }
        : kind === 'contact' ? { kind, phone: '123' }
        : kind === 'template' ? { kind, name: 'n', language: 'es' }
        : { kind, media: 'https://x/s.webp' }
      try {
        toOutbound(content as never, 'https://x/m')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedContentError)
        expect((err as UnsupportedContentError).kind).toBe(kind)
      }
    },
  )
})
