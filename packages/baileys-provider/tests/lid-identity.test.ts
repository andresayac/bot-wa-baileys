import { describe, it, expect } from 'vitest'
import { IdentityStore } from '../src/identity.js'
import { toInbound } from '../src/toInbound.js'
import type { WAMessage } from '@whiskeysockets/baileys'

const dm = (opts: { remoteJid: string; remoteJidAlt?: string; id: string; body: string }): WAMessage =>
  ({
    key: { remoteJid: opts.remoteJid, remoteJidAlt: opts.remoteJidAlt, fromMe: false, id: opts.id },
    message: { conversation: opts.body },
    messageTimestamp: 1,
  } as unknown as WAMessage)

describe('IdentityStore (unit)', () => {
  it('canonicalises a learned LID to its PN, both argument orders', () => {
    const s = new IdentityStore()
    s.observe('999@lid', '573001@s.whatsapp.net')
    expect(s.canonical('999@lid')).toBe('573001@s.whatsapp.net')
    const s2 = new IdentityStore()
    s2.observe('573002@s.whatsapp.net', '888@lid')
    expect(s2.canonical('888@lid')).toBe('573002@s.whatsapp.net')
  })

  it('leaves unknown LIDs and plain PNs untouched; ignores incomplete pairs', () => {
    const s = new IdentityStore()
    expect(s.canonical('unknown@lid')).toBe('unknown@lid')
    expect(s.canonical('573003@s.whatsapp.net')).toBe('573003@s.whatsapp.net')
    s.observe('123@lid', null)
    expect(s.canonical('123@lid')).toBe('123@lid')
  })
})

describe('toInbound — LID/PN flip stability (the "flujos tienen líos" bug)', () => {
  it('keeps a stable PN chatId when the PN twin drops between messages', () => {
    const identity = new IdentityStore()
    const LID = '111111111111111@lid'
    const PN = '573002782284@s.whatsapp.net'

    const a = toInbound(dm({ remoteJid: LID, remoteJidAlt: PN, id: 'm1', body: 'registrar' }), identity)
    const b = toInbound(dm({ remoteJid: LID, id: 'm2', body: 'Andres' }), identity)
    const c = toInbound(dm({ remoteJid: PN, id: 'm3', body: 'andres@x.io' }), identity)

    expect(a.chatId).toBe(PN)
    expect(b.chatId).toBe(PN) // was the bug: bare LID keyed differently -> flow broke
    expect(c.chatId).toBe(PN)
    expect(new Set([a.chatId, b.chatId, c.chatId]).size).toBe(1)
  })
})
