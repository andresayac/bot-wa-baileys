import { describe, it, expect } from 'vitest'
import { UnsupportedContentError } from '@botmesh/core'
import { toOutbound } from '../src/toOutbound.js'

describe('toOutbound', () => {
  it('text', () => {
    expect(toOutbound({ kind: 'text', text: 'hola' })).toEqual({ type: 'text', text: { body: 'hola' } })
  })

  it('image by uploaded id with caption', () => {
    expect(toOutbound({ kind: 'image', media: '' as never, caption: 'mira' }, { id: 'IMG' }))
      .toEqual({ type: 'image', image: { id: 'IMG', caption: 'mira' } })
  })

  it('image by link', () => {
    expect(toOutbound({ kind: 'image', media: '' as never }, { link: 'https://x/i.png' }))
      .toEqual({ type: 'image', image: { link: 'https://x/i.png' } })
  })

  it('media without id/link throws', () => {
    expect(() => toOutbound({ kind: 'image', media: '' as never })).toThrow(UnsupportedContentError)
  })

  it('buttons → interactive button (capped at 3, title ≤20)', () => {
    const out = toOutbound({
      kind: 'buttons',
      text: 'elige',
      footer: 'f',
      buttons: [
        { id: 'a', title: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' },
      ],
    })
    const interactive = (out as { interactive: { action: { buttons: Array<{ reply: { id: string; title: string } }> }; footer?: unknown } }).interactive
    expect(interactive.action.buttons).toHaveLength(3)
    expect(interactive.action.buttons[0].reply.title).toHaveLength(20)
    expect(interactive.footer).toEqual({ text: 'f' })
  })

  it('list → interactive list', () => {
    const out = toOutbound({
      kind: 'list',
      text: 'menú',
      buttonText: 'Ver opciones',
      sections: [{ title: 'S', rows: [{ id: 'r1', title: 'Fila 1', description: 'd' }] }],
    }) as { interactive: { type: string; action: { button: string; sections: unknown[] } } }
    expect(out.interactive.type).toBe('list')
    expect(out.interactive.action.button).toBe('Ver opciones')
  })

  it('reaction', () => {
    expect(toOutbound({ kind: 'reaction', emoji: '👍', target: { id: 'wamid.1', chatId: 'x' } }))
      .toEqual({ type: 'reaction', reaction: { message_id: 'wamid.1', emoji: '👍' } })
  })

  it('location', () => {
    expect(toOutbound({ kind: 'location', lat: 4.7, lng: -74.0, name: 'Bogotá' }))
      .toEqual({ type: 'location', location: { latitude: 4.7, longitude: -74.0, name: 'Bogotá' } })
  })

  it('contact', () => {
    const out = toOutbound({ kind: 'contact', phone: '573001', displayName: 'Soporte' }) as { contacts: Array<{ name: { formatted_name: string }; phones: Array<{ phone: string }> }> }
    expect(out.contacts[0].name.formatted_name).toBe('Soporte')
    expect(out.contacts[0].phones[0].phone).toBe('573001')
  })

  it('template', () => {
    expect(toOutbound({ kind: 'template', name: 'hola_mundo', language: 'es', components: [] }))
      .toEqual({ type: 'template', template: { name: 'hola_mundo', language: { code: 'es' }, components: [] } })
  })

  it('native passes through', () => {
    const payload = { type: 'text', text: { body: 'raw' } }
    expect(toOutbound({ kind: 'native', provider: 'meta', payload })).toBe(payload)
  })

  it('poll throws UnsupportedContentError (Cloud API 131051)', () => {
    expect(() => toOutbound({ kind: 'poll', question: 'q', options: ['a', 'b'] })).toThrow(UnsupportedContentError)
  })
})
