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

describe('parseUpdate — never emits empty ids', () => {
  const nonEmpty = (ev: ReturnType<typeof parseUpdate>) => {
    if (!ev || (ev.kind !== 'message' && ev.kind !== 'interaction')) throw new Error('expected message/interaction')
    const e = ev.kind === 'message' ? ev.message : ev.interaction
    expect(e.chatId).not.toBe('')
    expect(e.senderId).not.toBe('')
    expect(e.ref.id).not.toBe('')
    expect(e.ref.chatId).not.toBe('')
    expect(e.chat.id).not.toBe('')
    return e
  }

  it('inline-mode callback_query (inline_message_id, no message) routes to the user chat', () => {
    const ev = parseUpdate({
      update_id: 100,
      callback_query: { id: 'cq-inline', from: ana, chat_instance: 'ci', data: 'vote:1', inline_message_id: 'AAQx-inline' },
    })
    expect(ev?.kind).toBe('interaction')
    const i = nonEmpty(ev)
    if (ev?.kind !== 'interaction') return
    expect(i.chatId).toBe('77')
    expect(i.senderId).toBe('77')
    expect(i.chat.kind).toBe('dm')
    expect(i.chat.name).toBe('Ana')
    expect(i.ref).toEqual({ id: 'AAQx-inline', chatId: '77', native: { inline_message_id: 'AAQx-inline' } })
    expect(ev.interaction.data).toBe('vote:1')
    expect(ev.interaction.timestamp).toBeGreaterThan(0)
  })

  it('callback_query on an InaccessibleMessage (date 0) keeps its chat and a real timestamp', () => {
    const before = Date.now()
    const ev = parseUpdate({
      update_id: 101,
      callback_query: { id: 'cq-old', from: ana, data: 'x', message: { message_id: 5, date: 0, chat: { id: -100_5, type: 'supergroup', title: 'G' } } },
    })
    nonEmpty(ev)
    if (ev?.kind !== 'interaction') return
    expect(ev.interaction.chatId).toBe('-1005')
    expect(ev.interaction.ref.id).toBe('5')
    expect(ev.interaction.timestamp).toBeGreaterThanOrEqual(before)
  })

  it('callback_query without message or inline_message_id synthesizes a stable ref id from update_id', () => {
    const ev = parseUpdate({ update_id: 102, callback_query: { id: 'cq-game', from: ana, game_short_name: 'g' } })
    const i = nonEmpty(ev)
    expect(i.chatId).toBe('77')
    expect(i.ref.id).toBe('upd:102')
  })

  it('drops malformed callback_query without from / id, and messages without chat', () => {
    expect(parseUpdate({ update_id: 103, callback_query: { id: 'cq', data: 'x' } as never })).toBeUndefined()
    expect(parseUpdate({ update_id: 104, callback_query: { from: ana, data: 'x' } as never })).toBeUndefined()
    expect(parseUpdate({ update_id: 105, message: { message_id: 1, date: 1, from: ana, text: 'x' } as never })).toBeUndefined()
  })

  it('ephemeral messages (message_id 0) use ephemeral_message_id, not a shared "0"', () => {
    const ev = parseUpdate({
      update_id: 106,
      message: { message_id: 0, ephemeral_message_id: 55, date: 1, from: ana, chat: privateChat, text: 'psst' },
    })
    const m = nonEmpty(ev)
    expect(m.ref.id).toBe('eph:55')
    expect(m.ref.native).toEqual({ chat_id: 77, ephemeral_message_id: 55 })
  })

  it('a message with no usable message_id falls back to update_id', () => {
    const ev = parseUpdate({ update_id: 107, message: { date: 1, from: ana, chat: privateChat, text: 'x' } as never })
    expect(nonEmpty(ev).ref.id).toBe('upd:107')
  })

  it('edited_message keeps the original id (core dedupe fingerprints the edit)', () => {
    const ev = parseUpdate({ update_id: 108, edited_message: { message_id: 12, date: 1, from: ana, chat: privateChat, text: 'fixed' } })
    expect(nonEmpty(ev).ref.id).toBe('12')
  })

  it('a message sent on behalf of a chat (anonymous admin / linked channel) is keyed by sender_chat, not the fake from', () => {
    const group = { id: -100_42, type: 'supergroup' as const, title: 'Team' }
    const ev = parseUpdate({
      update_id: 109,
      message: {
        message_id: 3, date: 1, chat: group, text: 'hi',
        from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
        sender_chat: group,
      },
    })
    const m = nonEmpty(ev)
    expect(m.senderId).toBe('-10042')
    expect(m.senderInfo.displayName).toBe('Team')
  })

  it('a message with neither from nor sender_chat falls back to the chat id', () => {
    const ev = parseUpdate({ update_id: 110, message: { message_id: 4, date: 1, chat: { id: -100_7, type: 'channel', title: 'C' }, text: 'x' } })
    expect(nonEmpty(ev).senderId).toBe('-1007')
  })

  it('a quoted ephemeral reply without a usable id is omitted rather than given an empty/zero id', () => {
    const ev = parseUpdate({
      update_id: 111,
      message: { message_id: 9, date: 1, from: ana, chat: privateChat, text: 'ok', reply_to_message: { message_id: 0, chat: privateChat, text: 'e' } },
    })
    if (ev?.kind !== 'message') throw new Error('expected message')
    expect(ev.message.quoted?.ref).toBeUndefined()
  })

  it('still ignores business_message / channel_post / my_chat_member / guest_message', () => {
    const msg = { message_id: 1, date: 1, from: ana, chat: privateChat, text: 'x' }
    expect(parseUpdate({ update_id: 112, business_message: { ...msg, business_connection_id: 'bc' } })).toBeUndefined()
    expect(parseUpdate({ update_id: 113, edited_channel_post: msg })).toBeUndefined()
    expect(parseUpdate({ update_id: 114, my_chat_member: { chat: privateChat, from: ana, date: 1 } })).toBeUndefined()
    expect(parseUpdate({ update_id: 115, guest_message: msg })).toBeUndefined()
  })
})
