import { describe, it, expect } from 'vitest'
import { parseUpdate } from '../src/parseInbound.js'
import type { TelegramUpdate } from '../src/types.js'

const privateChat = { id: 77, type: 'private' as const, first_name: 'Ana', username: 'ana' }
const ana = { id: 77, is_bot: false, first_name: 'Ana', username: 'ana' }

describe('parseUpdate', () => {
  it('parses a private text message', () => {
    const ev = parseUpdate({
      update_id: 1,
      message: { message_id: 10, date: 1_700_000_000, from: ana, chat: privateChat, text: 'hola bot' },
    })
    expect(ev?.kind).toBe('message')
    if (ev?.kind !== 'message') return
    const m = ev.message
    expect(m.chatId).toBe('77')
    expect(m.senderId).toBe('77')
    expect(m.from).toBe('77')
    expect(m.sender).toBe('77')
    expect(m.type).toBe('text')
    expect(m.body).toBe('hola bot')
    expect(m.chat.kind).toBe('dm')
    expect(m.isGroup).toBe(false)
    expect(m.timestamp).toBe(1_700_000_000_000) // seconds → ms
    expect(m.senderInfo.displayName).toBe('Ana')
    expect(m.senderInfo.username).toBe('ana')
    expect(m.ref.id).toBe('10')
    expect(m.ref.native).toEqual({ chat_id: 77, message_id: 10 })
    expect(m.fromMe).toBe(false)
  })

  it('marks fromMe when selfId matches the sender', () => {
    const ev = parseUpdate(
      { update_id: 1, message: { message_id: 1, date: 1, from: { id: 9, is_bot: true, first_name: 'B' }, chat: privateChat, text: 'x' } },
      '9',
    )
    if (ev?.kind === 'message') expect(ev.message.fromMe).toBe(true)
  })

  it('parses a photo (last size wins) with caption', () => {
    const ev = parseUpdate({
      update_id: 2,
      message: {
        message_id: 11, date: 1, from: ana, chat: privateChat,
        caption: 'mira',
        photo: [
          { file_id: 'small', width: 90, height: 90, file_size: 900 },
          { file_id: 'big', width: 1280, height: 720, file_size: 98_000 },
        ],
      },
    })
    if (ev?.kind !== 'message') throw new Error('expected message')
    expect(ev.message.type).toBe('image')
    expect(ev.message.body).toBe('mira')
    expect(ev.message.media).toMatchObject({ kind: 'image', token: 'big', size: 98_000 })
  })

  it('parses voice/document/sticker/location/contact/poll', () => {
    const mk = (fields: object): TelegramUpdate => ({
      update_id: 3,
      message: { message_id: 12, date: 1, from: ana, chat: privateChat, ...fields },
    })
    const voice = parseUpdate(mk({ voice: { file_id: 'v1', mime_type: 'audio/ogg', file_size: 10 } }))
    if (voice?.kind === 'message') {
      expect(voice.message.type).toBe('voice')
      expect(voice.message.media).toMatchObject({ kind: 'voice', token: 'v1', mimetype: 'audio/ogg' })
    }
    const doc = parseUpdate(mk({ document: { file_id: 'd1', file_name: 'a.pdf', mime_type: 'application/pdf' }, caption: 'doc' }))
    if (doc?.kind === 'message') {
      expect(doc.message.type).toBe('document')
      expect(doc.message.body).toBe('doc')
      expect(doc.message.media).toMatchObject({ token: 'd1', filename: 'a.pdf' })
    }
    const sticker = parseUpdate(mk({ sticker: { file_id: 's1', emoji: '🔥' } }))
    if (sticker?.kind === 'message') {
      expect(sticker.message.type).toBe('sticker')
      expect(sticker.message.body).toBe('🔥')
    }
    const loc = parseUpdate(mk({ location: { latitude: 4.7, longitude: -74.0 } }))
    if (loc?.kind === 'message') expect(loc.message.type).toBe('location')
    const contact = parseUpdate(mk({ contact: { phone_number: '573001', first_name: 'Soporte' } }))
    if (contact?.kind === 'message') {
      expect(contact.message.type).toBe('contact')
      expect(contact.message.body).toBe('Soporte 573001')
    }
    const poll = parseUpdate(mk({ poll: { id: 'p1', question: '¿Color?', options: [{ text: 'Rojo' }, { text: 'Azul' }] } }))
    if (poll?.kind === 'message') {
      expect(poll.message.type).toBe('poll')
      expect(poll.message.body).toBe('¿Color?')
    }
  })

  it('classifies supergroups as groups and channels as channels', () => {
    const group = parseUpdate({
      update_id: 4,
      message: { message_id: 1, date: 1, from: ana, chat: { id: -100_123, type: 'supergroup', title: 'Dev Team' }, text: 'hola' },
    })
    if (group?.kind === 'message') {
      expect(group.message.chat.kind).toBe('group')
      expect(group.message.isGroup).toBe(true)
      expect(group.message.chat.name).toBe('Dev Team')
      expect(group.message.chatId).toBe('-100123')
    }
    const channel = parseUpdate({
      update_id: 5,
      message: { message_id: 1, date: 1, chat: { id: -100_999, type: 'channel', title: 'News' }, text: 'post' },
    })
    if (channel?.kind === 'message') {
      expect(channel.message.chat.kind).toBe('channel')
      expect(channel.message.isBroadcast).toBe(true)
    }
  })

  it('extracts the quoted message (legacy reply_to_message)', () => {
    const ev = parseUpdate({
      update_id: 6,
      message: {
        message_id: 20, date: 1, from: ana, chat: privateChat, text: 'sí',
        reply_to_message: { message_id: 9, date: 1, from: { id: 55, first_name: 'Luis' }, chat: privateChat, text: '¿vienes?' },
      },
    })
    expect(ev?.kind).toBe('message')
    if (ev?.kind === 'message') {
      expect(ev.message.quoted?.ref?.id).toBe('9')
      expect(ev.message.quoted?.body).toBe('¿vienes?')
      expect(ev.message.quoted?.senderId).toBe('55')
    }
  })

  it('extracts the quoted message (Bot API 7 reply_to.message)', () => {
    const ev = parseUpdate({
      update_id: 7,
      message: {
        message_id: 21, date: 1, from: ana, chat: privateChat, text: 'ok',
        reply_to: { message: { message_id: 8, date: 1, from: { id: 55 }, chat: privateChat, caption: 'foto' } },
      },
    })
    expect(ev?.kind).toBe('message')
    if (ev?.kind === 'message') {
      expect(ev.message.quoted?.ref?.id).toBe('8')
      expect(ev.message.quoted?.body).toBe('foto')
    }
  })

  it('parses a callback_query into an interaction', () => {
    const ev = parseUpdate({
      update_id: 8,
      callback_query: {
        id: 'cq-1',
        from: ana,
        chat_instance: 'ci',
        data: 'btn_yes',
        message: { message_id: 30, date: 1_700_000_000, from: { id: 9, is_bot: true }, chat: privateChat },
      },
    })
    expect(ev?.kind).toBe('interaction')
    if (ev?.kind !== 'interaction') return
    const i = ev.interaction
    expect(i.interactionId).toBe('cq-1')
    expect(i.kind).toBe('button')
    expect(i.data).toBe('btn_yes')
    expect(i.chatId).toBe('77')
    expect(i.senderId).toBe('77')
    expect(i.ref.id).toBe('30')
    expect(i.timestamp).toBe(1_700_000_000_000)
  })

  it('collects text_mention users into mentions', () => {
    const ev = parseUpdate({
      update_id: 9,
      message: {
        message_id: 40, date: 1, from: ana, chat: privateChat, text: 'hola amigo',
        entities: [{ type: 'text_mention', offset: 5, length: 5, user: { id: 321, first_name: 'Beto' } }],
      },
    })
    if (ev?.kind === 'message') expect(ev.message.mentions).toEqual(['321'])
  })

  it('returns undefined for unsupported update kinds (channel_post)', () => {
    expect(parseUpdate({ update_id: 10, channel_post: { message_id: 1, date: 1, chat: { id: -1, type: 'channel' }, text: 'x' } })).toBeUndefined()
  })
})
