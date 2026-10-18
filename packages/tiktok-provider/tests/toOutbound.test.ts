import { describe, it, expect } from 'vitest'
import { PayloadTooLargeError, UnsupportedContentError, type OutboundContent } from '@bot-wa/core'
import { toCommentReply, toDirectReply, toDmMessage } from '../src/toOutbound.js'

const dm = { businessId: 'B', conversationId: 'C' }

describe('toDmMessage', () => {
  it('builds a TEXT message to a CONVERSATION recipient', () => {
    expect(toDmMessage({ kind: 'text', text: 'hola' }, dm)).toEqual({
      business_id: 'B', recipient_type: 'CONVERSATION', recipient: 'C', message_type: 'TEXT', text: { body: 'hola' },
    })
  })
  it('quotes a message via referenced_message_info (text only)', () => {
    expect(toDmMessage({ kind: 'text', text: 'ok' }, { ...dm, quotedId: 'm0' })).toMatchObject({
      referenced_message_info: { referenced_message_id: 'm0' },
    })
    expect(toDmMessage({ kind: 'image', media: Buffer.alloc(1) }, { ...dm, quotedId: 'm0', mediaId: 'x' })).not.toHaveProperty('referenced_message_info')
  })
  it('rejects text over 6000 characters', () => {
    expect(() => toDmMessage({ kind: 'text', text: 'x'.repeat(6001) }, dm)).toThrow(PayloadTooLargeError)
  })
  it('builds an IMAGE message from an uploaded media_id (captions are not supported)', () => {
    expect(toDmMessage({ kind: 'image', media: Buffer.alloc(1) }, { ...dm, mediaId: 'MID' })).toEqual({
      business_id: 'B', recipient_type: 'CONVERSATION', recipient: 'C', message_type: 'IMAGE', image: { media_id: 'MID' },
    })
    expect(() => toDmMessage({ kind: 'image', media: Buffer.alloc(1) }, dm)).toThrow(UnsupportedContentError)
  })
  it('maps 1–3 buttons to a QA_BUTTON_CARD template', () => {
    expect(toDmMessage({ kind: 'buttons', text: '¿Qué quieres?', buttons: [{ id: 'a', title: 'Precios' }, { id: 'b', title: 'Horario' }] }, dm)).toEqual({
      business_id: 'B', recipient_type: 'CONVERSATION', recipient: 'C', message_type: 'TEMPLATE',
      template: { type: 'QA_BUTTON_CARD', title: '¿Qué quieres?', buttons: [{ type: 'REPLY', title: 'Precios', id: 'a' }, { type: 'REPLY', title: 'Horario', id: 'b' }] },
    })
  })
  it('falls back to QA_LINK_CARD when a button title exceeds 20 chars (≤ 40)', () => {
    const r = toDmMessage({ kind: 'buttons', text: 'Q', buttons: [{ id: 'a', title: 'x'.repeat(30) }] }, dm) as { template: { type: string } }
    expect(r.template.type).toBe('QA_LINK_CARD')
  })
  it('degrades buttons a Q&A card cannot hold to a numbered text menu', () => {
    const b = { id: 'a', title: 'A' }
    const text = (content: OutboundContent) => {
      const r = toDmMessage(content, dm) as { message_type: string; text: { body: string } }
      expect(r.message_type).toBe('TEXT')
      return r.text.body
    }
    expect(text({ kind: 'buttons', text: 'Q', buttons: [b, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }] }))
      .toBe('Q\n\n1) A\n2) B\n3) C\n4) D')
    expect(text({ kind: 'buttons', text: 'x'.repeat(41), buttons: [b] })).toBe(`${'x'.repeat(41)}\n\n1) A`)
    expect(text({ kind: 'buttons', text: 'Q', buttons: [{ id: 'a', title: 'x'.repeat(41) }] })).toBe(`Q\n\n1) ${'x'.repeat(41)}`)
    expect(text({ kind: 'buttons', text: 'Q', buttons: [b, { id: 'w', title: 'Web', url: 'https://x.y' }] })).toBe('Q\n\n1) A\n2) Web: https://x.y')
    expect(text({ kind: 'buttons', text: 'Q', buttons: [] })).toBe('Q')
    expect(text({ kind: 'buttons', text: 'Q', buttons: [b, b, b, b], footer: 'Responde con el número' }))
      .toBe('Q\n\n1) A\n2) A\n3) A\n4) A\n\nResponde con el número')
  })
  it('rejects a degraded menu over the DM text limit', () => {
    expect(() => toDmMessage({ kind: 'buttons', text: 'x'.repeat(6000), buttons: [1, 2, 3, 4].map((n) => ({ id: String(n), title: `B${n}` })) }, dm)).toThrow(PayloadTooLargeError)
  })
  it('maps a list with ≤ 3 rows to a QA_LINK_CARD', () => {
    expect(toDmMessage({ kind: 'list', text: 'Elige', buttonText: 'Ver', sections: [{ rows: [{ id: '1', title: 'Uno' }, { id: '2', title: 'Dos' }] }] }, dm)).toMatchObject({
      message_type: 'TEMPLATE',
      template: { type: 'QA_LINK_CARD', title: 'Elige', buttons: [{ type: 'REPLY', title: 'Uno', id: '1' }, { type: 'REPLY', title: 'Dos', id: '2' }] },
    })
    const rows = [1, 2, 3, 4].map((n) => ({ id: String(n), title: `R${n}` }))
    expect(toDmMessage({ kind: 'list', text: 'Elige', buttonText: 'Ver', sections: [{ rows }] }, dm)).toMatchObject({
      message_type: 'TEXT', text: { body: 'Elige\n\n1) R1\n2) R2\n3) R3\n4) R4' },
    })
  })
  it('passes native payloads through, pinned to the conversation', () => {
    expect(toDmMessage({ kind: 'native', provider: 'tiktok', payload: { message_type: 'SHARE_POST', share_post: { item_id: 'V' } } }, dm)).toEqual({
      business_id: 'B', recipient_type: 'CONVERSATION', recipient: 'C', message_type: 'SHARE_POST', share_post: { item_id: 'V' },
    })
    expect(() => toDmMessage({ kind: 'native', provider: 'telegram', payload: {} }, dm)).toThrow(UnsupportedContentError)
  })
  it('rejects kinds TikTok DMs cannot carry', () => {
    for (const content of [
      { kind: 'audio', media: 'x' },
      { kind: 'document', media: 'x' },
      { kind: 'location', lat: 1, lng: 2 },
      { kind: 'poll', question: 'q', options: ['a'] },
      { kind: 'reaction', emoji: 'x', target: { id: '1', chatId: 'c' } },
      { kind: 'template', name: 'n', language: 'es' },
    ] satisfies OutboundContent[]) {
      expect(() => toDmMessage(content, dm)).toThrow(UnsupportedContentError)
    }
  })
})

describe('toCommentReply', () => {
  const target = { businessId: 'B', videoId: 'V', commentId: 'C' }
  it('builds a /business/comment/reply/create/ body', () => {
    expect(toCommentReply({ kind: 'text', text: 'Gracias!' }, target)).toEqual({ business_id: 'B', video_id: 'V', comment_id: 'C', text: 'Gracias!' })
  })
  it('rejects replies over 150 characters', () => {
    expect(() => toCommentReply({ kind: 'text', text: 'x'.repeat(151) }, target)).toThrow(PayloadTooLargeError)
    expect(toCommentReply({ kind: 'text', text: '😀'.repeat(150) }, target)).toMatchObject({ text: '😀'.repeat(150) })
  })
  it('only supports text (and native passthrough)', () => {
    expect(() => toCommentReply({ kind: 'image', media: 'x' }, target)).toThrow(UnsupportedContentError)
    // Buttons / lists degrade to a numbered text menu (within the 150-character limit).
    expect(toCommentReply({ kind: 'buttons', text: 't', buttons: [{ id: '1', title: 'a' }] }, target)).toMatchObject({ text: 't\n\n1) a' })
    expect(() => toCommentReply({ kind: 'buttons', text: 'x'.repeat(150), buttons: [{ id: '1', title: 'a' }] }, target)).toThrow(PayloadTooLargeError)
    expect(toCommentReply({ kind: 'native', provider: 'tiktok', payload: { image_uri: 'U', image_width: 1, image_height: 2 } }, target)).toEqual({
      business_id: 'B', video_id: 'V', comment_id: 'C', image_uri: 'U', image_width: 1, image_height: 2,
    })
  })
})

describe('toDirectReply', () => {
  it('builds a Comment-to-Message direct reply (text only)', () => {
    expect(toDirectReply({ kind: 'text', text: 'Te escribo por DM' }, { businessId: 'B', commentId: 'C' })).toEqual({
      business_id: 'B',
      direct_reply: { reply_type: 'COMMENT_REPLY', comment_reply: { comment_id: 'C' } },
      message_type: 'TEXT',
      text: { body: 'Te escribo por DM' },
    })
    expect(() => toDirectReply({ kind: 'image', media: 'x' }, { businessId: 'B', commentId: 'C' })).toThrow(UnsupportedContentError)
  })
})
