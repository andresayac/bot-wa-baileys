/**
 * Webhook fixtures modelled on the samples published in the TikTok API for
 * Business docs (v1.3): "Comment update event" and "Subscribe to Business
 * Messaging Webhook events via Webhooks API › Webhook schema". `content` is a
 * serialized JSON STRING, exactly as TikTok delivers it.
 */

export const BUSINESS_ID = '_000abPL1cJIdVefgDhGijkl2mFn3AB0abY4'
export const USER_UID = '+ABc1D2/E0fGhijklMNOrD34vDW/zDiZUNRH5Jyahue6OcA7b8ZpwnqXV9u1Uh+k'
export const CONVERSATION_ID = 'conv-1234567890'
/** `unique_identifier` of the business's own TikTok account. */
export const SELF_UID = '+SELFbusinessUniqueIdentifier0000000000000000000000000000000000'

/** Builds a webhook envelope with its `content` serialized the way TikTok does. */
export function envelope(event: string, content: Record<string, unknown> | string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_key: 'bwo1m23456a7k89',
    event,
    create_time: 1701090882,
    user_openid: BUSINESS_ID,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    ...overrides,
  }
}

/**
 * comment.update — verbatim shape of the docs sample (numeric 64-bit ids that
 * exceed Number.MAX_SAFE_INTEGER; a plain JSON.parse would corrupt them).
 */
export const commentInsertRaw = JSON.stringify({
  client_key: 'bwo1m23456a7k89',
  event: 'comment.update',
  create_time: 1615338610,
  user_openid: BUSINESS_ID,
  content:
    `{"comment_id":7247303576418566913,"video_id":7203946942097902849,"comment_type":"comment",` +
    `"comment_action":"insert","unique_identifier":"${USER_UID}","timestamp":1687394416109,"text":"precio?"}`,
})

export const commentReplyInsertRaw = JSON.stringify({
  client_key: 'bwo1m23456a7k89',
  event: 'comment.update',
  create_time: 1615338610,
  user_openid: BUSINESS_ID,
  content:
    `{"comment_id":7247303576418566999,"video_id":7203946942097902849,"parent_comment_id":7235861947622916866,` +
    `"comment_type":"reply","comment_action":"insert","unique_identifier":"${USER_UID}","timestamp":1687394416200,"text":"yo también"}`,
})

/** comment.update for a reply posted by the business itself (e.g. by another bot instance). */
export const commentSelfReplyRaw = JSON.stringify({
  client_key: 'bwo1m23456a7k89',
  event: 'comment.update',
  create_time: 1615338610,
  user_openid: BUSINESS_ID,
  content:
    `{"comment_id":7247303576418567000,"video_id":7203946942097902849,"parent_comment_id":7247303576418566913,` +
    `"comment_type":"reply","comment_action":"insert","unique_identifier":"${SELF_UID}","timestamp":1687394416300,"text":"Te escribimos por DM"}`,
})

export const commentDeleteRaw = JSON.stringify({
  client_key: 'bwo1m23456a7k89',
  event: 'comment.update',
  create_time: 1615338610,
  user_openid: BUSINESS_ID,
  content:
    `{"comment_id":7247303576418566913,"video_id":7203946942097902849,"parent_comment_id":7235861947622916866,` +
    `"comment_type":"reply","comment_action":"delete","unique_identifier":"${USER_UID}","timestamp":1687394416109,"text":"text"}`,
})

const participants = {
  from: 'vappe256',
  to: 'mybusiness',
  unique_identifier: USER_UID,
  from_user: { id: USER_UID, role: 'personal_account' },
  to_user: { id: BUSINESS_ID, role: 'business_account' },
  conversation_id: CONVERSATION_ID,
  scene_type: 0,
  is_follower: true,
  message_tag: { source: 'APP' },
}

export const dmText = envelope('im_receive_msg', {
  ...participants,
  message_id: 'msg-1',
  timestamp: 1701090879815,
  type: 'text',
  text: { body: 'Hola!' },
})

export const dmQuotedText = envelope('im_receive_msg', {
  ...participants,
  message_id: 'msg-2',
  timestamp: 1701090879900,
  type: 'text',
  text: { body: 'respondo a esto' },
  referenced_message_info: { referenced_message_id: 'msg-0' },
})

export const dmImage = envelope('im_receive_msg', {
  ...participants,
  message_id: 'msg-3',
  timestamp: 1701090879815,
  type: 'image',
  image: { media_id: 'media-abc=' },
})

export const dmVideo = envelope('im_receive_msg', {
  ...participants,
  message_id: 'msg-4',
  timestamp: 1701090879815,
  type: 'video',
  video: { media_id: 'media-vid' },
})

export const dmSticker = envelope('im_receive_msg', {
  ...participants,
  message_id: 'msg-5',
  timestamp: 1701090879815,
  type: 'sticker',
  sticker: { url: 'https://p16-sign.tiktokcdn.com/sticker.webp?x-expires=1' },
})

export const dmSharePost = envelope('im_receive_msg', {
  ...participants,
  message_id: 'msg-6',
  timestamp: 1701090879815,
  type: 'share_post',
  share_post: { video_id: '7203946942097902849', embed_url: 'https://www.tiktok.com/embed/7203946942097902849' },
})

export const dmCardClick = envelope('im_receive_msg', {
  ...participants,
  message_id: 'msg-7',
  timestamp: 1701090879815,
  type: 'text',
  text: { body: 'Ver precios' },
  reply_source_payload: { reply_source_msg_id: 'card-msg-1', reply_source_unique_id: 'btn-prices' },
})

export const dmReaction = envelope('im_receive_msg', {
  ...participants,
  message_id: 'msg-8',
  timestamp: 1701090879815,
  type: 'reaction',
  reaction: [
    { operation: 'ADD', type: 'EMOJI', emoji: '❤️', unique_identifier: USER_UID, timestamp: 1719447205701, original_msg_id: 'msg-sent-1' },
    { operation: 'REMOVE', type: 'EMOJI', emoji: '👍', unique_identifier: USER_UID, timestamp: 1719447205702, original_msg_id: 'msg-sent-2' },
  ],
})

export const dmSentEcho = envelope('im_send_msg', {
  ...participants,
  from: 'mybusiness',
  to: 'vappe256',
  from_user: { id: BUSINESS_ID, role: 'business_account' },
  to_user: { id: USER_UID, role: 'personal_account' },
  message_id: 'msg-sent-9',
  timestamp: 1701090879999,
  type: 'text',
  text: { body: 'respuesta' },
  message_tag: { source: 'API' },
})

/** EEA/CH/UK users: TikTok withholds the content entirely. */
export const dmEu = envelope('im_receive_msg_eu', {
  to: 'mybusiness',
  to_user: { id: BUSINESS_ID, role: 'business_account' },
  timestamp: 1701090879815,
})

export const highIntentComment = envelope('im_receive_high_intent_comment', {
  from: 'vappe256',
  to: 'mybusiness',
  unique_identifier: USER_UID,
  from_user: { id: USER_UID, role: 'personal_account' },
  to_user: { id: BUSINESS_ID, role: 'business_account' },
  comment_id: '7247303576418566777',
  comment_text: 'quiero comprar',
  is_follower: false,
  timestamp: 1701090879815,
})
