import { describe, it, expect } from 'vitest'
import { parseInbound, type IgMessagingEvent, type IgWebhookBody } from '../src/parseInbound.js'

const wrap = (...messaging: IgMessagingEvent[]): IgWebhookBody => ({
  object: 'page',
  entry: [{ id: 'page-id', time: 1, messaging }],
})

describe('parseInbound (Instagram)', () => {
  it('parses a text message', () => {
    const events = parseInbound(wrap({
      sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp: 1669233778000,
      message: { mid: 'mid.1', text: 'hola' },
    }))
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe('message')
    if (e.kind === 'message') {
      expect(e.message.chatId).toBe('IGSID_1')
      expect(e.message.senderId).toBe('IGSID_1')
      expect(e.message.type).toBe('text')
      expect(e.message.body).toBe('hola')
      expect(e.message.ref.id).toBe('mid.1')
      expect(e.message.timestamp).toBe(1669233778000) // epoch ms, passthrough
      expect(e.message.chat.kind).toBe('dm')
      expect(e.message.isGroup).toBe(false)
    }
  })

  it('parses an image attachment into a MediaRef (token = hosted url)', () => {
    const events = parseInbound(wrap({
      sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp: 1,
      message: { mid: 'mid.2', attachments: [{ type: 'image', payload: { url: 'https://cdn.cdninstagram.com/v/t51/x.jpg' } }] },
    }))
    const e = events[0]
    if (e.kind === 'message') {
      expect(e.message.type).toBe('image')
      expect(e.message.media?.kind).toBe('image')
      expect(e.message.media?.token).toBe('https://cdn.cdninstagram.com/v/t51/x.jpg')
    }
  })

  it('maps a share attachment (shared IG post) to type unknown with the url as body', () => {
    const events = parseInbound(wrap({
      sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp: 1,
      message: { mid: 'mid.3', attachments: [{ type: 'share', payload: { url: 'https://www.instagram.com/p/abc123/', title: 'Post' } }] },
    }))
    const e = events[0]
    if (e.kind === 'message') {
      expect(e.message.type).toBe('unknown')
      expect(e.message.body).toBe('https://www.instagram.com/p/abc123/')
      expect(e.message.media).toBeUndefined()
    }
  })

  it('maps a quick_reply tap to a button interaction (data = payload)', () => {
    const events = parseInbound(wrap({
      sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp: 1,
      message: { mid: 'mid.4', text: 'Sí', quick_reply: { payload: 'btn_yes' } },
    }))
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe('interaction')
    if (e.kind === 'interaction') {
      expect(e.interaction.kind).toBe('button')
      expect(e.interaction.data).toBe('btn_yes')
      expect(e.interaction.interactionId).toBe('mid.4')
      expect(e.interaction.chatId).toBe('IGSID_1')
    }
  })

  it('maps a reaction to a reaction event (emoji + react/unreact)', () => {
    const events = parseInbound(wrap({
      sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp: 1,
      reaction: { mid: 'mid.TARGET', action: 'react', reaction: '😀', emoji: '😀' },
    }))
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe('reaction')
    if (e.kind === 'reaction') {
      expect(e.reaction.emoji).toBe('😀')
      expect(e.reaction.ref.id).toBe('mid.TARGET')
      expect(e.reaction.senderId).toBe('IGSID_1')
      expect(e.reaction.removed).toBe(false)
    }
  })

  it('marks a removed reaction (action unreact)', () => {
    const events = parseInbound(wrap({
      sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp: 1,
      reaction: { mid: 'mid.TARGET', action: 'unreact', reaction: '' },
    }))
    const e = events[0]
    if (e.kind === 'reaction') {
      expect(e.reaction.removed).toBe(true)
      expect(e.reaction.emoji).toBe('')
    }
  })

  it('skips is_echo messages (our own outbound echoes)', () => {
    const events = parseInbound(wrap({
      sender: { id: 'PAGE' }, recipient: { id: 'IGSID_1' }, timestamp: 1,
      message: { mid: 'mid.echo', text: 'mi propio mensaje', is_echo: true },
    }))
    expect(events).toEqual([])
  })

  it('maps a postback (get-started / persistent menu) to an interaction', () => {
    const events = parseInbound(wrap({
      sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp: 1,
      postback: { payload: 'GET_STARTED', title: 'Empezar' },
    }))
    const e = events[0]
    if (e.kind === 'interaction') {
      expect(e.interaction.kind).toBe('button')
      expect(e.interaction.data).toBe('GET_STARTED')
    }
  })

  it('parses a story mention attachment as image media', () => {
    const events = parseInbound(wrap({
      sender: { id: 'IGSID_1' }, recipient: { id: 'PAGE' }, timestamp: 1,
      message: { mid: 'mid.5', text: 'mira mi historia', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.cdninstagram.com/story.jpg' } }] },
    }))
    const e = events[0]
    if (e.kind === 'message') {
      expect(e.message.type).toBe('image')
      expect(e.message.body).toBe('mira mi historia')
      expect(e.message.media?.token).toBe('https://cdn.cdninstagram.com/story.jpg')
    }
  })

  it('ignores non-page payloads and empty messaging', () => {
    expect(parseInbound({ object: 'user', entry: [] })).toEqual([])
    expect(parseInbound(wrap({ sender: { id: 'x' }, recipient: { id: 'y' }, timestamp: 1 }))).toEqual([])
  })
})
