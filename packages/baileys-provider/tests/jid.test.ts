import { describe, it, expect } from 'vitest'
import { isPnUser, isLidUser, normalizeInboundKey } from '../src/jid.js'
import { toInbound } from '../src/toInbound.js'
import { IdentityStore } from '../src/identity.js'
import type { WAMessage } from '@whiskeysockets/baileys'

describe('jid identity', () => {
  it('classifies pn and lid jids', () => {
    expect(isPnUser('573001112233@s.whatsapp.net')).toBe(true)
    expect(isLidUser('123456@lid')).toBe(true)
    expect(isPnUser('123456@lid')).toBe(false)
  })

  it('DM: prefers remoteJidAlt (PN) when remoteJid is LID', () => {
    const r = normalizeInboundKey({ remoteJid: '99@lid', remoteJidAlt: '5730011@s.whatsapp.net' }, false)
    expect(r.chat).toBe('5730011@s.whatsapp.net')
    expect(r.sender).toBe('5730011@s.whatsapp.net')
  })

  it('DM: keeps remoteJid when already PN', () => {
    const r = normalizeInboundKey({ remoteJid: '5730011@s.whatsapp.net' }, false)
    expect(r.chat).toBe('5730011@s.whatsapp.net')
  })

  it('group: chat is group jid, sender prefers participantAlt', () => {
    const r = normalizeInboundKey(
      { remoteJid: 'g@g.us', participant: '99@lid', participantAlt: '573002@s.whatsapp.net' }, true)
    expect(r.chat).toBe('g@g.us')
    expect(r.sender).toBe('573002@s.whatsapp.net')
  })
})

describe('toInbound — senderInfo derivation', () => {
  it('group message with LID participant: sender is PN, platformData carries raw lid', () => {
    const msg = {
      key: { remoteJid: 'g@g.us', participant: '99@lid', participantAlt: '573002@s.whatsapp.net', fromMe: false, id: 'm1' },
      message: { conversation: 'hola grupo' },
      pushName: 'Ada',
      messageTimestamp: 1,
    } as unknown as WAMessage

    const ctx = toInbound(msg, new IdentityStore())
    expect(ctx.isGroup).toBe(true)
    expect(ctx.chatId).toBe('g@g.us')
    expect(ctx.sender).toBe('573002@s.whatsapp.net')
    expect(ctx.senderInfo.id).toBe(ctx.sender)
    expect(ctx.senderInfo.platformData?.phoneNumber).toBe('573002@s.whatsapp.net')
    expect(ctx.senderInfo.platformData?.lid).toBe('99@lid')
  })
})
