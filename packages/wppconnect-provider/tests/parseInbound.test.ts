import { describe, it, expect } from 'vitest'
import { parseWebhook, remoteOfMessageId, serializedId, lidsIn } from '../src/parseInbound.js'
import { WaIdentityStore } from '@bot-wa/wa-gateway-kit'
import { fixture } from './support/fake.js'

const PN = '573001112233@c.us'
const LID = '184523390222111@lid'
const GROUP = '120363041234567890@g.us'
const ctx = () => ({ identity: new WaIdentityStore(), selfId: '573009998877@c.us' })

describe('id helpers', () => {
  it('serializes WA-JS ids and extracts the chat of a message id', () => {
    expect(serializedId('x')).toBe('x')
    expect(serializedId({ _serialized: 'y' })).toBe('y')
    expect(serializedId({ user: '57', server: 'c.us' })).toBe('57@c.us')
    expect(remoteOfMessageId('false_573001112233@c.us_3EB0')).toBe(PN)
    expect(remoteOfMessageId('true_120363041234567890@g.us_3EB0_184523390222111@lid')).toBe(GROUP)
    expect(remoteOfMessageId({ remote: { _serialized: PN } })).toBe(PN)
  })

  it('lists every LID a payload references', () => {
    expect(lidsIn(fixture('onmessage-group-image')).sort()).toEqual(['184523390222111@lid', '184523390999999@lid'])
    expect(lidsIn(fixture('onmessage-text-dm'))).toEqual([])
  })
})

describe('parseWebhook — onmessage', () => {
  it('normalizes a DM text', () => {
    const [ev] = parseWebhook(fixture('onmessage-text-dm'), ctx())
    if (ev.kind !== 'message') throw new Error('expected message')
    expect(ev.message).toMatchObject({
      chatId: PN, senderId: PN, from: PN, sender: PN, type: 'text', body: 'hola', fromMe: false, isGroup: false,
      timestamp: 1760700000_000,
      chat: { id: PN, kind: 'dm', isGroup: false, isBroadcast: false },
      senderInfo: { id: PN, displayName: 'Andrés', platformData: { phoneNumber: PN, isBusiness: false } },
      ref: { id: 'false_573001112233@c.us_3EB0A1B2C3D4E5F60718', chatId: PN },
    })
  })

  it('links sender.phoneNumber to the LID', () => {
    const [ev] = parseWebhook(fixture('onmessage-lid-dm-with-pn'), ctx())
    if (ev.kind !== 'message') throw new Error('expected message')
    expect(ev.message.senderId).toBe(PN)
    expect(ev.message.chatId).toBe(PN)
    expect(ev.message.senderInfo.platformData).toMatchObject({ lid: LID, phoneNumber: PN })
  })

  it('normalizes a group image: caption as body (not the thumbnail), quote, mentions, media ref', () => {
    const c = ctx()
    c.identity.resolve(PN, LID)
    const [ev] = parseWebhook(fixture('onmessage-group-image'), c)
    if (ev.kind !== 'message') throw new Error('expected message')
    const m = ev.message
    expect(m).toMatchObject({ chatId: GROUP, senderId: PN, isGroup: true, type: 'image', body: 'mira esto @184523390999999' })
    expect(m.media).toMatchObject({ kind: 'image', mimetype: 'image/jpeg', size: 48211, token: { messageId: 'false_120363041234567890@g.us_3EB0C0FFEE0000000004_184523390222111@lid' } })
    expect(m.quoted).toMatchObject({ body: '¿alguien tiene la foto?', senderId: '184523390999999@lid', ref: { chatId: GROUP } })
    expect(m.mentions).toEqual(['184523390999999@lid'])
  })

  it('maps WA-JS types and skips system messages', () => {
    const base = fixture('onmessage-text-dm')
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ type: 'ptt', body: 'b64' }, 'voice', ''],
      [{ type: 'audio' }, 'audio', ''],
      [{ type: 'document', caption: 'doc', filename: 'a.pdf' }, 'document', 'doc'],
      [{ type: 'location', loc: 'Bogotá', lat: 4.6, lng: -74 }, 'location', 'Bogotá'],
      [{ type: 'vcard', vcardFormattedName: 'Ana' }, 'contact', 'Ana'],
      [{ type: 'poll_creation', pollName: '¿Color?' }, 'poll', '¿Color?'],
      [{ type: 'list_response', body: 'Opción 2' }, 'list', 'Opción 2'],
      [{ type: 'sticker' }, 'sticker', ''],
      [{ type: 'weird_new_type' }, 'unknown', ''],
    ]
    for (const [patch, type, body] of cases) {
      const [ev] = parseWebhook({ ...base, ...patch }, ctx())
      if (ev.kind !== 'message') throw new Error('expected message')
      expect([ev.message.type, ev.message.body]).toEqual([type, body])
    }
    expect(parseWebhook({ ...base, type: 'e2e_notification' }, ctx())).toEqual([])
    expect(parseWebhook({ ...base, chatId: 'status@broadcast', from: 'status@broadcast' }, ctx())).toEqual([])
  })

  it('uses selfId and the `to` chat for own messages', () => {
    const own = { ...fixture('onmessage-text-dm'), event: 'onselfmessage', fromMe: true, id: 'true_573001112233@c.us_X1', from: '573009998877@c.us', to: PN, chatId: undefined }
    const [ev] = parseWebhook(own, ctx())
    if (ev.kind !== 'message') throw new Error('expected message')
    expect(ev.message).toMatchObject({ fromMe: true, chatId: PN, senderId: '573009998877@c.us' })
  })
})

describe('parseWebhook — other events', () => {
  it('maps onack to a delivery status', () => {
    expect(parseWebhook(fixture('onack'), ctx())[0]).toMatchObject({
      kind: 'status', status: { status: 'read', ref: { id: 'true_573001112233@c.us_3EB0SENT0000000001', chatId: PN } },
    })
    expect(parseWebhook({ ...fixture('onack'), ack: -1 }, ctx())[0]).toMatchObject({ status: { status: 'failed' } })
    expect(parseWebhook({ ...fixture('onack'), ack: 0 }, ctx())).toEqual([])
  })

  it('maps reactions, calls, participants, status-find and qrcode', () => {
    expect(parseWebhook(fixture('onreactionmessage'), ctx())[0]).toMatchObject({
      kind: 'reaction', reaction: { emoji: '👍', senderId: PN, removed: false, ref: { id: 'true_573001112233@c.us_3EB0SENT0000000001', chatId: PN } },
    })
    expect(parseWebhook(fixture('incomingcall'), ctx())[0]).toEqual({ kind: 'call', event: { id: 'C0A1B2C3D4E5F6', from: PN, status: 'offer', isVideo: true } })
    const c = ctx()
    c.identity.resolve(PN, LID)
    expect(parseWebhook({ event: 'onparticipantschanged', session: 'my-bot', groupId: GROUP, action: 'remove', who: [LID] }, c)[0])
      .toEqual({ kind: 'group', event: { chatId: GROUP, action: 'remove', participants: [PN] } })
    expect(parseWebhook(fixture('status-find'), ctx())).toEqual([{ kind: 'connection', update: { state: 'ready' } }])
    expect(parseWebhook({ event: 'status-find', status: 'desconnectedMobile' }, ctx())[0]).toMatchObject({ update: { state: 'closed', reason: 'sessionInvalid' } })
    expect(parseWebhook(fixture('qrcode'), ctx())).toEqual([{ kind: 'connection', update: { state: 'authenticating', authPayload: '2@AbCdEf123,xyz,abc,def' } }])
    expect(parseWebhook({ event: 'onpresencechanged' }, ctx())).toEqual([])
  })
})
