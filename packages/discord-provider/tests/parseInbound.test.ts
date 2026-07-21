import { describe, it, expect } from 'vitest'
import type { InboundInteraction, InboundMessage } from '@bot-wa/core'
import { parseDispatch, snowflakeTimestamp } from '../src/parseInbound.js'

const msg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'M1',
  channel_id: 'C1',
  guild_id: 'G1',
  author: { id: 'U1', username: 'ana', global_name: 'Ana' },
  content: 'hola bot',
  timestamp: '2024-01-01T00:00:00.000Z',
  mentions: [],
  attachments: [],
  ...over,
})

const messageOf = (e: ReturnType<typeof parseDispatch>): InboundMessage => {
  expect(e?.kind).toBe('message')
  return (e as { kind: 'message'; message: InboundMessage }).message
}
const interactionOf = (e: ReturnType<typeof parseDispatch>): InboundInteraction => {
  expect(e?.kind).toBe('interaction')
  return (e as { kind: 'interaction'; interaction: InboundInteraction }).interaction
}

describe('parseDispatch', () => {
  it('MESSAGE_CREATE → normalized message in a guild', () => {
    const m = messageOf(parseDispatch('MESSAGE_CREATE', msg({ mentions: [{ id: 'BOT' }] }), null))
    expect(m.chatId).toBe('C1')
    expect(m.senderId).toBe('U1')
    expect(m.from).toBe('C1')
    expect(m.sender).toBe('U1')
    expect(m.chat.kind).toBe('group')
    expect(m.isGroup).toBe(true)
    expect(m.chat.platformData?.guildId).toBe('G1')
    expect(m.senderInfo.displayName).toBe('Ana')
    expect(m.type).toBe('text')
    expect(m.body).toBe('hola bot')
    expect(m.timestamp).toBe(Date.parse('2024-01-01T00:00:00.000Z'))
    expect(m.mentions).toEqual(['BOT'])
    expect(m.fromMe).toBe(false)
  })

  it('MESSAGE_CREATE without guild_id → dm', () => {
    const m = messageOf(parseDispatch('MESSAGE_CREATE', msg({ guild_id: undefined }), null))
    expect(m.chat.kind).toBe('dm')
    expect(m.isGroup).toBe(false)
  })

  it('flags fromMe when the author is selfId', () => {
    const m = messageOf(parseDispatch('MESSAGE_CREATE', msg(), 'U1'))
    expect(m.fromMe).toBe(true)
  })

  it('ignores bot authors (own and other bots)', () => {
    expect(parseDispatch('MESSAGE_CREATE', msg({ author: { id: 'B1', bot: true } }), null)).toBeUndefined()
  })

  it('maps the first attachment to a MediaRef (token = CDN url)', () => {
    const m = messageOf(parseDispatch('MESSAGE_CREATE', msg({
      content: 'mira',
      attachments: [{ id: 'A1', filename: 'p.png', content_type: 'image/png', size: 9, url: 'https://cdn.discord.com/p.png' }],
    }), null))
    expect(m.type).toBe('image')
    expect(m.body).toBe('mira')
    expect(m.media?.token).toBe('https://cdn.discord.com/p.png')
    expect(m.media?.mimetype).toBe('image/png')
    expect(m.media?.filename).toBe('p.png')
  })

  it('parses replies into quoted refs', () => {
    const m = messageOf(parseDispatch('MESSAGE_CREATE', msg({
      message_reference: { message_id: 'M0', channel_id: 'C1' },
      referenced_message: { id: 'M0', channel_id: 'C1', author: { id: 'U9' }, content: 'previo' },
    }), null))
    expect(m.quoted?.ref?.id).toBe('M0')
    expect(m.quoted?.body).toBe('previo')
    expect(m.quoted?.senderId).toBe('U9')
  })

  it('INTERACTION_CREATE button → interaction with "<id>:<token>" and respondBy', () => {
    const i = interactionOf(parseDispatch('INTERACTION_CREATE', {
      id: '175928847299117063',
      type: 3,
      token: 'ITOK',
      channel_id: 'C1',
      guild_id: 'G1',
      member: { user: { id: 'U1', username: 'ana' } },
      data: { custom_id: 'btn_yes', component_type: 2 },
      message: { id: 'M9' },
    }, null))
    expect(i.kind).toBe('button')
    expect(i.data).toBe('btn_yes')
    expect(i.interactionId).toBe('175928847299117063:ITOK')
    expect(i.ref.id).toBe('M9')
    expect(i.chatId).toBe('C1')
    expect(i.senderId).toBe('U1')
    expect(i.timestamp).toBe(1462015105796) // snowflake time
    expect(i.respondBy).toBe(i.timestamp + 3000)
  })

  it('INTERACTION_CREATE select menu → list interaction (DM user field)', () => {
    const i = interactionOf(parseDispatch('INTERACTION_CREATE', {
      id: '1',
      type: 3,
      token: 'T',
      channel_id: 'C2',
      user: { id: 'U2', username: 'dmuser' },
      data: { custom_id: 'menu_1', component_type: 3, values: ['r1'] },
    }, null))
    expect(i.kind).toBe('list')
    expect(i.data).toBe('menu_1')
    expect(i.chat.kind).toBe('dm')
    expect(i.senderId).toBe('U2')
  })

  it('INTERACTION_CREATE slash command → command interaction', () => {
    const i = interactionOf(parseDispatch('INTERACTION_CREATE', {
      id: '1',
      type: 2,
      token: 'T',
      channel_id: 'C1',
      guild_id: 'G1',
      member: { user: { id: 'U1' } },
      data: { name: 'ping', type: 1 },
    }, null))
    expect(i.kind).toBe('command')
    expect(i.data).toBe('ping')
  })

  it('ignores dispatch events we do not normalize', () => {
    expect(parseDispatch('TYPING_START', { channel_id: 'C1' }, null)).toBeUndefined()
    expect(parseDispatch('READY', { user: { id: 'B1' } }, null)).toBeUndefined()
  })

  it('extracts timestamps from snowflakes (Discord documented example)', () => {
    expect(snowflakeTimestamp('175928847299117063')).toBe(1462015105796)
  })
})
