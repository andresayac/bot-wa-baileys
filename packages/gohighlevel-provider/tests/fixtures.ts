/** Webhook fixtures shaped like HighLevel's documented `InboundMessage` payloads. */

import { generateKeyPairSync, sign } from 'node:crypto'

export const LOCATION = 'l1C08ntBrFjLS0elLIYU'

export const SMS_INBOUND = {
  type: 'InboundMessage',
  locationId: LOCATION,
  attachments: [],
  body: 'hola',
  contactId: 'cI08i1Bls3iTB9bKgFJh',
  contentType: 'text/plain',
  conversationId: 'fcanlLgpbQgQhderivVs',
  dateAdded: '2021-04-21T11:31:45.750Z',
  direction: 'inbound',
  messageType: 'SMS',
  messageId: 'msg-sms-1',
  status: 'delivered',
  from: '+15551234567',
  to: '+15559876543',
  messageTypeId: 2,
  messageTypeString: 'TYPE_SMS',
}

export const WHATSAPP_IMAGE = {
  ...SMS_INBOUND,
  body: 'mira',
  messageType: 'WhatsApp',
  messageTypeString: 'TYPE_WHATSAPP',
  messageId: 'msg-wa-2',
  attachments: ['https://storage.googleapis.com/msgsndr/abc/media/photo.jpg'],
}

export const CALL_INBOUND = {
  type: 'InboundMessage',
  locationId: LOCATION,
  attachments: ['https://example.com/recording.mp3'],
  contactId: 'cI08i1Bls3iTB9bKgFJh',
  conversationId: 'SGDqZrzmwTr19d10aHkt9F',
  dateAdded: '2024-05-08T11:57:42.250Z',
  direction: 'inbound',
  messageType: 'CALL',
  messageId: 'call-1',
  status: 'completed',
  callDuration: 120,
  callStatus: 'completed',
  messageTypeId: 1,
  messageTypeString: 'TYPE_CALL',
}

export const OUTBOUND_ECHO = { ...SMS_INBOUND, type: 'OutboundMessage', direction: 'outbound', messageId: 'msg-out' }

export function keys() {
  const ed = generateKeyPairSync('ed25519')
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    publicKey: ed.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    legacyPublicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signEd: (raw: string) => sign(null, Buffer.from(raw), ed.privateKey).toString('base64'),
    signRsa: (raw: string) => sign('sha256', Buffer.from(raw), rsa.privateKey).toString('base64'),
  }
}
