import { describe, it, expect } from 'vitest'
import { UnsupportedContentError } from '@bot-wa/core'
import { toOutbound, type DiscordFile } from '../src/toOutbound.js'

const file: DiscordFile = { name: 'p.png', buffer: Buffer.from('x'), contentType: 'image/png' }

type Row = { type: number; components: Array<Record<string, unknown>> }

describe('toOutbound', () => {
  it('text → { content }', () => {
    expect(toOutbound({ kind: 'text', text: 'hola' })).toEqual({ payload: { content: 'hola' } })
  })

  it('image with resolved file → attachments + files[0], caption as content/description', () => {
    const out = toOutbound({ kind: 'image', media: '' as never, caption: 'mira' }, file)
    expect(out.payload.attachments).toEqual([{ id: 0, filename: 'p.png', description: 'mira' }])
    expect(out.payload.content).toBe('mira')
    expect(out.files).toEqual([file])
  })

  it('media without a resolved file throws UnsupportedContentError', () => {
    expect(() => toOutbound({ kind: 'image', media: '' as never })).toThrow(UnsupportedContentError)
  })

  it('buttons → action rows (type 1) of up to 5 buttons each (url buttons get style 5)', () => {
    const out = toOutbound({
      kind: 'buttons',
      text: 'elige',
      buttons: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B', url: 'https://x' },
        { id: '1', title: '1' }, { id: '2', title: '2' }, { id: '3', title: '3' }, { id: '4', title: '4' },
      ],
    })
    const rows = out.payload.components as Row[]
    const row = rows[0]
    expect(row.type).toBe(1)
    expect(row.components).toHaveLength(5)
    // The 6th button is not dropped: it opens a second action row.
    expect(rows).toHaveLength(2)
    expect(rows[1].components).toEqual([expect.objectContaining({ label: '4', custom_id: '4' })])
    expect(row.components[0]).toMatchObject({ type: 2, style: 1, label: 'A', custom_id: 'a' })
    expect(row.components[1]).toMatchObject({ type: 2, style: 5, url: 'https://x' })
    expect(row.components[1].custom_id).toBeUndefined()
  })

  it('list → string select menu (type 3) with flattened section rows as options', () => {
    const out = toOutbound({
      kind: 'list',
      text: 'menú',
      buttonText: 'Ver opciones',
      sections: [
        { title: 'S1', rows: [{ id: 'r1', title: 'Fila 1', description: 'd' }] },
        { rows: [{ id: 'r2', title: 'Fila 2' }] },
      ],
    })
    const row = (out.payload.components as Row[])[0]
    expect(row.components).toHaveLength(1)
    const select = row.components[0]
    expect(select).toMatchObject({ type: 3, custom_id: 'Ver opciones', placeholder: 'Ver opciones' })
    expect(select.options).toEqual([
      { label: 'Fila 1', value: 'r1', description: 'd' },
      { label: 'Fila 2', value: 'r2' },
    ])
    expect(out.payload.content).toBe('menú')
  })

  it('card → embed (+ buttons become components when present)', () => {
    const out = toOutbound({
      kind: 'card',
      title: 'T',
      body: 'B',
      imageUrl: 'https://x/i.png',
      buttons: [{ id: 'a', title: 'A' }],
    })
    expect(out.payload.embeds).toEqual([{ title: 'T', description: 'B', image: { url: 'https://x/i.png' } }])
    const row = (out.payload.components as Row[])[0]
    expect(row.components[0]).toMatchObject({ type: 2, custom_id: 'a' })
  })

  it('poll → Discord poll payload (24h, multiselect honoured)', () => {
    const out = toOutbound({ kind: 'poll', question: '¿?', options: ['sí', 'no'], multiSelect: true })
    expect(out.payload.poll).toEqual({
      question: { text: '¿?' },
      answers: [{ poll_media: { text: 'sí' } }, { poll_media: { text: 'no' } }],
      duration: 24,
      allow_multiselect: true,
    })
  })

  it('location degrades explicitly to a maps link', () => {
    const out = toOutbound({ kind: 'location', lat: 4.7, lng: -74.0, name: 'Bogotá' })
    expect(out.payload.content).toBe('Bogotá\nhttps://maps.google.com/?q=4.7,-74')
  })

  it('native passes the payload through untouched', () => {
    const out = toOutbound({ kind: 'native', provider: 'discord', payload: { flags: 64, content: 'x' } })
    expect(out.payload).toEqual({ flags: 64, content: 'x' })
  })

  it('template is unsupported; reaction is routed by the provider', () => {
    expect(() => toOutbound({ kind: 'template', name: 'n', language: 'es' })).toThrow(UnsupportedContentError)
    expect(() => toOutbound({ kind: 'reaction', emoji: '👍', target: { id: 'M', chatId: 'C' } })).toThrow(UnsupportedContentError)
  })
})

describe('toOutbound — hardening', () => {
  it('caps buttons at 25 (5 rows × 5) and falls back to the title when a button id is empty', () => {
    const buttons = Array.from({ length: 30 }, (_, i) => ({ id: i === 0 ? '' : `b${i}`, title: `T${i}` }))
    const rows = toOutbound({ kind: 'buttons', text: 'x', buttons }).payload.components as Row[]
    expect(rows).toHaveLength(5)
    expect(rows.flatMap((r) => r.components)).toHaveLength(25)
    expect(rows[0].components[0]).toMatchObject({ custom_id: 'T0' })
  })

  it('list options fall back to the title when a row id is empty', () => {
    const out = toOutbound({ kind: 'list', text: 't', buttonText: 'Ver', sections: [{ title: 's', rows: [{ id: '', title: 'Uno' }] }] })
    const menu = (out.payload.components as Row[])[0].components[0] as { options: Array<{ value: string }> }
    expect(menu.options[0].value).toBe('Uno')
  })
})
