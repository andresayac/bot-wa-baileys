import { describe, it, expect } from 'vitest'
import { parseWebhook } from '../src/parseInbound.js'
import { WaIdentityStore } from '@botmesh/wa-gateway-kit'

const PN = '573001112233@s.whatsapp.net'
const ctx = () => ({ identity: new WaIdentityStore(), selfId: '573009998877@s.whatsapp.net' })
const upsert = (message: Record<string, unknown>) => ({
  event: 'messages.upsert',
  instance: 'bot',
  data: { key: { remoteJid: PN, fromMe: false, id: 'W1' }, pushName: 'Ana', message, messageTimestamp: 1760700000 },
})

describe('parseWebhook — wrapped Baileys content', () => {
  it('unwraps a disappearing-mode (ephemeral) text', () => {
    const [ev] = parseWebhook(upsert({ ephemeralMessage: { message: { extendedTextMessage: { text: 'hola' } } } }), ctx())
    if (ev?.kind !== 'message') throw new Error('expected message')
    expect(ev.message).toMatchObject({ type: 'text', body: 'hola' })
  })

  it('unwraps a view-once image and keeps the reply context', () => {
    const [ev] = parseWebhook(upsert({
      viewOnceMessageV2: { message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg', contextInfo: { stanzaId: 'ORIG', quotedMessage: { conversation: 'q' } } } } },
    }), ctx())
    if (ev?.kind !== 'message') throw new Error('expected message')
    expect(ev.message).toMatchObject({ type: 'image', body: 'look', media: { kind: 'image', mimetype: 'image/jpeg' } })
    expect(ev.message.quoted?.ref?.id).toBe('ORIG')
  })

  it('keeps inline base64 media on the token of a wrapped message', () => {
    const [ev] = parseWebhook(upsert({ ephemeralMessage: { message: { audioMessage: { ptt: true } } }, base64: 'AAAA' }), ctx())
    if (ev?.kind !== 'message') throw new Error('expected message')
    expect(ev.message.type).toBe('voice')
    expect(ev.message.media?.token).toMatchObject({ base64: 'AAAA' })
  })
})

describe('parseWebhook — wrapped protocol payloads', () => {
  it('drops a protocol message inside a disappearing-mode envelope', () => {
    expect(parseWebhook(upsert({ ephemeralMessage: { message: { protocolMessage: { type: 3 } } } }), ctx())).toEqual([])
  })
})
