import { describe, it, expect } from 'vitest'
import { isPnUser, isLidUser, normalizeInboundKey } from '../src/utils/jid.js'
import { createTestBot } from '../src/testing/createTestBot.js'
import type { MessageContext } from '../src/core/types.js'

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

describe('senderInfo derivation (context.ts wiring)', () => {
  it('group message with LID participant: senderInfo carries PN id + raw lid', async () => {
    const { bot, provider } = await createTestBot()
    let captured: MessageContext | undefined
    bot.onMessage(async (ctx) => { captured = ctx })
    provider.incoming('hola grupo', {
      from: 'g@g.us',
      participant: '99@lid',
      participantAlt: '573002@s.whatsapp.net',
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(captured).toBeDefined()
    expect(captured!.sender).toBe('573002@s.whatsapp.net')
    expect(captured!.senderInfo.id).toBe(captured!.sender)
    expect(captured!.senderInfo.phoneNumber).toBe('573002@s.whatsapp.net')
    expect(captured!.senderInfo.lid).toBe('99@lid')
  })
})
