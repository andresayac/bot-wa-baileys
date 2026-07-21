import { describe, it, expect } from 'vitest'
import { parseInbound, type PageWebhookBody } from '../src/parseInbound.js'

function page(...messaging: unknown[]): PageWebhookBody {
  return { object: 'page', entry: [{ id: 'PG', time: 1, messaging: messaging as never }] }
}

describe('parseInbound', () => {
  it('ignores non-page webhook objects', () => {
    expect(parseInbound({ object: 'instagram', entry: [] })).toEqual([])
    expect(parseInbound({})).toEqual([])
  })

  it('parses a text messaging event into a dm message', () => {
    const [ev] = parseInbound(page({
      sender: { id: 'USER1' }, recipient: { id: 'PG' }, timestamp: 1720000000000,
      message: { mid: 'm_mid.1', text: 'hola bot' },
    }))
    expect(ev.kind).toBe('message')
    if (ev.kind !== 'message') return
    const m = ev.message
    expect(m.chatId).toBe('USER1')
    expect(m.senderId).toBe('USER1')
    expect(m.from).toBe('USER1')
    expect(m.chat.kind).toBe('dm')
    expect(m.isGroup).toBe(false)
    expect(m.type).toBe('text')
    expect(m.body).toBe('hola bot')
    expect(m.ref.id).toBe('m_mid.1')
    expect(m.timestamp).toBe(1720000000000)
    expect(m.media).toBeUndefined()
  })

  it('marks fromMe when the sender matches selfId', () => {
    const [ev] = parseInbound(
      page({ sender: { id: 'BOT' }, recipient: { id: 'PG' }, timestamp: 1, message: { mid: 'x', text: 'echo', is_echo: true } }),
      'BOT',
    )
    expect(ev.kind === 'message' && ev.message.fromMe).toBe(true)
  })

  it('parses an image attachment into a media message', () => {
    const [ev] = parseInbound(page({
      sender: { id: 'USER1' }, recipient: { id: 'PG' }, timestamp: 5,
      message: { mid: 'm_mid.2', attachments: [{ type: 'image', payload: { url: 'https://cdn.fbsbx.com/img.jpg' } }] },
    }))
    expect(ev.kind).toBe('message')
    if (ev.kind !== 'message') return
    expect(ev.message.type).toBe('image')
    expect(ev.message.media?.kind).toBe('image')
    expect(ev.message.media?.mimetype).toBe('image/jpeg')
    expect(ev.message.media?.token).toBe('https://cdn.fbsbx.com/img.jpg')
    expect(ev.message.body).toBe('')
  })

  it('maps file attachments to document and audio to audio', () => {
    const [doc, aud] = parseInbound(page(
      { sender: { id: 'U' }, recipient: { id: 'PG' }, timestamp: 1, message: { mid: 'a', attachments: [{ type: 'file', payload: { url: 'https://x/f.pdf' } }] } },
      { sender: { id: 'U' }, recipient: { id: 'PG' }, timestamp: 2, message: { mid: 'b', attachments: [{ type: 'audio', payload: { url: 'https://x/a.mp3' } }] } },
    ))
    expect(doc.kind === 'message' && doc.message.type).toBe('document')
    expect(aud.kind === 'message' && aud.message.type).toBe('audio')
    expect(aud.kind === 'message' && aud.message.media?.mimetype).toBe('audio/aac')
  })

  it('parses a postback into a button interaction', () => {
    const [ev] = parseInbound(page({
      sender: { id: 'USER1' }, recipient: { id: 'PG' }, timestamp: 9,
      postback: { mid: 'pb_mid', title: 'Start', payload: 'GET_STARTED' },
    }))
    expect(ev.kind).toBe('interaction')
    if (ev.kind !== 'interaction') return
    expect(ev.interaction.kind).toBe('button')
    expect(ev.interaction.data).toBe('GET_STARTED')
    expect(ev.interaction.interactionId).toBe('pb_mid')
    expect(ev.interaction.chatId).toBe('USER1')
    expect(ev.interaction.respondBy).toBeUndefined()
  })

  it('parses a quick_reply into a button interaction', () => {
    const [ev] = parseInbound(page({
      sender: { id: 'USER1' }, recipient: { id: 'PG' }, timestamp: 3,
      message: { mid: 'qr_mid', text: 'Yes', quick_reply: { payload: 'ANSWER_YES' } },
    }))
    expect(ev.kind).toBe('interaction')
    if (ev.kind !== 'interaction') return
    expect(ev.interaction.data).toBe('ANSWER_YES')
    expect(ev.interaction.interactionId).toBe('qr_mid')
  })

  it('parses a reaction into a reaction event', () => {
    const [ev] = parseInbound(page({
      sender: { id: 'USER1' }, recipient: { id: 'PG' }, timestamp: 4,
      message: { mid: 'r_mid', reaction: { reaction: 'love', emoji: '😍', action: 'react', mid: 'target_mid' } },
    }))
    expect(ev.kind).toBe('reaction')
    if (ev.kind !== 'reaction') return
    expect(ev.reaction.ref.id).toBe('target_mid')
    expect(ev.reaction.ref.chatId).toBe('USER1')
    expect(ev.reaction.emoji).toBe('love')
    expect(ev.reaction.senderId).toBe('USER1')
    expect(ev.reaction.removed).toBe(false)
  })

  it('flags removed reactions', () => {
    const [ev] = parseInbound(page({
      sender: { id: 'USER1' }, recipient: { id: 'PG' }, timestamp: 4,
      message: { mid: 'r_mid', reaction: { reaction: '', emoji: '', action: 'remove', mid: 'target_mid' } },
    }))
    expect(ev.kind === 'reaction' && ev.reaction.removed).toBe(true)
  })

  it('parses opt_in and referral into interactions', () => {
    const [optin, referral] = parseInbound(page(
      { sender: { id: 'U' }, recipient: { id: 'PG' }, timestamp: 1, optin: { ref: 'checkbox', payload: 'OPTIN' } },
      { sender: { id: 'U' }, recipient: { id: 'PG' }, timestamp: 2, referral: { ref: 'ADS', source: 'ADS', type: 'OPEN_THREAD' } },
    ))
    expect(optin.kind === 'interaction' && optin.interaction.data).toBe('OPTIN')
    expect(referral.kind === 'interaction' && referral.interaction.data).toBe('ADS')
  })

  it('flattens multiple entries/messaging events', () => {
    const body: PageWebhookBody = {
      object: 'page',
      entry: [
        { messaging: [{ sender: { id: 'A' }, recipient: { id: 'PG' }, timestamp: 1, message: { mid: '1', text: 'one' } }] },
        { messaging: [{ sender: { id: 'B' }, recipient: { id: 'PG' }, timestamp: 2, message: { mid: '2', text: 'two' } }] },
      ],
    }
    const events = parseInbound(body)
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.kind === 'message')).toBe(true)
  })

  it('skips events without a sender id', () => {
    expect(parseInbound(page({ recipient: { id: 'PG' }, timestamp: 1, message: { mid: 'x', text: 'orphan' } }))).toEqual([])
  })
})
