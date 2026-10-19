/**
 * `quoted.senderId` follows the same identity contract as `senderId` and
 * `mentions`: a reply's contextInfo carries the quoted author as a raw JID
 * (a LID in LID-addressed groups, sometimes device-qualified), which must be
 * canonicalised (learned LID → PN, device stripped) before it reaches core.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WAMessage } from '@whiskeysockets/baileys'

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  const { fakeMakeWASocket } = await import('./support/harness.js')
  return { ...actual, default: fakeMakeWASocket, makeCacheableSignalKeyStore: (keys: unknown) => keys }
})

const { BaileysProvider } = await import('../src/BaileysProvider.js')
const { connect, ME_LID, ME_PN } = await import('./support/harness.js')

const GROUP = '120363000000000000@g.us'
const MEMBER_LID = '500000000000001@lid'
const MEMBER_PN = '573006666666@s.whatsapp.net'
const OTHER_LID = '500000000000002@lid'
const OTHER_PN = '573007777777@s.whatsapp.net'
const STRANGER_LID = '500000000000009@lid'

let seq = 0
const reply = (quotedAuthor: string, body = 'reply'): WAMessage => ({
  key: { remoteJid: GROUP, fromMe: false, id: `Q-${++seq}`, participant: MEMBER_LID, participantAlt: MEMBER_PN },
  message: {
    extendedTextMessage: {
      text: body,
      contextInfo: { stanzaId: 'ORIG', participant: quotedAuthor, quotedMessage: { conversation: 'original' } },
    },
  },
  messageTimestamp: 1,
} as unknown as WAMessage)

const upsert = (messages: WAMessage[]) => ({ 'messages.upsert': { type: 'notify', messages } })
const quotedOf = (h: Awaited<ReturnType<typeof connect>>) => h.ofKind('message').map((e) => e.message.quoted)

describe('quoted.senderId identity', () => {
  it('maps a learned LID to its PN, like the message sender', async () => {
    const h = await connect(BaileysProvider)
    await h.emit(upsert([reply(MEMBER_LID)])) // the key teaches MEMBER_LID ↔ MEMBER_PN
    expect(quotedOf(h)).toMatchObject([{ body: 'original', senderId: MEMBER_PN, ref: { id: 'ORIG', chatId: GROUP } }])
    expect(h.ofKind('message')[0]?.message.senderId).toBe(MEMBER_PN)
  })

  it('maps the bot\'s own LID to selfId, so "is this a reply to me" works', async () => {
    const h = await connect(BaileysProvider)
    await h.emit(upsert([reply(ME_LID)]))
    expect(quotedOf(h)[0]?.senderId).toBe(ME_PN)
    expect(quotedOf(h)[0]?.senderId).toBe(h.provider.selfId)
  })

  it('strips a device suffix from a PN author', async () => {
    const h = await connect(BaileysProvider)
    await h.emit(upsert([reply('573007777777:5@s.whatsapp.net')]))
    expect(quotedOf(h)[0]?.senderId).toBe(OTHER_PN)
  })

  it('resolves a bare LID author through the signal LID mapping store', async () => {
    const h = await connect(BaileysProvider)
    h.sock.lidMap.set(OTHER_LID, '573007777777:2@s.whatsapp.net')
    await h.emit(upsert([reply(OTHER_LID)]))
    expect(quotedOf(h)[0]?.senderId).toBe(OTHER_PN)
  })

  it('leaves an unknown LID as is (best effort, stabilises once learned)', async () => {
    const h = await connect(BaileysProvider)
    await h.emit(upsert([reply(STRANGER_LID)]))
    expect(quotedOf(h)[0]?.senderId).toBe(STRANGER_LID)
  })
})
