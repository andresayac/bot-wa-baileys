/**
 * toInbound content mapping: wrapped payloads (disappearing / view-once /
 * documents with caption), reply context on non-text messages, quoted refs and
 * protobuf `Long` timestamps.
 */
import { describe, it, expect } from 'vitest'
import type { WAMessage } from '@whiskeysockets/baileys'
import { IdentityStore } from '../src/identity.js'
import { toInbound } from '../src/toInbound.js'

const PN = '573001112233@s.whatsapp.net'
const LID = '111222333444555@lid'
const GROUP = '120363000000000000@g.us'

const msg = (message: Record<string, unknown>, extra: Record<string, unknown> = {}): WAMessage =>
  ({ key: { remoteJid: PN, fromMe: false, id: 'M1' }, message, messageTimestamp: 1_700_000_000, ...extra } as unknown as WAMessage)

describe('toInbound — wrapped message content', () => {
  it('unwraps a disappearing-mode (ephemeral) text', () => {
    const m = toInbound(msg({ ephemeralMessage: { message: { extendedTextMessage: { text: 'hola' } } } }), new IdentityStore())
    expect(m.type).toBe('text')
    expect(m.body).toBe('hola')
  })

  it('unwraps a view-once image and keeps its caption and media ref', () => {
    const m = toInbound(msg({ viewOnceMessageV2: { message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } } } }), new IdentityStore())
    expect(m.type).toBe('image')
    expect(m.body).toBe('look')
    expect(m.media).toMatchObject({ kind: 'image', mimetype: 'image/jpeg' })
  })

  it('reads a document sent with a caption (documentWithCaptionMessage)', () => {
    const m = toInbound(msg({
      documentWithCaptionMessage: { message: { documentMessage: { caption: 'invoice', fileName: 'a.pdf', mimetype: 'application/pdf' } } },
    }), new IdentityStore())
    expect(m.type).toBe('document')
    expect(m.body).toBe('invoice')
    expect(m.media).toMatchObject({ kind: 'document', filename: 'a.pdf', mimetype: 'application/pdf' })
  })

  it('maps a voice note media ref to the audio part', () => {
    const m = toInbound(msg({ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } }), new IdentityStore())
    expect(m.type).toBe('voice')
    expect(m.media).toMatchObject({ kind: 'voice', mimetype: 'audio/ogg; codecs=opus' })
  })
})

describe('toInbound — reply context', () => {
  it('reads the quoted message and mentions from an image caption', () => {
    const identity = new IdentityStore()
    identity.observe(LID, PN)
    const m = toInbound(msg({
      imageMessage: {
        caption: 'this one @x',
        contextInfo: { stanzaId: 'ORIG', participant: LID, quotedMessage: { conversation: 'original' }, mentionedJid: [LID] },
      },
    }, { key: { remoteJid: GROUP, participant: '573009998877@s.whatsapp.net', fromMe: false, id: 'M2' } }), identity)
    expect(m.quoted).toMatchObject({ body: 'original', senderId: PN })
    expect(m.mentions).toEqual([PN])
  })

  it('carries a ref to the quoted message that can be replied to', () => {
    const m = toInbound(msg({
      extendedTextMessage: { text: 'reply', contextInfo: { stanzaId: 'ORIG', participant: PN, quotedMessage: { conversation: 'original' } } },
    }), new IdentityStore())
    expect(m.quoted?.ref).toMatchObject({ id: 'ORIG', chatId: PN })
    const native = m.quoted?.ref?.native as { key?: Record<string, unknown>; message?: unknown }
    expect(native.key).toMatchObject({ id: 'ORIG', remoteJid: PN })
    expect(native.message).toEqual({ conversation: 'original' })
  })

  it('reads the quoted caption of a quoted image', () => {
    const m = toInbound(msg({
      extendedTextMessage: { text: 'reply', contextInfo: { stanzaId: 'ORIG', quotedMessage: { imageMessage: { caption: 'pic' } } } },
    }), new IdentityStore())
    expect(m.quoted?.body).toBe('pic')
  })
})

describe('toInbound — timestamps', () => {
  it('converts a protobuf Long timestamp to a plain number', () => {
    const long = { low: 1_700_000_000, high: 0, unsigned: true, toNumber: () => 1_700_000_000 }
    const m = toInbound(msg({ conversation: 'x' }, { messageTimestamp: long }), new IdentityStore())
    expect(m.timestamp).toBe(1_700_000_000)
    expect(typeof m.timestamp).toBe('number')
  })
})

describe('toInbound — location, contact and template replies', () => {
  it('maps a static location and uses its name as body', () => {
    const m = toInbound(msg({ locationMessage: { degreesLatitude: 4.6, degreesLongitude: -74.1, name: 'Panadería', address: 'Calle 1' } }), new IdentityStore())
    expect(m.type).toBe('location')
    expect(m.body).toBe('Panadería')
  })

  it('falls back to the address when a location has no name', () => {
    const m = toInbound(msg({ locationMessage: { address: 'Calle 1' } }), new IdentityStore())
    expect(m.body).toBe('Calle 1')
  })

  it('maps a live location to location', () => {
    const m = toInbound(msg({ liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }), new IdentityStore())
    expect(m.type).toBe('location')
    expect(m.body).toBe('')
  })

  it('maps a single contact card with its display name', () => {
    const m = toInbound(msg({ contactMessage: { displayName: 'Ana', vcard: 'BEGIN:VCARD' } }), new IdentityStore())
    expect(m.type).toBe('contact')
    expect(m.body).toBe('Ana')
  })

  it('maps a contacts array to contact', () => {
    const m = toInbound(msg({ contactsArrayMessage: { displayName: '2 contacts', contacts: [{ displayName: 'A' }, { displayName: 'B' }] } }), new IdentityStore())
    expect(m.type).toBe('contact')
    expect(m.body).toBe('2 contacts')
  })

  it('maps a template button reply to buttons with the selected text', () => {
    const m = toInbound(msg({ templateButtonReplyMessage: { selectedId: 'b1', selectedDisplayText: 'Sí' } }), new IdentityStore())
    expect(m.type).toBe('buttons')
    expect(m.body).toBe('Sí')
  })
})
