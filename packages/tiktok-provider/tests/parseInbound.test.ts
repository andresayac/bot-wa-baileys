import { describe, it, expect } from 'vitest'
import type { InboundEvent, InboundMessage } from '@botmesh/core'
import { parseWebhook } from '../src/parseInbound.js'
import { parseJsonLossless } from '../src/json.js'
import type { TikTokWebhookBody } from '../src/types.js'
import * as fx from './fixtures/webhooks.js'

const parse = (body: unknown) => parseWebhook((typeof body === 'string' ? parseJsonLossless(body) : body) as TikTokWebhookBody)
const onlyMessage = (events: InboundEvent[]): InboundMessage => {
  expect(events).toHaveLength(1)
  const e = events[0]!
  if (e.kind !== 'message') throw new Error(`expected message, got ${e.kind}`)
  return e.message
}

describe('parseWebhook — comment.update', () => {
  it('maps an inserted top-level comment to a group-like comment-thread message', () => {
    const m = onlyMessage(parse(fx.commentInsertRaw))
    expect(m.chatId).toBe('comment:7203946942097902849:7247303576418566913')
    expect(m.ref).toMatchObject({ id: '7247303576418566913', chatId: m.chatId })
    expect(m.senderId).toBe(fx.USER_UID)
    expect(m.sender).toBe(fx.USER_UID)
    expect(m.from).toBe(m.chatId)
    expect(m.isGroup).toBe(true)
    expect(m.chat).toMatchObject({ kind: 'group', isGroup: true, isBroadcast: false })
    expect(m.chat.platformData).toMatchObject({ surface: 'comment', videoId: '7203946942097902849', commentId: '7247303576418566913' })
    expect(m.type).toBe('text')
    expect(m.body).toBe('precio?')
    expect(m.timestamp).toBe(1687394416109)
    expect(m.fromMe).toBe(false)
  })

  it('keys a reply to its thread root (parent_comment_id) so replies land in the same chat', () => {
    const m = onlyMessage(parse(fx.commentReplyInsertRaw))
    expect(m.chatId).toBe('comment:7203946942097902849:7235861947622916866')
    expect(m.ref.id).toBe('7247303576418566999')
    expect(m.chat.platformData).toMatchObject({ commentType: 'reply', parentCommentId: '7235861947622916866' })
  })

  it('ignores non-insert comment actions (delete/hide/visibility changes)', () => {
    expect(parse(fx.commentDeleteRaw)).toEqual([])
  })

  it('flags the business own comments as fromMe when selfUniqueIdentifier is known', () => {
    const events = parseWebhook(parseJsonLossless(fx.commentInsertRaw) as TikTokWebhookBody, { selfUniqueIdentifier: fx.USER_UID })
    expect(onlyMessage(events).fromMe).toBe(true)
  })
})

describe('parseWebhook — Business Messaging', () => {
  it('maps im_receive_msg text to a DM message keyed by conversation_id', () => {
    const m = onlyMessage(parse(fx.dmText))
    expect(m.chatId).toBe(`dm:${fx.CONVERSATION_ID}`)
    expect(m.ref.id).toBe('msg-1')
    expect(m.senderId).toBe(fx.USER_UID)
    expect(m.senderInfo).toMatchObject({ id: fx.USER_UID, username: 'vappe256' })
    expect(m.senderInfo.platformData).toMatchObject({ isFollower: true })
    expect(m.isGroup).toBe(false)
    expect(m.chat.kind).toBe('dm')
    expect(m.type).toBe('text')
    expect(m.body).toBe('Hola!')
    expect(m.timestamp).toBe(1701090879815)
  })

  it('uses the same senderId for a person across comments and DMs (unique_identifier)', () => {
    expect(onlyMessage(parse(fx.dmText)).senderId).toBe(onlyMessage(parse(fx.commentInsertRaw)).senderId)
  })

  it('surfaces a quoted reply', () => {
    const m = onlyMessage(parse(fx.dmQuotedText))
    expect(m.quoted?.ref).toEqual({ id: 'msg-0', chatId: `dm:${fx.CONVERSATION_ID}` })
  })

  it('maps image and video messages to lazy media refs', () => {
    const img = onlyMessage(parse(fx.dmImage))
    expect(img.type).toBe('image')
    expect(img.media).toMatchObject({ kind: 'image', token: { mediaId: 'media-abc=', messageId: 'msg-3', conversationId: fx.CONVERSATION_ID, mediaType: 'IMAGE' } })
    const vid = onlyMessage(parse(fx.dmVideo))
    expect(vid.type).toBe('video')
    expect(vid.media).toMatchObject({ kind: 'video', token: { mediaId: 'media-vid', mediaType: 'VIDEO' } })
  })

  it('maps stickers to a URL media ref', () => {
    const m = onlyMessage(parse(fx.dmSticker))
    expect(m.type).toBe('sticker')
    expect(m.media).toMatchObject({ kind: 'sticker', token: { url: 'https://p16-sign.tiktokcdn.com/sticker.webp?x-expires=1' } })
  })

  it('maps a shared post to an unknown message whose body is the embed url', () => {
    const m = onlyMessage(parse(fx.dmSharePost))
    expect(m.type).toBe('unknown')
    expect(m.body).toBe('https://www.tiktok.com/embed/7203946942097902849')
  })

  it('maps a Q&A card click to a button interaction carrying the button id', () => {
    const events = parse(fx.dmCardClick)
    expect(events).toHaveLength(1)
    const e = events[0]!
    if (e.kind !== 'interaction') throw new Error('expected interaction')
    expect(e.interaction).toMatchObject({
      interactionId: 'msg-7',
      kind: 'button',
      data: 'btn-prices',
      chatId: `dm:${fx.CONVERSATION_ID}`,
      senderId: fx.USER_UID,
    })
  })

  it('maps reactions to reaction events (ADD / REMOVE)', () => {
    const events = parse(fx.dmReaction)
    expect(events).toEqual([
      { kind: 'reaction', reaction: { ref: { id: 'msg-sent-1', chatId: `dm:${fx.CONVERSATION_ID}` }, emoji: '❤️', senderId: fx.USER_UID } },
      { kind: 'reaction', reaction: { ref: { id: 'msg-sent-2', chatId: `dm:${fx.CONVERSATION_ID}` }, emoji: '👍', senderId: fx.USER_UID, removed: true } },
    ])
  })

  it('maps im_send_msg (our own outbound) to a sent status, not a message', () => {
    expect(parse(fx.dmSentEcho)).toEqual([
      { kind: 'status', status: { ref: { id: 'msg-sent-9', chatId: `dm:${fx.CONVERSATION_ID}` }, status: 'sent', recipient: fx.USER_UID, timestamp: 1701090879999 } },
    ])
  })

  it('drops im_receive_msg_eu (TikTok withholds EEA/CH/UK content)', () => {
    expect(parse(fx.dmEu)).toEqual([])
  })

  it('maps a high-intent comment to its own chat for a Comment-to-Message direct reply', () => {
    const m = onlyMessage(parse(fx.highIntentComment))
    expect(m.chatId).toBe('hic:7247303576418566777')
    expect(m.ref.id).toBe('7247303576418566777')
    expect(m.body).toBe('quiero comprar')
    expect(m.senderId).toBe(fx.USER_UID)
    expect(m.isGroup).toBe(false)
  })

  it('ignores unknown and malformed events', () => {
    expect(parse(fx.envelope('im_auto_message_audit_update', { audit_status: 'APPROVED' }))).toEqual([])
    expect(parse(fx.envelope('im_receive_msg', 'not json'))).toEqual([])
    expect(parse(fx.envelope('im_receive_msg', { type: 'text', text: { body: 'x' } }))).toEqual([])
    expect(parse({})).toEqual([])
  })
})
