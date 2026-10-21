import { describe, it, expect } from 'vitest'
import { UnsupportedContentError } from '@botmesh/core'
import { toOutbound, MEDIA_UPLOAD } from '../src/toOutbound.js'

describe('toOutbound', () => {
  it('text → sendMessage', () => {
    expect(toOutbound({ kind: 'text', text: 'hola' })).toEqual({ method: 'sendMessage', params: { text: 'hola' } })
  })

  it('image with a file_id/URL value → sendPhoto with caption', () => {
    const out = toOutbound({ kind: 'image', media: 'https://x/i.png', caption: 'mira' }, { value: 'https://x/i.png' })
    expect(out.method).toBe('sendPhoto')
    expect(out.params).toEqual({ photo: 'https://x/i.png', caption: 'mira' })
    expect(out.mediaField).toBeUndefined()
  })

  it('image with a buffer → MEDIA_UPLOAD marker + mediaField', () => {
    const out = toOutbound({ kind: 'image', media: '' as never }, { buffer: Buffer.from('x') })
    expect(out.method).toBe('sendPhoto')
    expect(out.params.photo).toBe(MEDIA_UPLOAD)
    expect(out.mediaField).toBe('photo')
  })

  it('media kind without resolvable media throws UnsupportedContentError', () => {
    expect(() => toOutbound({ kind: 'image', media: '' as never })).toThrow(UnsupportedContentError)
  })

  it('document keeps caption; filename rides on the multipart part', () => {
    const out = toOutbound({ kind: 'document', media: '' as never, filename: 'a.pdf', caption: 'c' }, { buffer: Buffer.from('x'), filename: 'a.pdf' })
    expect(out.method).toBe('sendDocument')
    expect(out.mediaField).toBe('document')
    expect(out.params).toEqual({ document: MEDIA_UPLOAD, caption: 'c' })
  })

  it('voice/audio/video/sticker map to their send methods', () => {
    expect(toOutbound({ kind: 'voice', media: '' as never }, { value: 'fid' }).method).toBe('sendVoice')
    expect(toOutbound({ kind: 'audio', media: '' as never }, { value: 'fid' }).method).toBe('sendAudio')
    expect(toOutbound({ kind: 'video', media: '' as never }, { value: 'fid' }).method).toBe('sendVideo')
    expect(toOutbound({ kind: 'sticker', media: '' as never }, { value: 'fid' }).params.sticker).toBe('fid')
  })

  it('poll → sendPoll (native, with multiSelect)', () => {
    const out = toOutbound({ kind: 'poll', question: '¿Color?', options: ['Rojo', 'Azul'], multiSelect: true })
    expect(out.method).toBe('sendPoll')
    expect(out.params).toEqual({ question: '¿Color?', options: ['Rojo', 'Azul'], allows_multiple_answers: true })
  })

  it('buttons → sendMessage with inline_keyboard rows {text, callback_data}', () => {
    const out = toOutbound({
      kind: 'buttons', text: 'elige',
      buttons: [
        { id: 'yes', title: 'Sí' },
        { id: 'no', title: 'No' },
        { id: 'web', title: 'Web', url: 'https://x.dev' },
      ],
    })
    expect(out.method).toBe('sendMessage')
    const kb = (out.params.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }).inline_keyboard
    expect(kb).toEqual([
      [{ text: 'Sí', callback_data: 'yes' }],
      [{ text: 'No', callback_data: 'no' }],
      [{ text: 'Web', url: 'https://x.dev' }],
    ])
  })

  it('button text/callback_data are truncated to 64 chars', () => {
    const long = 'x'.repeat(100)
    const out = toOutbound({ kind: 'buttons', text: 't', buttons: [{ id: long, title: long }] })
    const btn = (out.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard[0][0]
    expect(btn.text).toHaveLength(64)
    expect(btn.callback_data).toHaveLength(64)
  })

  it('list degrades to an inline keyboard (all section rows flattened)', () => {
    const out = toOutbound({
      kind: 'list', text: 'menú', buttonText: 'Ver opciones',
      sections: [
        { title: 'A', rows: [{ id: 'r1', title: 'Fila 1' }] },
        { title: 'B', rows: [{ id: 'r2', title: 'Fila 2' }] },
      ],
    })
    expect(out.method).toBe('sendMessage')
    expect(out.params.text).toBe('menú\nVer opciones')
    const kb = (out.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard
    expect(kb).toHaveLength(2)
    expect(kb[0][0].callback_data).toBe('r1')
    expect(kb[1][0].callback_data).toBe('r2')
  })

  it('reaction → setMessageReaction targeting the quoted chat/message', () => {
    const out = toOutbound({ kind: 'reaction', emoji: '👍', target: { id: '55', chatId: '-1001' } })
    expect(out.method).toBe('setMessageReaction')
    expect(out.params).toEqual({
      chat_id: '-1001',
      message_id: 55,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    })
  })

  it('empty reaction emoji removes the reaction', () => {
    const out = toOutbound({ kind: 'reaction', emoji: '', target: { id: '1', chatId: 'c' } })
    expect(out.params.reaction).toEqual([])
  })

  it('location → sendLocation', () => {
    expect(toOutbound({ kind: 'location', lat: 4.7, lng: -74.0 }))
      .toEqual({ method: 'sendLocation', params: { latitude: 4.7, longitude: -74.0 } })
  })

  it('contact → sendContact', () => {
    expect(toOutbound({ kind: 'contact', phone: '573001', displayName: 'Soporte' }))
      .toEqual({ method: 'sendContact', params: { phone_number: '573001', first_name: 'Soporte' } })
  })

  it('card with imageUrl → sendPhoto with joined caption', () => {
    const out = toOutbound({ kind: 'card', title: 'T', body: 'B', imageUrl: 'https://x/c.png' })
    expect(out.method).toBe('sendPhoto')
    expect(out.params).toEqual({ photo: 'https://x/c.png', caption: 'T\nB' })
  })

  it('native with { method, params } passes through', () => {
    const out = toOutbound({ kind: 'native', provider: 'telegram', payload: { method: 'sendDice', params: { emoji: '🎲' } } })
    expect(out).toEqual({ method: 'sendDice', params: { emoji: '🎲' } })
  })

  it('native bare payload defaults to sendMessage params', () => {
    const out = toOutbound({ kind: 'native', provider: 'telegram', payload: { text: 'raw' } })
    expect(out).toEqual({ method: 'sendMessage', params: { text: 'raw' } })
  })

  it('template throws UnsupportedContentError', () => {
    expect(() => toOutbound({ kind: 'template', name: 'x', language: 'es' })).toThrow(UnsupportedContentError)
  })
})

describe('toOutbound — hardening', () => {
  it('callback_data is truncated to 64 UTF-8 BYTES (not chars), never splitting a code point', () => {
    const id = 'ñ'.repeat(40) // 80 bytes in UTF-8, 40 chars
    const out = toOutbound({ kind: 'buttons', text: 't', buttons: [{ id, title: 'x' }, { id: '😀'.repeat(20), title: 'y' }] })
    const rows = (out.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard
    for (const [btn] of rows) {
      expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64)
      expect(btn.callback_data).not.toContain('\uFFFD')
    }
    expect(rows[0][0].callback_data).toBe('ñ'.repeat(32))
    expect(rows[1][0].callback_data).toBe('😀'.repeat(16))
  })

  it('location with name and address → sendVenue (the name is not dropped)', () => {
    expect(toOutbound({ kind: 'location', lat: 4.7, lng: -74, name: 'Panadería', address: 'Cra 7 #12' }))
      .toEqual({ method: 'sendVenue', params: { latitude: 4.7, longitude: -74, title: 'Panadería', address: 'Cra 7 #12' } })
  })
})
