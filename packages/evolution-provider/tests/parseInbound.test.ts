import { describe, it, expect } from 'vitest'
import { parseWebhook, normalizeEventName } from '../src/parseInbound.js'
import { WaIdentityStore } from '@botmesh/wa-gateway-kit'
import { fixture } from './support/fake.js'

const PN = '573001112233@s.whatsapp.net'
const LID = '184523390222111@lid'
const GROUP = '120363041234567890@g.us'
const ctx = () => ({ identity: new WaIdentityStore(), selfId: '573009998877@s.whatsapp.net' })

describe('normalizeEventName', () => {
  it('accepts every Evolution spelling', () => {
    expect(normalizeEventName('MESSAGES_UPSERT')).toBe('messages.upsert')
    expect(normalizeEventName('messages-upsert')).toBe('messages.upsert')
    expect(normalizeEventName('messages.upsert')).toBe('messages.upsert')
  })
})

describe('parseWebhook — messages.upsert', () => {
  it('normalizes a DM text', () => {
    const [ev] = parseWebhook(fixture('messages-upsert-text-dm'), ctx())
    expect(ev.kind).toBe('message')
    if (ev.kind !== 'message') return
    const m = ev.message
    expect(m).toMatchObject({
      chatId: PN, from: PN, senderId: PN, sender: PN, type: 'text', body: 'hola',
      isGroup: false, fromMe: false, timestamp: 1760700000_000,
      chat: { id: PN, kind: 'dm', isGroup: false, isBroadcast: false },
      senderInfo: { id: PN, displayName: 'Andrés' },
    })
    expect(m.ref).toMatchObject({ id: '3EB0A1B2C3D4E5F60718', chatId: PN })
  })

  it('maps a LID-addressed DM to the PN from senderPn', () => {
    const [ev] = parseWebhook(fixture('messages-upsert-lid-senderpn'), ctx())
    if (ev.kind !== 'message') throw new Error('expected message')
    expect(ev.message.senderId).toBe(PN)
    expect(ev.message.chatId).toBe(PN)
    expect(ev.message.body).toBe('quiero el menú')
    expect(ev.message.timestamp).toBe(1760700060_000)
    expect(ev.message.senderInfo.platformData).toMatchObject({ lid: LID, phoneNumber: PN })
  })

  it('normalizes a group image with quote, mentions and a media ref', () => {
    const [ev] = parseWebhook(fixture('messages-upsert-group-image'), ctx())
    if (ev.kind !== 'message') throw new Error('expected message')
    const m = ev.message
    expect(m).toMatchObject({ chatId: GROUP, senderId: PN, isGroup: true, type: 'image', body: 'mira esto @184523390999999' })
    expect(m.chat.kind).toBe('group')
    expect(m.media).toMatchObject({ kind: 'image', mimetype: 'image/jpeg', size: 48211 })
    expect((m.media!.token as { key: { id: string } }).key.id).toBe('3EB0C0FFEE0000000004')
    expect(m.quoted).toMatchObject({ body: '¿alguien tiene la foto?', ref: { id: '3EB0PREVIOUS000000001', chatId: GROUP } })
    expect(m.mentions).toEqual(['184523390999999@lid'])
  })

  it('emits a reaction event for reactionMessage', () => {
    const [ev] = parseWebhook(fixture('messages-upsert-reaction'), ctx())
    expect(ev).toMatchObject({ kind: 'reaction', reaction: { emoji: '👍', senderId: PN, removed: false, ref: { id: 'BAE5SENT0000000001', chatId: PN } } })
  })

  it('skips status broadcasts and protocol-only messages', () => {
    const status = fixture('messages-upsert-text-dm')
    status.data.key.remoteJid = 'status@broadcast'
    expect(parseWebhook(status, ctx())).toEqual([])
    const proto = fixture('messages-upsert-text-dm')
    proto.data.message = { protocolMessage: { type: 0 } }
    expect(parseWebhook(proto, ctx())).toEqual([])
  })

  it('uses selfId as sender of fromMe messages', () => {
    const own = fixture('messages-upsert-text-dm')
    own.data.key.fromMe = true
    const [ev] = parseWebhook(own, ctx())
    if (ev.kind !== 'message') throw new Error('expected message')
    expect(ev.message.fromMe).toBe(true)
    expect(ev.message.senderId).toBe('573009998877@s.whatsapp.net')
    expect(ev.message.chatId).toBe(PN)
  })

  it('ignores sender twins of fromMe DMs (they describe the bot, not the peer)', () => {
    const c = ctx()
    const own = fixture('messages-upsert-lid-only')
    own.data.key.fromMe = true
    own.data.key.senderPn = '573009998877@s.whatsapp.net'
    const [ev] = parseWebhook(own, c)
    if (ev.kind !== 'message') throw new Error('expected message')
    expect(ev.message.chatId).toBe(LID)
    const [next] = parseWebhook(fixture('messages-upsert-lid-only'), c)
    if (next.kind !== 'message') throw new Error('expected message')
    expect(next.message.senderId).toBe(LID)
  })

  it('accepts an array of messages in data', () => {
    const one = fixture('messages-upsert-text-dm')
    const two = fixture('messages-upsert-lid-only')
    const events = parseWebhook({ event: 'MESSAGES_UPSERT', data: [one.data, two.data] }, ctx())
    expect(events).toHaveLength(2)
  })

  it('classifies media and interactive replies', () => {
    const base = fixture('messages-upsert-text-dm')
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } }, 'voice', ''],
      [{ audioMessage: { ptt: false } }, 'audio', ''],
      [{ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'a.pdf', caption: 'doc' } } } }, 'document', 'doc'],
      [{ locationMessage: { degreesLatitude: 4.6, degreesLongitude: -74.08, name: 'Bogotá' } }, 'location', 'Bogotá'],
      [{ contactMessage: { displayName: 'Ana', vcard: 'BEGIN:VCARD' } }, 'contact', 'Ana'],
      [{ pollCreationMessageV3: { name: '¿Color?', options: [] } }, 'poll', '¿Color?'],
      [{ listResponseMessage: { title: 'Opción 2' } }, 'list', 'Opción 2'],
      [{ buttonsResponseMessage: { selectedDisplayText: 'Sí' } }, 'buttons', 'Sí'],
      [{ stickerMessage: { mimetype: 'image/webp' } }, 'sticker', ''],
    ]
    for (const [message, type, body] of cases) {
      base.data.message = message
      const [ev] = parseWebhook(base, ctx())
      if (ev.kind !== 'message') throw new Error('expected message')
      expect([ev.message.type, ev.message.body]).toEqual([type, body])
    }
  })
})

describe('parseWebhook — locations', () => {
  it('fills message.location from locationMessage and liveLocationMessage', () => {
    const base = fixture('messages-upsert-text-dm')
    base.data.message = { locationMessage: { degreesLatitude: 4.6, degreesLongitude: -74.08, name: 'Bogotá', address: 'Cra 7' } }
    const [ev] = parseWebhook(base, ctx())
    if (ev.kind !== 'message') throw new Error('expected message')
    expect(ev.message.location).toEqual({ latitude: 4.6, longitude: -74.08, name: 'Bogotá', address: 'Cra 7' })
    base.data.message = { liveLocationMessage: { degreesLatitude: '4.6', degreesLongitude: '-74.08' } }
    const [live] = parseWebhook(base, ctx())
    if (live.kind !== 'message') throw new Error('expected message')
    expect(live.message.location).toEqual({ latitude: 4.6, longitude: -74.08, live: true })
    base.data.message = { conversation: 'hola' }
    const [text] = parseWebhook(base, ctx())
    if (text.kind !== 'message') throw new Error('expected message')
    expect(text.message.location).toBeUndefined()
  })
})

describe('parseWebhook — other events', () => {
  it('maps messages.update to a delivery status', () => {
    const [ev] = parseWebhook(fixture('messages-update'), ctx())
    expect(ev).toMatchObject({ kind: 'status', status: { status: 'read', ref: { id: 'BAE5SENT0000000001', chatId: PN } } })
  })

  it('maps connection.update and qrcode.updated', () => {
    expect(parseWebhook(fixture('connection-update-open'), ctx())).toEqual([{ kind: 'connection', update: { state: 'ready' } }])
    expect(parseWebhook(fixture('connection-update-close'), ctx())[0]).toMatchObject({ kind: 'connection', update: { state: 'closed', reason: 'sessionInvalid' } })
    expect(parseWebhook(fixture('qrcode-updated'), ctx())[0]).toMatchObject({ kind: 'connection', update: { state: 'authenticating', authPayload: '2@AbCdEf123,xyz,abc,def' } })
  })

  it('maps call and group participant events', () => {
    expect(parseWebhook(fixture('call'), ctx())[0]).toMatchObject({ kind: 'call', event: { id: 'C0A1B2C3D4E5F6', from: PN, status: 'offer', isVideo: false } })
    const c = ctx()
    c.identity.resolve(LID, PN)
    const [g] = parseWebhook({ event: 'GROUP_PARTICIPANTS_UPDATE', data: { id: GROUP, participants: [LID], action: 'add' } }, c)
    expect(g).toMatchObject({ kind: 'group', event: { chatId: GROUP, action: 'add', participants: [PN] } })
  })

  it('ignores unknown events', () => {
    expect(parseWebhook({ event: 'chats.upsert', data: [{ id: PN }] }, ctx())).toEqual([])
  })
})
