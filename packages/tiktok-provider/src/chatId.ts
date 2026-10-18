/**
 * TikTok chat ids. The core treats them as opaque strings; only this provider
 * builds and reads them, to route `send()` to the right TikTok endpoint:
 *
 *  - `dm:<conversation_id>`            → Business Messaging conversation
 *  - `comment:<video_id>:<comment_id>` → reply thread of a top-level comment
 *  - `hic:<comment_id>`                → Comment-to-Message direct reply to a
 *                                        high-intent comment
 *
 * An unprefixed id is accepted as a raw `conversation_id` (e.g. one taken from
 * `/business/message/conversation/list/`).
 */

export type TikTokChatTarget =
  | { surface: 'dm'; conversationId: string }
  | { surface: 'comment'; videoId: string; commentId: string }
  | { surface: 'high-intent-comment'; commentId: string }

export const conversationChatId = (conversationId: string): string => `dm:${conversationId}`
export const commentChatId = (videoId: string, commentId: string): string => `comment:${videoId}:${commentId}`
export const highIntentChatId = (commentId: string): string => `hic:${commentId}`

/** Decode a chat id this provider produced. `undefined` when it is malformed. */
export function parseTikTokChatId(chatId: string): TikTokChatTarget | undefined {
  if (!chatId) return undefined
  if (chatId.startsWith('dm:')) {
    const conversationId = chatId.slice(3)
    return conversationId ? { surface: 'dm', conversationId } : undefined
  }
  if (chatId.startsWith('comment:')) {
    const [videoId, commentId, ...rest] = chatId.slice(8).split(':')
    return videoId && commentId && rest.length === 0 ? { surface: 'comment', videoId, commentId } : undefined
  }
  if (chatId.startsWith('hic:')) {
    const commentId = chatId.slice(4)
    return commentId ? { surface: 'high-intent-comment', commentId } : undefined
  }
  return { surface: 'dm', conversationId: chatId }
}
