import { describe, it, expect } from 'vitest'
import { UnsupportedContentError } from '@bot-wa/core'
import { toOutbound } from '../src/toOutbound.js'

describe('toOutbound (Instagram)', () => {
  it('text', () => {
    expect(toOutbound({ kind: 'text', text: 'hola' })).toEqual({ text: 'hola' })
  })

  it('image by URL → attachment payload (is_reusable)', () => {
    expect(toOutbound({ kind: 'image', media: 'https://x/i.png' }))
      .toEqual({ attachment: { type: 'image', payload: { url: 'https://x/i.png', is_reusable: true } } })
  })

  it('image by { url } object', () => {
    expect(toOutbound({ kind: 'image', media: { url: 'https://x/i.png' } }))
      .toEqual({ attachment: { type: 'image', payload: { url: 'https://x/i.png', is_reusable: true } } })
  })

  it('document → attachment type file', () => {
    const out = toOutbound({ kind: 'document', media: 'https://x/doc.pdf' }) as { attachment: { type: string } }
    expect(out.attachment.type).toBe('file')
  })

  it('voice → attachment type audio', () => {
    const out = toOutbound({ kind: 'voice', media: 'https://x/v.ogg' }) as { attachment: { type: string } }
    expect(out.attachment.type).toBe('audio')
  })

  it('buttons → quick_replies (title ≤20, payload = button id)', () => {
    const out = toOutbound({
      kind: 'buttons',
      text: 'elige',
      buttons: [
        { id: 'a', title: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        { id: 'b', title: 'B' },
      ],
    }) as { text: string; quick_replies: Array<{ content_type: string; title: string; payload: string }> }
    expect(out.text).toBe('elige')
    expect(out.quick_replies).toHaveLength(2)
    expect(out.quick_replies[0].content_type).toBe('text')
    expect(out.quick_replies[0].title).toHaveLength(20)
    expect(out.quick_replies[0].payload).toBe('a')
    expect(out.quick_replies[1].payload).toBe('b')
  })

  it('list → degrades to a numbered-text message', () => {
    const out = toOutbound({
      kind: 'list',
      text: 'menú',
      buttonText: 'Ver opciones',
      sections: [{ title: 'Sección', rows: [{ id: 'r1', title: 'Fila 1' }, { id: 'r2', title: 'Fila 2' }] }],
    }) as { text: string }
    expect(out.text).toContain('menú')
    expect(out.text).toContain('Sección')
    expect(out.text).toContain('1. Fila 1')
    expect(out.text).toContain('2. Fila 2')
  })

  it('card → text (title + body)', () => {
    expect(toOutbound({ kind: 'card', title: 'T', body: 'B' })).toEqual({ text: 'T\nB' })
  })

  it('native passes through', () => {
    const payload = { text: 'raw' }
    expect(toOutbound({ kind: 'native', provider: 'instagram', payload })).toBe(payload)
  })

  it('buffer media throws UnsupportedContentError (URL-only transport)', () => {
    expect(() => toOutbound({ kind: 'image', media: Buffer.from('x') })).toThrow(UnsupportedContentError)
  })

  it('local path media throws UnsupportedContentError', () => {
    expect(() => toOutbound({ kind: 'image', media: '/tmp/local.png' })).toThrow(UnsupportedContentError)
  })

  it('unsupported kinds throw (poll, reaction, location, contact, sticker, template)', () => {
    expect(() => toOutbound({ kind: 'poll', question: 'q', options: ['a'] })).toThrow(UnsupportedContentError)
    expect(() => toOutbound({ kind: 'reaction', emoji: '👍', target: { id: 'm', chatId: 'c' } })).toThrow(UnsupportedContentError)
    expect(() => toOutbound({ kind: 'location', lat: 1, lng: 2 })).toThrow(UnsupportedContentError)
    expect(() => toOutbound({ kind: 'contact', phone: '1' })).toThrow(UnsupportedContentError)
    expect(() => toOutbound({ kind: 'sticker', media: 'https://x/s.webp' })).toThrow(UnsupportedContentError)
    expect(() => toOutbound({ kind: 'template', name: 'n', language: 'es' })).toThrow(UnsupportedContentError)
  })
})
