import { describe, it, expect } from 'vitest'
import { commentChatId, conversationChatId, highIntentChatId, parseTikTokChatId } from '../src/chatId.js'

describe('TikTok chat ids', () => {
  it('round-trips a DM conversation', () => {
    expect(conversationChatId('conv:1')).toBe('dm:conv:1')
    expect(parseTikTokChatId('dm:conv:1')).toEqual({ surface: 'dm', conversationId: 'conv:1' })
  })
  it('round-trips a comment thread', () => {
    expect(commentChatId('111', '222')).toBe('comment:111:222')
    expect(parseTikTokChatId('comment:111:222')).toEqual({ surface: 'comment', videoId: '111', commentId: '222' })
  })
  it('round-trips a high-intent comment', () => {
    expect(highIntentChatId('333')).toBe('hic:333')
    expect(parseTikTokChatId('hic:333')).toEqual({ surface: 'high-intent-comment', commentId: '333' })
  })
  it('treats an unprefixed id as a raw conversation_id', () => {
    expect(parseTikTokChatId('abc')).toEqual({ surface: 'dm', conversationId: 'abc' })
  })
  it('returns undefined for malformed prefixed ids', () => {
    expect(parseTikTokChatId('comment:111')).toBeUndefined()
    expect(parseTikTokChatId('dm:')).toBeUndefined()
    expect(parseTikTokChatId('hic:')).toBeUndefined()
    expect(parseTikTokChatId('')).toBeUndefined()
  })
})
