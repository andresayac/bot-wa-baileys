import { describe, it, expect } from 'vitest'
import type { InboundEvent, InboundMessage } from '@botmesh/core'
import { inboundDedupeKey } from '@botmesh/core'
import { parseInbound } from '../src/parseInbound.js'
import { WA_TEXT } from './fixtures.js'

const SID = 'MM44444444444444444444444444444444'
const media = (i: number) => `https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/${SID}/Media/ME${i}`
const MMS = {
  ...WA_TEXT,
  MessageSid: SID,
  SmsMessageSid: SID,
  SmsSid: SID,
  Body: 'fotos del pedido',
  NumMedia: '3',
  MediaUrl0: media(0), MediaContentType0: 'image/jpeg',
  MediaUrl1: media(1), MediaContentType1: 'application/pdf',
  MediaUrl2: media(2), MediaContentType2: 'video/mp4',
}

const messages = (events: InboundEvent[]): InboundMessage[] =>
  events.map((e) => { if (e.kind !== 'message') throw new Error('expected messages'); return e.message })

describe('Twilio messages with several media (NumMedia > 1)', () => {
  it('emits one message per media item, in order', () => {
    const out = messages(parseInbound(MMS, () => 1).events)
    expect(out.map((m) => m.type)).toEqual(['image', 'document', 'video'])
    expect(out.map((m) => (m.media?.token as { url: string }).url)).toEqual([media(0), media(1), media(2)])
    expect(out.map((m) => m.media?.mimetype)).toEqual(['image/jpeg', 'application/pdf', 'video/mp4'])
  })

  it('the first keeps the MessageSid and the Body; the rest get unique, stable `sid:i` ids and no body', () => {
    const out = messages(parseInbound(MMS, () => 1).events)
    expect(out.map((m) => m.ref.id)).toEqual([SID, `${SID}:1`, `${SID}:2`])
    expect(out.map((m) => m.body)).toEqual(['fotos del pedido', '', ''])
    // A webhook retry yields the very same ids (dedupe drops it), and they never collide.
    const again = messages(parseInbound(MMS, () => 2).events)
    expect(again.map((m) => m.ref.id)).toEqual(out.map((m) => m.ref.id))
    const keys = parseInbound(MMS).events.map((e) => inboundDedupeKey(e)?.key)
    expect(new Set(keys).size).toBe(3)
  })

  it('every item shares chat, sender and raw params', () => {
    const out = messages(parseInbound(MMS).events)
    for (const m of out) {
      expect(m.chatId).toBe(MMS.From)
      expect(m.senderId).toBe(MMS.From)
      expect(m.raw).toBe(MMS)
    }
  })

  it('skips missing MediaUrl{i} slots and caps at Twilio\'s 10 media per message', () => {
    const gappy = { ...MMS, MediaUrl1: undefined, MediaContentType1: undefined }
    expect(messages(parseInbound(gappy as never).events).map((m) => m.ref.id)).toEqual([SID, `${SID}:2`])
    const many: Record<string, string> = { ...WA_TEXT, MessageSid: SID, NumMedia: '50' }
    for (let i = 0; i < 50; i++) { many[`MediaUrl${i}`] = media(i); many[`MediaContentType${i}`] = 'image/png' }
    expect(parseInbound(many).events).toHaveLength(10)
  })

  it('a single media message is unchanged (one event, MessageSid id)', () => {
    const one = { ...MMS, NumMedia: '1' }
    const out = messages(parseInbound(one).events)
    expect(out).toHaveLength(1)
    expect(out[0].ref.id).toBe(SID)
    expect(out[0].body).toBe('fotos del pedido')
  })
})
