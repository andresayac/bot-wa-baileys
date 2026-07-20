import { describe, it, expect } from 'vitest'
import { parseInbound, type GraphWebhookBody } from '../src/parseInbound.js'

const wrap = (value: unknown): GraphWebhookBody => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'pnid', changes: [{ field: 'messages', value: value as never }] }],
})

describe('parseInbound', () => {
  it('parses a text message with profile name', () => {
    const events = parseInbound(wrap({
      contacts: [{ profile: { name: 'Andres' }, wa_id: '573001234567' }],
      messages: [{ from: '573001234567', id: 'wamid.1', timestamp: '1669233778', type: 'text', text: { body: 'hola' } }],
    }))
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe('message')
    if (e.kind === 'message') {
      expect(e.message.chatId).toBe('573001234567')
      expect(e.message.senderInfo.displayName).toBe('Andres')
      expect(e.message.type).toBe('text')
      expect(e.message.body).toBe('hola')
      expect(e.message.timestamp).toBe(1669233778)
    }
  })

  it('parses an image message into a MediaRef (token = media id)', () => {
    const events = parseInbound(wrap({
      messages: [{ from: '573001', id: 'wamid.2', timestamp: '1', type: 'image', image: { id: 'MEDIA_ID', mime_type: 'image/jpeg', caption: 'mira' } }],
    }))
    const e = events[0]
    if (e.kind === 'message') {
      expect(e.message.type).toBe('image')
      expect(e.message.body).toBe('mira')
      expect(e.message.media?.token).toBe('MEDIA_ID')
      expect(e.message.media?.mimetype).toBe('image/jpeg')
    }
  })

  it('parses a voice audio as type voice', () => {
    const events = parseInbound(wrap({
      messages: [{ from: 'x', id: 'wamid.3', timestamp: '1', type: 'audio', audio: { id: 'A', voice: true } }],
    }))
    const e = events[0]
    if (e.kind === 'message') expect(e.message.type).toBe('voice')
  })

  it('maps a button reply to an interaction event', () => {
    const events = parseInbound(wrap({
      messages: [{ from: '573001', id: 'wamid.4', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'btn_yes', title: 'Sí' } } }],
    }))
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe('interaction')
    if (e.kind === 'interaction') {
      expect(e.interaction.kind).toBe('button')
      expect(e.interaction.data).toBe('btn_yes')
      expect(e.interaction.chatId).toBe('573001')
    }
  })

  it('maps a list reply to a list interaction', () => {
    const events = parseInbound(wrap({
      messages: [{ from: 'x', id: 'wamid.5', timestamp: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'row_2', title: 'Opción 2' } } }],
    }))
    const e = events[0]
    if (e.kind === 'interaction') expect(e.interaction.kind).toBe('list')
  })

  it('maps statuses to DeliveryStatus events', () => {
    const events = parseInbound(wrap({
      statuses: [{ id: 'wamid.1', recipient_id: '573001', status: 'read', timestamp: '2' }],
    }))
    const e = events[0]
    expect(e.kind).toBe('status')
    if (e.kind === 'status') {
      expect(e.status.status).toBe('read')
      expect(e.status.recipient).toBe('573001')
    }
  })

  it('maps a reaction message to a reaction event', () => {
    const events = parseInbound(wrap({
      messages: [{ from: '573001', id: 'wamid.6', timestamp: '1', type: 'reaction', reaction: { message_id: 'wamid.1', emoji: '👍' } }],
    }))
    const e = events[0]
    expect(e.kind).toBe('reaction')
    if (e.kind === 'reaction') {
      expect(e.reaction.emoji).toBe('👍')
      expect(e.reaction.ref.id).toBe('wamid.1')
    }
  })

  it('ignores non-whatsapp_business_account payloads', () => {
    expect(parseInbound({ object: 'page', entry: [] })).toEqual([])
  })
})
